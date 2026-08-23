'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

const { createMockVscode, installMockVscode } = require('../helpers/mockVscode');

function createStateBucket() {
  const values = new Map();
  return {
    values,
    get(key, fallback) {
      return values.has(key) ? values.get(key) : fallback;
    },
    async update(key, value) {
      if (value === undefined) {
        values.delete(key);
      } else {
        values.set(key, value);
      }
    }
  };
}

function createAuthData(id) {
  const idToken = [
    Buffer.from('{}').toString('base64url'),
    Buffer.from(JSON.stringify({
      email: `${id}@example.com`,
      sub: `user-${id}`,
      'https://api.openai.com/auth': {
        chatgpt_plan_type: 'plus',
        chatgpt_user_id: `chatgpt-${id}`
      }
    })).toString('base64url'),
    'signature'
  ].join('.');
  return {
    idToken,
    accessToken: `access-${id}`,
    refreshToken: `refresh-${id}`,
    accountId: `account-${id}`,
    chatgptUserId: `chatgpt-${id}`,
    subject: `user-${id}`,
    email: `${id}@example.com`,
    planType: 'plus',
    authJson: {
      tokens: {
        id_token: idToken,
        access_token: `access-${id}`,
        refresh_token: `refresh-${id}`,
        account_id: `account-${id}`
      }
    }
  };
}

function createManager(ProfileManager, storageDirectory, globalState, workspaceState, secrets) {
  return new ProfileManager(
    {
      globalStorageUri: { fsPath: storageDirectory },
      globalState,
      workspaceState,
      secrets: {
        get: async (key) => secrets.get(key),
        store: async (key, value) => secrets.set(key, value),
        delete: async (key) => secrets.delete(key)
      }
    },
    null
  );
}

test('workspace windows retain independent active accounts across restart and switch reload', async (t) => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-window-account-home-'));
  const storageDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'codex-window-account-storage-')
  );
  const previousCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = codexHome;
  t.after(() => {
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    fs.rmSync(codexHome, { recursive: true, force: true });
    fs.rmSync(storageDirectory, { recursive: true, force: true });
  });

  const mock = createMockVscode({
    overrides: {
      EventEmitter: class EventEmitter {
        constructor() {
          this.event = () => ({ dispose() {} });
        }
        fire() {}
        dispose() {}
      },
      env: { remoteName: undefined },
      workspace: {
        getConfiguration: () => ({ get: (_key, fallback) => fallback })
      }
    }
  });
  const restore = installMockVscode(mock.vscode);
  delete require.cache[require.resolve('../../src/profiles/authManager')];
  delete require.cache[require.resolve('../../src/profiles/profileManager')];
  const { ProfileManager } = require('../../src/profiles/profileManager');
  restore();

  const globalState = createStateBucket();
  const firstWorkspaceState = createStateBucket();
  const secondWorkspaceState = createStateBucket();
  const secrets = new Map();
  const firstWindow = createManager(
    ProfileManager,
    storageDirectory,
    globalState,
    firstWorkspaceState,
    secrets
  );
  const secondWindow = createManager(
    ProfileManager,
    storageDirectory,
    globalState,
    secondWorkspaceState,
    secrets
  );
  const firstProfile = await firstWindow.createProfile('First', createAuthData('first'));
  const secondProfile = await firstWindow.createProfile('Second', createAuthData('second'));

  assert.equal(await firstWindow.setActiveProfileId(firstProfile.id), true);
  assert.equal(await secondWindow.setActiveProfileId(secondProfile.id), true);
  assert.equal(await firstWindow.getActiveProfileId(), firstProfile.id);
  assert.equal(await secondWindow.getActiveProfileId(), secondProfile.id);
  assert.equal(globalState.values.has('codexSwitch.activeProfileId'), false);
  assert.equal(
    firstWorkspaceState.values.get('codexSwitch.activeProfileId'),
    firstProfile.id
  );
  assert.equal(
    secondWorkspaceState.values.get('codexSwitch.activeProfileId'),
    secondProfile.id
  );

  const restartedFirstWindow = createManager(
    ProfileManager,
    storageDirectory,
    globalState,
    firstWorkspaceState,
    secrets
  );
  assert.equal(await restartedFirstWindow.getActiveProfileId(), firstProfile.id);
  assert.equal(
    await restartedFirstWindow.maybeSyncToCodexAuthFile(firstProfile.id),
    true
  );
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(codexHome, 'auth.json'), 'utf8')).tokens
      .access_token,
    'access-first'
  );
  assert.equal(await secondWindow.getActiveProfileId(), secondProfile.id);

  assert.equal(await restartedFirstWindow.setActiveProfileId(secondProfile.id), true);
  const reloadedAfterSwitch = createManager(
    ProfileManager,
    storageDirectory,
    globalState,
    firstWorkspaceState,
    secrets
  );
  assert.equal(await reloadedAfterSwitch.getActiveProfileId(), secondProfile.id);
});
