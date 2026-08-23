'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

const { createMockVscode, installMockVscode } = require('../helpers/mockVscode');

function createIdToken() {
  const payload = {
    email: 'same-account@example.com',
    sub: 'same-user',
    'https://api.openai.com/auth': {
      chatgpt_plan_type: 'plus',
      chatgpt_user_id: 'same-chatgpt-user'
    }
  };
  return [
    Buffer.from('{}').toString('base64url'),
    Buffer.from(JSON.stringify(payload)).toString('base64url'),
    'signature'
  ].join('.');
}

function createAuthData(accessToken, refreshToken) {
  const idToken = createIdToken();
  return {
    idToken,
    accessToken,
    refreshToken,
    accountId: 'same-account-id',
    chatgptUserId: 'same-chatgpt-user',
    subject: 'same-user',
    email: 'same-account@example.com',
    planType: 'plus',
    authJson: {
      tokens: {
        id_token: idToken,
        access_token: accessToken,
        refresh_token: refreshToken,
        account_id: 'same-account-id'
      }
    }
  };
}

test('forced profile activation replaces credentials for the same account', async (t) => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-auth-activation-'));
  const storageDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-profile-storage-'));
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

  const state = new Map();
  const secrets = new Map();
  const stateBucket = {
    get: (key) => state.get(key),
    update: async (key, value) => {
      if (value === undefined) {
        state.delete(key);
      } else {
        state.set(key, value);
      }
    }
  };
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

  const manager = new ProfileManager(
    {
      globalStorageUri: { fsPath: storageDirectory },
      globalState: stateBucket,
      workspaceState: stateBucket,
      secrets: {
        get: async (key) => secrets.get(key),
        store: async (key, value) => secrets.set(key, value),
        delete: async (key) => secrets.delete(key)
      }
    },
    null
  );
  const freshAuth = createAuthData('fresh-access', 'fresh-refresh');
  const staleAuth = createAuthData('stale-access', 'stale-refresh');
  const profile = await manager.createProfile('Same account', freshAuth);
  fs.writeFileSync(
    path.join(codexHome, 'auth.json'),
    JSON.stringify(staleAuth.authJson),
    'utf8'
  );

  assert.equal(await manager.setActiveProfileId(profile.id, { forceAuthSync: true }), true);

  const activatedAuth = JSON.parse(
    fs.readFileSync(path.join(codexHome, 'auth.json'), 'utf8')
  );
  assert.equal(activatedAuth.tokens.access_token, 'fresh-access');
  assert.equal(activatedAuth.tokens.refresh_token, 'fresh-refresh');
});
