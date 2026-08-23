'use strict';

const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { createMockVscode, installMockVscode } = require('../helpers/mockVscode');

function createIdToken() {
  const payload = {
    email: 'new-account@example.com',
    sub: 'user-new',
    'https://api.openai.com/auth': {
      chatgpt_plan_type: 'plus',
      chatgpt_user_id: 'chatgpt-user-new'
    }
  };
  return [
    Buffer.from('{}').toString('base64url'),
    Buffer.from(JSON.stringify(payload)).toString('base64url'),
    'signature'
  ].join('.');
}

test('isolated login writes the new credentials and reloads VS Code', async () => {
  const handlers = new Map();
  const executedCommands = [];
  const informationPrompts = [];
  const registeredProfiles = [];
  const switchCommits = [];
  const terminalCalls = [];
  const profileActivations = [];
  let accountPrompt;
  let activeProfileId = 'old-profile';
  let createdProfile;
  let confirmReauthentication = false;

  const mock = createMockVscode({
    overrides: {
      ConfigurationTarget: { Global: 1 },
      ProgressLocation: { Notification: 15 },
      QuickPickItemKind: { Separator: -1 },
      ThemeIcon: class ThemeIcon {},
      workspace: {
        workspaceFolders: [],
        getConfiguration: () => ({
          get: (_key, fallback) => fallback,
          update: async () => {}
        })
      },
      commands: {
        registerCommand(command, handler) {
          handlers.set(command, handler);
          return { dispose() {} };
        },
        async executeCommand(command, ...args) {
          executedCommands.push({ command, args });
          const handler = handlers.get(command);
          return handler ? handler(...args) : undefined;
        }
      },
      window: {
        createQuickPick() {
          accountPrompt = {
            activeItems: [],
            selectedItems: [],
            items: [],
            onDidAccept(callback) {
              this.accept = callback;
              return { dispose() {} };
            },
            onDidHide(callback) {
              this.didHide = callback;
              return { dispose() {} };
            },
            show() {
              this.shown = true;
            },
            hide() {
              this.hidden = true;
              if (this.didHide) {
                this.didHide();
              }
            },
            dispose() {
              this.disposed = true;
            }
          };
          return accountPrompt;
        },
        createTerminal(options) {
          const terminalCall = {
            options,
            sentTexts: [],
            shown: false
          };
          terminalCalls.push(terminalCall);
          return {
            show() {
              terminalCall.shown = true;
            },
            sendText(text) {
              terminalCall.sentTexts.push(text);
              if (options.env && options.env.CODEX_HOME) {
                fs.writeFileSync(
                  path.join(options.env.CODEX_HOME, 'auth.json'),
                  JSON.stringify({
                    tokens: {
                      id_token: createIdToken(),
                      access_token: 'access-new',
                      refresh_token: 'refresh-new',
                      account_id: 'account-new'
                    }
                  })
                );
              }
            }
          };
        },
        async showInformationMessage(message, ...items) {
          informationPrompts.push({ message, items });
          return message.startsWith('Codex login completed for ')
            ? 'Add and use account'
            : undefined;
        },
        async showWarningMessage(message) {
          return confirmReauthentication && message.startsWith('Re-authenticate profile ')
            ? 'Log out and sign in'
            : undefined;
        },
        async showErrorMessage(message) {
          assert.fail(`Unexpected login error: ${message}`);
        }
      }
    }
  });
  const restore = installMockVscode(mock.vscode);

  try {
    for (const modulePath of [
      '../../src/config',
      '../../src/profiles/authManager',
      '../../src/profiles/featureFlags',
      '../../src/profiles/commands'
    ]) {
      delete require.cache[require.resolve(modulePath)];
    }
    const {
      registerProfileCommands,
      showAutoAddAccountPrompt
    } = require('../../src/profiles/commands');
    const profileManager = {
      logger: {
        debug() {},
        error() {},
        info() {},
        warn() {}
      },
      async appendProfileActivity() {},
      async createProfile(name, authData) {
        createdProfile = {
          id: 'new-profile',
          name,
          email: authData.email,
          planType: authData.planType
        };
        registeredProfiles.push(createdProfile);
        return createdProfile;
      },
      async findDuplicateProfile() {
        return null;
      },
      async getActiveProfileId() {
        return activeProfileId;
      },
      async getCurrentAuthProfileMatch() {
        return {
          hasAuth: true,
          profileId: activeProfileId
        };
      },
      getOtherActiveWindowProfileUsageByProfileId() {
        return new Map();
      },
      async getProfile(profileId) {
        return profileId === 'new-profile' ? createdProfile : null;
      },
      async listProfiles() {
        return registeredProfiles.slice();
      },
      async setActiveProfileId(profileId, options) {
        profileActivations.push({ profileId, options });
        activeProfileId = profileId;
        return true;
      }
    };
    const rateLimitMonitor = {
      async refresh() {}
    };
    const context = {
      extension: { id: 'screph.codex-terminal-recorder' },
      extensionUri: {},
      subscriptions: []
    };

    registerProfileCommands(
      context,
      profileManager,
      rateLimitMonitor,
      async () => {},
      {
        autoAddAccountTimeoutMs: 25,
        authLoginMaxWaitMs: 25,
        resolveCodexExecutable: () => 'C:\\mock-codex\\codex.exe',
        markWindowAuthChangeExpected() {},
        async onProfileSwitchCommitted(profileId, options) {
          switchCommits.push({ profileId, options });
        }
      }
    );

    await handlers.get('codex-switch.profile.login')();

    assert.ok(accountPrompt);
    assert.equal(accountPrompt.shown, true);
    assert.equal(accountPrompt.hidden, true);
    assert.equal(accountPrompt.disposed, true);
    assert.match(accountPrompt.placeholder, /Adding automatically in \d+s unless cancelled/);
    assert.deepEqual(
      accountPrompt.items.map((item) => item.action),
      ['add', 'cancel']
    );
    assert.equal(registeredProfiles.length, 1);
    assert.equal(activeProfileId, 'new-profile');
    assert.deepEqual(switchCommits, [
      {
        profileId: 'new-profile',
        options: {
          changedProfile: true,
          willReloadWindow: true
        }
      }
    ]);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(
      executedCommands.some(({ command }) => command === 'workbench.action.reloadWindow'),
      true
    );
    assert.deepEqual(profileActivations[0], {
      profileId: 'new-profile',
      options: { forceAuthSync: true }
    });
    assert.equal(terminalCalls[0].options.env.CODEX_HOME.length > 0, true);
    assert.equal(
      terminalCalls[0].options.env.PATH.split(path.delimiter)[0],
      path.dirname('C:\\mock-codex\\codex.exe')
    );

    confirmReauthentication = true;
    await handlers.get('codex-switch.profile.reauthenticate')('new-profile');
    assert.equal(terminalCalls.length, 2);
    assert.equal(terminalCalls[1].options.name, 'Codex Re-authentication');
    assert.equal(terminalCalls[1].shown, true);
    assert.deepEqual(terminalCalls[1].sentTexts, ['codex logout\ncodex login']);
    assert.equal(
      terminalCalls[1].options.env.PATH.split(path.delimiter)[0],
      path.dirname('C:\\mock-codex\\codex.exe')
    );

    const manualAddResult = showAutoAddAccountPrompt('another account', {
      timeoutMs: 1_000
    });
    accountPrompt.activeItems = [accountPrompt.items[0]];
    accountPrompt.accept();
    assert.equal(await manualAddResult, true);

    const cancelResult = showAutoAddAccountPrompt('cancelled account', {
      timeoutMs: 1_000
    });
    accountPrompt.activeItems = [accountPrompt.items[1]];
    accountPrompt.accept();
    assert.equal(await cancelResult, false);
  } finally {
    restore();
  }
});
