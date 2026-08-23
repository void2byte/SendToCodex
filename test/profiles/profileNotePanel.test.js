'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createMockVscode, installMockVscode } = require('../helpers/mockVscode');

function loadPanel(initialNote) {
  let disposeHandler;
  let messageHandler;
  const postedMessages = [];
  const webview = {
    html: '',
    onDidReceiveMessage(callback) {
      messageHandler = callback;
      return { dispose() {} };
    },
    async postMessage(message) {
      postedMessages.push(message);
      return true;
    }
  };
  const panel = {
    webview,
    revealCalls: [],
    reveal(column) {
      this.revealCalls.push(column);
    },
    onDidDispose(callback) {
      disposeHandler = callback;
      return { dispose() {} };
    },
    dispose() {
      if (disposeHandler) {
        disposeHandler();
      }
    }
  };
  const mock = createMockVscode({
    overrides: {
      ViewColumn: {
        Beside: -2
      },
      workspace: {
        getConfiguration: () => ({
          get: (_key, fallback) => fallback
        })
      },
      window: {
        createWebviewPanel: () => panel
      }
    }
  });
  const restore = installMockVscode(mock.vscode);
  try {
    delete require.cache[require.resolve('../../src/profiles/profileNotePanel')];
    const { ProfileNotePanel } = require('../../src/profiles/profileNotePanel');
    return {
      ProfileNotePanel,
      dispose: () => disposeHandler && disposeHandler(),
      getMessageHandler: () => messageHandler,
      initialNote,
      panel,
      postedMessages
    };
  } finally {
    restore();
  }
}

test('private note editor escapes note text and saves through the profile manager', async () => {
  const initialNote = 'secret </textarea><script>bad()</script> & text';
  const fixture = loadPanel(initialNote);
  const writes = [];
  const manager = {
    readProfilePrivateNote: async () => initialNote,
    writeProfilePrivateNote: async (profileId, value) => {
      writes.push({ profileId, value });
    }
  };
  const profile = {
    id: 'profile-a',
    name: 'Account A',
    email: 'account-a@example.com'
  };

  const instance = await fixture.ProfileNotePanel.createOrShow(manager, profile);

  assert.match(fixture.panel.webview.html, /Stored with VS Code SecretStorage/);
  assert.match(
    fixture.panel.webview.html,
    /secret &lt;\/textarea&gt;&lt;script&gt;bad\(\)&lt;\/script&gt; &amp; text/
  );
  assert.doesNotMatch(fixture.panel.webview.html, /<script>bad\(\)<\/script>/);
  const scriptMatch = fixture.panel.webview.html.match(
    /<script nonce="[^"]+">([\s\S]*)<\/script>/
  );
  assert.ok(scriptMatch);
  assert.doesNotThrow(() => new Function(scriptMatch[1]));
  assert.match(fixture.panel.webview.html, /2FA \/ TOTP/);
  assert.match(fixture.panel.webview.html, /requestDetectedTotp/);

  await instance.handleMessage({
    command: 'save',
    revision: 3,
    value: 'updated private note'
  });

  assert.deepEqual(writes, [
    {
      profileId: 'profile-a',
      value: 'updated private note'
    }
  ]);
  assert.deepEqual(fixture.postedMessages, [
    {
      command: 'saved',
      revision: 3
    }
  ]);
  assert.equal(typeof fixture.getMessageHandler(), 'function');
  fixture.dispose();
});

test('opening the same profile note reuses its existing editor', async () => {
  const fixture = loadPanel('');
  const manager = {
    readProfilePrivateNote: async () => '',
    writeProfilePrivateNote: async () => {}
  };
  const profile = { id: 'profile-b', name: 'Account B' };

  const first = await fixture.ProfileNotePanel.createOrShow(manager, profile);
  const second = await fixture.ProfileNotePanel.createOrShow(manager, profile);

  assert.equal(second, first);
  assert.deepEqual(fixture.panel.revealCalls, [-2]);
  fixture.dispose();
});

test('closing an account note disposes its editor and allows a clean reopen', async () => {
  const fixture = loadPanel('');
  let reads = 0;
  const manager = {
    readProfilePrivateNote: async () => {
      reads += 1;
      return '';
    },
    writeProfilePrivateNote: async () => {}
  };
  const profile = { id: 'profile-c', name: 'Account C' };

  await fixture.ProfileNotePanel.createOrShow(manager, profile);
  fixture.ProfileNotePanel.closeForProfile(profile.id);
  await fixture.ProfileNotePanel.createOrShow(manager, profile);

  assert.equal(reads, 2);
  fixture.dispose();
});
