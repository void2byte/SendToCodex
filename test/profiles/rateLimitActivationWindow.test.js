'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { createMockVscode, installMockVscode } = require('../helpers/mockVscode');

const TEST_EXTENSION_VERSION = '9.9.9-test';

function withTestExtension(context = {}) {
  return {
    ...context,
    extension: {
      packageJSON: {
        version: TEST_EXTENSION_VERSION
      }
    }
  };
}

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

function createUnstartedProfile(id) {
  return {
    id,
    name: id,
    planType: 'plus',
    rateLimitState: {
      observedAt: Date.now(),
      sourceFile: 'https://chatgpt.com/backend-api/wham/usage',
      primary: null,
      secondary: {
        usedPercent: 0,
        resetAt: null,
        windowMinutes: 10080
      }
    }
  };
}

function loadModule(overrides = {}) {
  const mock = createMockVscode({
    overrides: {
      workspace: {
        workspaceFolders: [],
        getConfiguration: () => ({
          get: (_key, fallback) => fallback
        })
      },
      ...overrides
    }
  });
  const restore = installMockVscode(mock.vscode);
  delete require.cache[
    require.resolve('../../src/profiles/rateLimitActivationWindow')
  ];
  delete require.cache[
    require.resolve('../../src/profiles/rateLimitWindowActivator')
  ];
  delete require.cache[
    require.resolve('../../src/codex/CodexPostSwitchWarmup')
  ];
  const module = require('../../src/profiles/rateLimitActivationWindow');
  const chatModule = require('../../src/profiles/rateLimitWindowActivator');
  restore();
  return { module, chatModule, mock };
}

test('Code window launch environment removes extension-host process variables', () => {
  const { module } = loadModule();
  const environment = module.createCodeLaunchEnvironment({
    ELECTRON_RUN_AS_NODE: '1',
    PATH: 'test-path',
    VSCODE_ESM_ENTRYPOINT: 'vs/workbench/api/node/extensionHostProcess',
    vscode_crash_reporter_process_type: 'extensionHost',
    VSCODE_IPC_HOOK: '\\\\.\\pipe\\extension-host',
    VSCODE_PID: '1234',
    VSCODE_PORTABLE: 'portable-data'
  });

  assert.equal(environment.PATH, 'test-path');
  assert.equal(environment.VSCODE_PORTABLE, 'portable-data');
  assert.equal(environment.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(environment.VSCODE_ESM_ENTRYPOINT, undefined);
  assert.equal(environment.vscode_crash_reporter_process_type, undefined);
  assert.equal(environment.VSCODE_IPC_HOOK, undefined);
  assert.equal(environment.VSCODE_PID, undefined);
});

test('worker workspace and window launch stay isolated from the open project', () => {
  const { module } = loadModule();
  const storageDirectory = path.join('extension-storage');
  const workerWorkspacePath = module.getWorkerWorkspacePath(
    storageDirectory,
    'job-test'
  );

  assert.equal(
    workerWorkspacePath,
    path.join(
      module.getActivationRoot(storageDirectory),
      'workers',
      'worker-job-test'
    )
  );
  assert.deepEqual(
    module.getActivationWorkerWindowArgs(workerWorkspacePath, {
      mode: module.ACTIVATION_MODE_VSCODE_EXTENSION
    }),
    [
      '--new-window',
      '--disable-workspace-trust',
      '--enable-proposed-api',
      'screph.codex-terminal-recorder',
      workerWorkspacePath
    ]
  );
  assert.throws(
    () => module.getWorkerWorkspacePath(storageDirectory),
    /job id is required/i
  );
});

test('launcher creates a dedicated-window job and restores the original profile', async () => {
  const { module } = loadModule();
  const storageDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'codex-activation-launcher-test-')
  );
  const profiles = [createUnstartedProfile('profile-a')];
  const switchCalls = [];
  let completedClaim = null;
  const manager = {
    logger: null,
    getStorageDir: () => storageDirectory,
    async getActiveProfileId() {
      return 'profile-original';
    },
    async loadCurrentAuthData() {
      return { email: 'original@example.com' };
    },
    async listProfiles() {
      return profiles;
    },
    async getProfile(profileId) {
      if (profileId === 'profile-original') {
        return { id: profileId, name: profileId };
      }
      return profiles.find((profile) => profile.id === profileId) || null;
    },
    async setActiveProfileId(profileId, options) {
      switchCalls.push({ profileId, options });
      return true;
    },
    async initializeWindowActiveProfileFromCurrentAuth() {}
  };
  const coordinator = {
    claim() {
      return { acquired: true, coordinated: true, claimId: 'claim' };
    },
    complete(_key, _claim, succeeded) {
      completedClaim = succeeded;
    }
  };
  let openedWorkspace = null;
  const launcher = new module.RateLimitActivationWindowLauncher(
    withTestExtension({ globalState: createStateBucket() }),
    manager,
    null,
    null,
    {
      coordinator,
      pollIntervalMs: 10,
      async openWorkerWindow(workerWorkspacePath) {
        openedWorkspace = workerWorkspacePath;
        const marker = JSON.parse(
          fs.readFileSync(module.getWorkerMarkerPath(workerWorkspacePath), 'utf8')
        );
        module.updateActivationJob(marker.jobPath, (job) => ({
          ...job,
          status: 'completed',
          phase: 'completed',
          currentIndex: 1,
          completedProfileIds: ['profile-a'],
          completedAt: Date.now()
        }));
      }
    }
  );

  try {
    const result = await launcher.run();

    assert.ok(openedWorkspace);
    assert.equal(
      path.basename(path.dirname(openedWorkspace)),
      'workers'
    );
    assert.equal(
      path.dirname(path.dirname(openedWorkspace)),
      module.getActivationRoot(storageDirectory)
    );
    assert.equal(result.reason, 'completed');
    assert.equal(result.succeeded, 1);
    assert.deepEqual(result.failed, []);
    assert.equal(result.report.status, 'completed');
    assert.equal(result.report.accounts.length, 1);
    assert.equal(result.report.accounts[0].status, 'completed');
    assert.equal(result.report.originalAccountRestored, true);
    assert.equal(completedClaim, true);
    assert.deepEqual(switchCalls, [
      {
        profileId: 'profile-original',
        options: { transient: true, skipAuthBackup: true }
      }
    ]);
  } finally {
    fs.rmSync(storageDirectory, { recursive: true, force: true });
  }
});

test('launcher cancels promptly when the worker window has not started', async () => {
  const { module } = loadModule();
  const storageDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'codex-activation-cancel-before-start-test-')
  );
  const profiles = [createUnstartedProfile('profile-a')];
  let completedClaim = null;
  const manager = {
    logger: null,
    getStorageDir: () => storageDirectory,
    async getActiveProfileId() {
      return 'profile-original';
    },
    async loadCurrentAuthData() {
      return { email: 'original@example.com' };
    },
    async listProfiles() {
      return profiles;
    },
    async getProfile(profileId) {
      return profileId === 'profile-original'
        ? { id: profileId, name: profileId }
        : profiles.find((profile) => profile.id === profileId) || null;
    },
    async setActiveProfileId() {
      return true;
    },
    async initializeWindowActiveProfileFromCurrentAuth() {}
  };
  const launcher = new module.RateLimitActivationWindowLauncher(
    withTestExtension({ globalState: createStateBucket() }),
    manager,
    null,
    null,
    {
      coordinator: {
        claim: () => ({ acquired: true, claimId: 'claim' }),
        complete(_key, _claim, succeeded) {
          completedClaim = succeeded;
        }
      },
      openWorkerWindow: async () => {},
      pollIntervalMs: 10,
      workerStartupTimeoutMs: 1000
    }
  );

  try {
    const result = await launcher.run({
      cancellationToken: { isCancellationRequested: true }
    });

    assert.equal(result.reason, 'cancelled');
    assert.equal(result.cancelled, true);
    assert.equal(result.report.status, 'cancelled');
    assert.match(
      result.report.events.at(-1).detail,
      /before the dedicated VS Code window started/i
    );
    assert.equal(completedClaim, false);
  } finally {
    fs.rmSync(storageDirectory, { recursive: true, force: true });
  }
});

test('launcher fails quickly when the worker window never starts', async () => {
  const { module } = loadModule();
  const storageDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'codex-activation-startup-timeout-test-')
  );
  const profiles = [createUnstartedProfile('profile-a')];
  const manager = {
    logger: null,
    getStorageDir: () => storageDirectory,
    async getActiveProfileId() {
      return 'profile-original';
    },
    async loadCurrentAuthData() {
      return { email: 'original@example.com' };
    },
    async listProfiles() {
      return profiles;
    },
    async getProfile(profileId) {
      return profileId === 'profile-original'
        ? { id: profileId, name: profileId }
        : profiles.find((profile) => profile.id === profileId) || null;
    },
    async setActiveProfileId() {
      return true;
    },
    async initializeWindowActiveProfileFromCurrentAuth() {}
  };
  const launcher = new module.RateLimitActivationWindowLauncher(
    withTestExtension({ globalState: createStateBucket() }),
    manager,
    null,
    null,
    {
      coordinator: {
        claim: () => ({ acquired: true, claimId: 'claim' }),
        complete() {}
      },
      openWorkerWindow: async () => {},
      pollIntervalMs: 10,
      workerStartupTimeoutMs: 50
    }
  );

  try {
    const result = await launcher.run();

    assert.equal(result.reason, 'failed');
    assert.equal(result.report.status, 'failed');
    assert.match(result.report.lastError, /did not start within 50ms/i);
  } finally {
    fs.rmSync(storageDirectory, { recursive: true, force: true });
  }
});

test('worker marker is discovered in its isolated extension-storage workspace', () => {
  const storageDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'codex-activation-marker-storage-test-')
  );
  const workerWorkspacePath = path.join(
    storageDirectory,
    'rate-limit-counter-activation',
    'workers',
    'worker-job-test'
  );
  const { module } = loadModule({
    workspace: {
      isTrusted: true,
      workspaceFolders: [
        {
          uri: {
            scheme: 'file',
            fsPath: workerWorkspacePath
          }
        }
      ],
      getConfiguration: () => ({
        get: (_key, fallback) => fallback
      })
    }
  });
  const jobPath = path.join(
    module.getActivationRoot(storageDirectory),
    'job-test.json'
  );
  const changeDriveLetterCase = (value) =>
    process.platform === 'win32'
      ? `${value.slice(0, 1).toLowerCase()}${value.slice(1)}`
      : value;

  try {
    fs.mkdirSync(path.dirname(jobPath), { recursive: true });
    const windowTitleToken = module.getActivationWindowTitleToken('job-test');
    module.writeWorkerMarker(workerWorkspacePath, {
      version: module.ACTIVATION_JOB_VERSION,
      extensionVersion: TEST_EXTENSION_VERSION,
      jobId: 'job-test',
      workerToken: 'worker-token',
      windowTitleToken,
      jobPath: changeDriveLetterCase(jobPath),
      workerWorkspacePath: changeDriveLetterCase(workerWorkspacePath)
    });

    const marker = module.getCurrentWorkerMarker(
      { getStorageDir: () => storageDirectory },
      TEST_EXTENSION_VERSION
    );

    assert.ok(marker);
    assert.equal(marker.jobId, 'job-test');
    assert.equal(marker.workerToken, 'worker-token');
    assert.equal(marker.extensionVersion, TEST_EXTENSION_VERSION);
    assert.equal(
      module.getCurrentWorkerMarker(
        { getStorageDir: () => storageDirectory },
        '9.9.10-newer'
      ),
      null
    );
    assert.equal(
      JSON.parse(
        fs.readFileSync(
          path.join(workerWorkspacePath, '.vscode', 'settings.json'),
          'utf8'
        )
      )['window.title'],
      `${windowTitleToken}\${separator}\${activeEditorShort}\${separator}\${appName}`
    );
  } finally {
    fs.rmSync(storageDirectory, { recursive: true, force: true });
  }
});

test('legacy or mismatched worker markers cannot claim a current activation job', () => {
  const storageDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'codex-activation-marker-version-storage-test-')
  );
  const workerWorkspacePath = fs.mkdtempSync(
    path.join(os.tmpdir(), 'codex-activation-marker-version-worker-test-')
  );
  const { module } = loadModule({
    workspace: {
      isTrusted: true,
      workspaceFolders: [{ uri: { scheme: 'file', fsPath: workerWorkspacePath } }],
      getConfiguration: () => ({ get: (_key, fallback) => fallback })
    }
  });
  const marker = {
    version: module.ACTIVATION_JOB_VERSION - 1,
    extensionVersion: TEST_EXTENSION_VERSION,
    jobId: 'legacy-job',
    workerToken: 'legacy-token',
    windowTitleToken: 'legacy-worker-window',
    jobPath: path.join(module.getActivationRoot(storageDirectory), 'job-legacy.json'),
    workerWorkspacePath
  };

  try {
    fs.writeFileSync(
      path.join(workerWorkspacePath, '.codex-counter-activation-worker-v2.json'),
      JSON.stringify(marker),
      'utf8'
    );
    assert.equal(
      module.getCurrentWorkerMarker(
        { getStorageDir: () => storageDirectory },
        TEST_EXTENSION_VERSION
      ),
      null
    );

    fs.writeFileSync(
      path.join(workerWorkspacePath, module.ACTIVATION_WORKER_MARKER_FILENAME),
      JSON.stringify(marker),
      'utf8'
    );
    assert.equal(
      module.getCurrentWorkerMarker(
        { getStorageDir: () => storageDirectory },
        TEST_EXTENSION_VERSION
      ),
      null
    );
  } finally {
    fs.rmSync(storageDirectory, { recursive: true, force: true });
    fs.rmSync(workerWorkspacePath, { recursive: true, force: true });
  }
});

test('active activation owner is visible to other VS Code windows until completion', () => {
  const { module } = loadModule();
  const storageDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'codex-activation-owner-lock-test-')
  );
  const jobPath = path.join(module.getActivationRoot(storageDirectory), 'job-owner.json');
  fs.mkdirSync(path.dirname(jobPath), { recursive: true });
  fs.writeFileSync(
    jobPath,
    JSON.stringify({
      version: module.ACTIVATION_JOB_VERSION,
      jobId: 'job-owner',
      workerToken: 'worker-token',
      windowTitleToken: module.getActivationWindowTitleToken('job-owner'),
      workerWorkspacePath: path.join(storageDirectory, 'worker-owner'),
      status: 'running',
      phase: 'waiting-for-answer',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      heartbeatAt: Date.now()
    }),
    'utf8'
  );

  try {
    const active = module.getActiveRateLimitActivationJob(storageDirectory);
    assert.ok(active);
    assert.equal(active.jobId, 'job-owner');

    module.updateActivationJob(jobPath, (job) => ({
      ...job,
      status: 'completed',
      phase: 'completed'
    }));
    assert.equal(module.getActiveRateLimitActivationJob(storageDirectory), null);
  } finally {
    fs.rmSync(storageDirectory, { recursive: true, force: true });
  }
});

test('worker opens an activation thread in its own conversation editor without a global URI route', async () => {
  const { module, mock } = loadModule();
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'codex-activation-current-window-editor-test-')
  );
  const codexLogPath = path.join(directory, 'Codex.log');
  const threadId = '11111111-2222-4333-8444-555555555555';
  const threadUri = module.getActivationThreadUri(threadId);
  const existingTab = {
    input: {
      viewType: 'chatgpt.conversationEditor',
      uri: threadUri
    }
  };
  mock.setCommands(['vscode.openWith']);
  mock.setExtension('openai.chatgpt', {
    isActive: true,
    async activate() {}
  });
  mock.setTabGroups([{ tabs: [existingTab] }]);
  const executed = [];
  mock.vscode.commands.executeCommand = async (command, ...args) => {
    executed.push({ command, args });
    if (command === 'vscode.openWith') {
      fs.appendFileSync(
        codexLogPath,
        `maybe_resume_success conversationId=${threadId}\n`,
        'utf8'
      );
    }
  };
  fs.writeFileSync(codexLogPath, '', 'utf8');

  const worker = new module.RateLimitActivationWindowWorker(
    { globalState: createStateBucket() },
    {},
    null,
    null,
    { jobPath: '', jobId: 'job', workerToken: 'token' },
    { codexLogPath, completedChatVisibilityMs: 0 }
  );

  try {
    await worker.showThreadInCodex(threadId, { refresh: true });

    assert.equal(executed.length, 1);
    assert.equal(executed[0].command, 'vscode.openWith');
    assert.equal(executed[0].args[0].toString(), threadUri.toString());
    assert.equal(executed[0].args[1], 'chatgpt.conversationEditor');
    assert.equal(executed[0].args[2].preview, false);
    assert.deepEqual(mock.externalUris, []);
    assert.equal(mock.closedTabs.length, 1);
    assert.deepEqual(mock.closedTabs[0].tabs, [existingTab]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('app-server worker switches, waits for an answer, records confirmation, and restores', async () => {
  const { module, chatModule } = loadModule();
  const storageDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'codex-activation-worker-test-')
  );
  const workerWorkspacePath = module.getWorkerWorkspacePath(
    storageDirectory,
    'worker-test'
  );
  fs.mkdirSync(workerWorkspacePath, { recursive: true });
  const jobPath = path.join(module.getActivationRoot(storageDirectory), 'job-test.json');
  const marker = {
    version: module.ACTIVATION_JOB_VERSION,
    extensionVersion: TEST_EXTENSION_VERSION,
    jobId: 'job-test',
    workerToken: 'worker-token',
    windowTitleToken: module.getActivationWindowTitleToken('job-test'),
    jobPath,
    workerWorkspacePath
  };
  fs.writeFileSync(
    jobPath,
    JSON.stringify({
      ...marker,
      status: 'queued',
      phase: 'queued',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      environment: { extensionVersion: TEST_EXTENSION_VERSION },
      originalProfileId: 'profile-original',
      originalHadAuthFile: true,
      candidates: [{ profileId: 'profile-a', profileName: 'profile-a' }],
      currentIndex: 0
    })
  );

  const state = createStateBucket();
  const profile = createUnstartedProfile('profile-a');
  let activeProfileId = 'profile-original';
  const switchCalls = [];
  const manager = {
    getStorageDir: () => storageDirectory,
    async getProfile(profileId) {
      if (profileId === 'profile-original') {
        return { id: profileId, name: profileId };
      }
      return profileId === profile.id ? profile : null;
    },
    async getActiveProfileId() {
      return activeProfileId;
    },
    async setActiveProfileId(profileId, options) {
      activeProfileId = profileId;
      switchCalls.push({ profileId, options });
      return true;
    },
    async initializeWindowActiveProfileFromCurrentAuth() {}
  };
  const rateLimitMonitor = {
    async refresh() {
      profile.rateLimitState.secondary = {
        ...profile.rateLimitState.secondary,
        usedPercent: 1,
        resetAt: Date.now() + 7 * 24 * 60 * 60 * 1000
      };
    }
  };
  let threadReadyCallbackFound = false;
  let responseReadyCallbackFound = false;
  let cleaned = 0;
  const worker = new module.RateLimitActivationWindowWorker(
    withTestExtension({ globalState: state }),
    manager,
    rateLimitMonitor,
    null,
    marker,
    {
      reloadWindow: false,
      closeWindow: false,
      completedChatVisibilityMs: 0,
      createWorkspace: () => ({
        cwd: storageDirectory,
        filePath: path.join(storageDirectory, 'test.txt'),
        runtime: { command: 'codex', args: [], env: {} },
        cleanup() {
          cleaned += 1;
        }
      }),
      async runActivationTurn(options) {
        threadReadyCallbackFound = typeof options.onThreadReady === 'function';
        await options.onThreadReady('thread-a');
        responseReadyCallbackFound = typeof options.onResponseReady === 'function';
        await options.onResponseReady('thread-a', 'Тест успешно завершён.');
        return {
          threadId: 'thread-a',
          reused: false,
          archived: true,
          responseText: 'Тест успешно завершён.',
          archiveError: null,
          diagnostics: 'safe diagnostic line'
        };
      }
    }
  );
  try {
    await worker.run();
    const completed = module.readActivationJob(jobPath);

    assert.equal(threadReadyCallbackFound, true);
    assert.equal(responseReadyCallbackFound, true);
    assert.equal(completed.status, 'completed');
    assert.deepEqual(completed.completedProfileIds, ['profile-a']);
    assert.deepEqual(completed.unconfirmedProfileIds, []);
    assert.deepEqual(completed.failed, []);
    assert.equal(completed.originalAccountRestored, true);
    assert.equal(completed.accountResults.length, 1);
    assert.equal(completed.accountResults[0].profileId, 'profile-a');
    assert.equal(completed.accountResults[0].prompt, 'тест');
    assert.equal(
      completed.accountResults[0].responseText,
      'Тест успешно завершён.'
    );
    assert.equal(completed.accountResults[0].archived, true);
    assert.equal(completed.accountResults[0].limitConfirmed, true);
    assert.equal(
      completed.accountResults[0].diagnostics,
      'safe diagnostic line'
    );
    assert.ok(
      completed.events.some((event) => event.phase === 'account-completed')
    );
    assert.equal(cleaned, 1);
    assert.deepEqual(state.get(chatModule.ACTIVATION_THREAD_IDS_KEY), {
      'profile-a': 'thread-a'
    });
    assert.deepEqual(
      switchCalls.map((call) => call.profileId),
      ['profile-a', 'profile-original']
    );
    assert.equal(
      switchCalls.every(
        (call) =>
          call.options.transient === true &&
          call.options.skipAuthBackup === true
      ),
      true
    );
  } finally {
    fs.rmSync(storageDirectory, { recursive: true, force: true });
  }
});

test('official-extension worker uses the Codex UI path without starting a direct app-server turn', async () => {
  const { module } = loadModule();
  const storageDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'codex-extension-activation-worker-test-')
  );
  const workerWorkspacePath = path.join(
    storageDirectory,
    '.codex-counter-activation',
    'worker-ui-job'
  );
  fs.mkdirSync(workerWorkspacePath, { recursive: true });
  const jobPath = path.join(module.getActivationRoot(storageDirectory), 'job-ui.json');
  const marker = {
    version: module.ACTIVATION_JOB_VERSION,
    extensionVersion: TEST_EXTENSION_VERSION,
    jobId: 'job-ui',
    workerToken: 'worker-token',
    windowTitleToken: module.getActivationWindowTitleToken('job-ui'),
    jobPath,
    workerWorkspacePath
  };
  fs.mkdirSync(path.dirname(jobPath), { recursive: true });
  fs.writeFileSync(
    jobPath,
    JSON.stringify({
      ...marker,
      mode: module.ACTIVATION_MODE_VSCODE_EXTENSION,
      status: 'queued',
      phase: 'queued',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      environment: { extensionVersion: TEST_EXTENSION_VERSION },
      originalProfileId: 'profile-original',
      originalHadAuthFile: true,
      candidates: [{ profileId: 'profile-a', profileName: 'profile-a' }],
      currentIndex: 0
    })
  );
  const profile = createUnstartedProfile('profile-a');
  let activeProfileId = 'profile-original';
  const manager = {
    getStorageDir: () => storageDirectory,
    async getProfile(profileId) {
      if (profileId === 'profile-original') {
        return { id: profileId, name: profileId };
      }
      return profileId === profile.id ? profile : null;
    },
    async getActiveProfileId() {
      return activeProfileId;
    },
    async setActiveProfileId(profileId) {
      activeProfileId = profileId;
      return true;
    },
    async initializeWindowActiveProfileFromCurrentAuth() {}
  };
  const rateLimitMonitor = {
    async refresh() {
      profile.rateLimitState.secondary = {
        ...profile.rateLimitState.secondary,
        usedPercent: 1,
        resetAt: Date.now() + 60_000
      };
    }
  };
  let uiOptions = null;
  const worker = new module.RateLimitActivationWindowWorker(
    withTestExtension({ globalState: createStateBucket() }),
    manager,
    rateLimitMonitor,
    null,
    marker,
    {
      reloadWindow: false,
      closeWindow: false,
      createWorkspace: () => {
        throw new Error('The UI path must not create a direct app-server workspace.');
      },
      runActivationTurn: async () => {
        throw new Error('The UI path must not start a direct app-server turn.');
      },
      async runCodexExtensionTurn(options) {
        uiOptions = options;
        options.onState('typing-test');
        await options.onThreadReady('thread-ui');
        await options.onResponseReady('thread-ui', 'Ответ через расширение.');
        return {
          threadId: 'thread-ui',
          reused: false,
          archived: false,
          responseText: 'Ответ через расширение.',
          diagnostics: 'official extension UI'
        };
      }
    }
  );

  try {
    await worker.run();
    const completed = module.readActivationJob(jobPath);

    assert.ok(uiOptions);
    assert.equal(uiOptions.windowTitleToken, marker.windowTitleToken);
    assert.equal(completed.status, 'completed');
    assert.equal(completed.mode, module.ACTIVATION_MODE_VSCODE_EXTENSION);
    assert.equal(completed.accountResults[0].responseText, 'Ответ через расширение.');
    assert.equal(completed.accountResults[0].archived, false);
    assert.equal(completed.accountResults[0].diagnostics, 'official extension UI');
  } finally {
    fs.rmSync(storageDirectory, { recursive: true, force: true });
  }
});

test('worker reports a server-side logout as needs-auth', async () => {
  const { module } = loadModule();
  const storageDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'codex-extension-auth-state-test-')
  );
  const jobPath = path.join(module.getActivationRoot(storageDirectory), 'job-auth.json');
  const candidate = { profileId: 'profile-a', profileName: 'profile-a' };
  fs.mkdirSync(path.dirname(jobPath), { recursive: true });
  fs.writeFileSync(
    jobPath,
    JSON.stringify({
      jobId: 'job-auth',
      workerToken: 'worker-token',
      mode: module.ACTIVATION_MODE_VSCODE_EXTENSION,
      status: 'running',
      phase: 'checking-codex-auth',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      candidates: [candidate],
      currentIndex: 0,
      attemptStartedAt: Date.now()
    })
  );
  const worker = new module.RateLimitActivationWindowWorker(
    { globalState: createStateBucket() },
    {
      async getProfile() {
        return createUnstartedProfile('profile-a');
      }
    },
    null,
    null,
    {
      jobId: 'job-auth',
      workerToken: 'worker-token',
      jobPath,
      workerWorkspacePath: storageDirectory
    },
    { closeWindow: false, reloadWindow: false }
  );
  const error = new Error('The server revoked this session.');
  error.activationState = 'needs-auth';
  error.activationResult = { state: 'needs-auth', diagnostics: 'token revoked' };

  try {
    await worker.recordFailure(candidate, error);
    const failed = module.readActivationJob(jobPath);

    assert.equal(failed.accountResults[0].status, 'needs-auth');
    assert.equal(failed.accountResults[0].diagnostics, 'token revoked');
    assert.ok(failed.events.some((event) => event.phase === 'account-needs-auth'));
  } finally {
    fs.rmSync(storageDirectory, { recursive: true, force: true });
  }
});
