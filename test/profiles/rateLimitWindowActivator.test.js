'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createMockVscode, installMockVscode } = require('../helpers/mockVscode');

const APP_SERVER_SOURCE = 'codex-app-server://account/rateLimits/read';

function createStateBucket(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
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

function createProfile(id, windowNotStarted) {
  return {
    id,
    name: id,
    planType: 'plus',
    rateLimitState: windowNotStarted
      ? {
          observedAt: Date.now(),
          sourceFile: APP_SERVER_SOURCE,
          primary: {
            usedPercent: 0,
            resetAt: null,
            windowMinutes: 300
          },
          secondary: {
            usedPercent: 0,
            resetAt: null,
            windowMinutes: 10080
          }
        }
      : {
          observedAt: Date.now(),
          sourceFile: APP_SERVER_SOURCE,
          primary: {
            usedPercent: 20,
            resetAt: Date.now() + 60 * 60 * 1000,
            windowMinutes: 300
          },
          secondary: {
            usedPercent: 10,
            resetAt: Date.now() + 24 * 60 * 60 * 1000,
            windowMinutes: 10080
          }
        }
  };
}

function loadActivator() {
  const mock = createMockVscode({
    overrides: {
      workspace: {
        getConfiguration: () => ({
          get: (key, fallback) => fallback
        })
      }
    }
  });
  const restore = installMockVscode(mock.vscode);
  delete require.cache[require.resolve('../../src/profiles/rateLimitWindowActivator')];
  const module = require('../../src/profiles/rateLimitWindowActivator');
  restore();
  return module;
}

test('resolves the Codex CLI bundled with the official extension', () => {
  const { resolveLocalCodexExecutable } = loadActivator();
  const extensionPath = fs.mkdtempSync(
    path.join(os.tmpdir(), 'codex-bundled-cli-test-')
  );
  const executableName = process.platform === 'win32' ? 'codex.exe' : 'codex';
  const platformDirectory =
    process.platform === 'win32'
      ? `windows-${process.arch === 'x64' ? 'x86_64' : 'aarch64'}`
      : process.platform === 'darwin'
        ? `macos-${process.arch === 'x64' ? 'x86_64' : 'aarch64'}`
        : `linux-${process.arch === 'x64' ? 'x86_64' : 'aarch64'}`;
  const executablePath = path.join(
    extensionPath,
    'bin',
    platformDirectory,
    executableName
  );
  fs.mkdirSync(path.dirname(executablePath), { recursive: true });
  fs.writeFileSync(executablePath, '');

  try {
    assert.equal(
      resolveLocalCodexExecutable({
        codexExtension: { extensionPath },
        env: { PATH: '' }
      }),
      executablePath
    );
  } finally {
    fs.rmSync(extensionPath, { recursive: true, force: true });
  }
});

test('activation diagnostics redact credentials before entering a report', () => {
  const { sanitizeActivationDiagnostics } = loadActivator();
  const jwt = `eyJ${'a'.repeat(24)}.${'b'.repeat(24)}.${'c'.repeat(16)}`;
  const sanitized = sanitizeActivationDiagnostics(
    `Bearer private-token {"access_token":"secret-access","refresh_token":"secret-refresh"} ${jwt}`
  );

  assert.doesNotMatch(sanitized, /private-token|secret-access|secret-refresh/);
  assert.doesNotMatch(sanitized, /eyJaaaa/);
  assert.match(sanitized, /Bearer \[redacted\]/);
  assert.match(sanitized, /\[redacted-jwt\]/);
});

test('activation turn exposes the completed response before archiving its thread', async () => {
  const { runActivationTurn } = loadActivator();
  const events = [];
  const connection = {
    stderrBuffer: '',
    async start() {
      events.push('connection-started');
    },
    async request(method) {
      events.push(method);
      if (method === 'thread/start') {
        return { thread: { id: 'thread-test' } };
      }
      return {};
    },
    async startTurn(threadId, _input, _cwd, _cancellationToken, onStarted) {
      events.push('turn-started');
      await onStarted(threadId);
      events.push('turn-completed');
      return {
        status: 'completed',
        agentMessageText: 'Готово.'
      };
    },
    async close() {
      events.push('connection-closed');
    }
  };

  const result = await runActivationTurn({
    connection,
    workspace: {
      cwd: 'C:\\temp',
      filePath: 'C:\\temp\\test.txt',
      runtime: { command: 'codex', args: [], env: {} }
    },
    async onThreadReady(threadId) {
      assert.equal(threadId, 'thread-test');
      events.push('thread-visible');
    },
    async onResponseReady(threadId, responseText) {
      assert.equal(threadId, 'thread-test');
      assert.equal(responseText, 'Готово.');
      events.push('response-visible');
    }
  });

  assert.equal(result.archived, true);
  assert.equal(result.responseText, 'Готово.');
  assert.ok(events.indexOf('response-visible') < events.indexOf('thread/archive'));
  assert.deepEqual(events.slice(-2), ['thread/archive', 'connection-closed']);
});

test('activator switches unstarted accounts in sequence, reuses threads, and restores the original account', async () => {
  const {
    ACTIVATION_FILE_NAME,
    ACTIVATION_FILE_TEXT,
    ACTIVATION_THREAD_IDS_KEY,
    RateLimitWindowActivator,
    buildActivationTurnInput
  } = loadActivator();
  const state = createStateBucket({
    [ACTIVATION_THREAD_IDS_KEY]: {
      'profile-a': 'thread-existing'
    }
  });
  const profiles = [
    createProfile('profile-a', true),
    createProfile('profile-b', true),
    createProfile('profile-ready', false)
  ];
  const switchCalls = [];
  const refreshCalls = [];
  const activationCalls = [];
  let workspaceCleaned = 0;
  const manager = {
    context: { globalState: state },
    logger: null,
    async getActiveProfileId() {
      return 'profile-a';
    },
    async loadCurrentAuthData() {
      return { email: 'original@example.com' };
    },
    async listProfiles() {
      return profiles;
    },
    async getProfile(profileId) {
      return profiles.find((profile) => profile.id === profileId) || null;
    },
    async loadAuthData() {
      return {
        idToken: 'id',
        accessToken: 'access',
        refreshToken: 'refresh'
      };
    },
    async setActiveProfileId(profileId, options) {
      switchCalls.push({ profileId, options });
      return true;
    }
  };
  const workspace = {
    cwd: 'C:\\temp\\activation',
    filePath: 'C:\\temp\\activation\\test.txt',
    runtime: { command: 'codex', args: ['app-server', '--stdio'], env: {} },
    cleanup() {
      workspaceCleaned += 1;
    }
  };
  const activator = new RateLimitWindowActivator(
    { globalState: state },
    manager,
    {
      async refresh(force) {
        refreshCalls.push(force);
      }
    },
    null,
    {
      createWorkspace: () => workspace,
      async runActivationTurn(options) {
        activationCalls.push(options);
        assert.equal(options.workspace.filePath, workspace.filePath);
        assert.equal(options.workspace.cwd, workspace.cwd);
        assert.equal(options.existingThreadId, options.profile.id === 'profile-a'
          ? 'thread-existing'
          : undefined);
        return {
          threadId:
            options.profile.id === 'profile-a'
              ? 'thread-existing'
              : 'thread-profile-b',
          reused: options.profile.id === 'profile-a',
          archiveError: null
        };
      }
    }
  );

  const result = await activator.run();

  assert.equal(result.attempted, 2);
  assert.equal(result.succeeded, 2);
  assert.deepEqual(result.failed, []);
  assert.deepEqual(
    switchCalls.map((call) => call.profileId),
    ['profile-a', 'profile-b', 'profile-a']
  );
  assert.equal(switchCalls.every((call) => call.options.transient === true), true);
  assert.equal(refreshCalls.length, 2);
  assert.deepEqual(
    activationCalls.map((call) => [call.profile.id, call.existingThreadId]),
    [
      ['profile-a', 'thread-existing'],
      ['profile-b', undefined]
    ]
  );
  assert.equal(workspaceCleaned, 1);
  assert.deepEqual(state.get(ACTIVATION_THREAD_IDS_KEY), {
    'profile-a': 'thread-existing',
    'profile-b': 'thread-profile-b'
  });
  assert.equal(ACTIVATION_FILE_NAME, 'test.txt');
  assert.equal(ACTIVATION_FILE_TEXT, 'тест');
  assert.deepEqual(buildActivationTurnInput(workspace.filePath), [
    {
      type: 'text',
      text: 'тест'
    }
  ]);
});

test('activator continues after one account failure and preserves a partial result', async () => {
  const { RateLimitWindowActivator } = loadActivator();
  const state = createStateBucket();
  const profiles = [createProfile('profile-a', true), createProfile('profile-b', true)];
  const manager = {
    context: { globalState: state },
    logger: null,
    async getActiveProfileId() {
      return 'profile-a';
    },
    async loadCurrentAuthData() {
      return null;
    },
    async listProfiles() {
      return profiles;
    },
    async getProfile(profileId) {
      return profiles.find((profile) => profile.id === profileId) || null;
    },
    async loadAuthData() {
      return { idToken: 'id', accessToken: 'access', refreshToken: 'refresh' };
    },
    async setActiveProfileId() {
      return true;
    }
  };
  let attempts = 0;
  const activator = new RateLimitWindowActivator(
    { globalState: state },
    manager,
    null,
    null,
    {
      createWorkspace: () => ({
        cwd: 'C:\\temp',
        filePath: 'C:\\temp\\test.txt',
        runtime: { command: 'codex', args: [], env: {} },
        cleanup() {}
      }),
      async runActivationTurn(options) {
        attempts += 1;
        if (options.profile.id === 'profile-a') {
          throw new Error('simulated account failure');
        }
        return { threadId: 'thread-b', reused: false, archiveError: null };
      }
    }
  );

  const result = await activator.run();

  assert.equal(attempts, 2);
  assert.equal(result.reason, 'partial');
  assert.equal(result.succeeded, 1);
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].profileId, 'profile-a');
});
