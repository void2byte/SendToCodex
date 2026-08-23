'use strict';

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { spawn } = require('child_process');
const vscode = require('vscode');
const {
  getDefaultCodexAuthPath,
  loadAuthDataFromFile
} = require('./authManager');
const { syncCodexAuthFile } = require('./codexAuthSync');
const {
  mutateJsonFileSync,
  readJsonFileSync,
  writeJsonAtomicSync
} = require('./atomicJsonStore');
const { displayProfileName } = require('./privacy');
const { getProfileRateStatus } = require('./profileStatus');
const { RateLimitRefreshCoordinator } = require('./rateLimitRefreshCoordinator');
const {
  CodexExtensionUiActivator
} = require('./codexExtensionUiActivation');
const {
  ACTIVATION_FILE_TEXT,
  ACTIVATION_THREAD_IDS_KEY,
  createActivationWorkspace,
  getUnstartedProfiles,
  runActivationTurn
} = require('./rateLimitWindowActivator');
const { waitForCodexCommands } = require('../codex/CodexPostSwitchWarmup');
const {
  getFileSize,
  waitForConversationResume
} = require('../codex/CodexSidebarConversation');

const ACTIVATION_JOB_VERSION = 3;
const ACTIVATION_MODE_APP_SERVER = 'appServer';
const ACTIVATION_MODE_VSCODE_EXTENSION = 'vscodeExtension';
const ACTIVATION_JOBS_DIRNAME = 'rate-limit-counter-activation';
const ACTIVATION_WORKERS_DIRNAME = 'workers';
// The versioned marker name is intentional. An older extension host must ignore
// a new activation job instead of running its global-URI chat path in an unrelated
// VS Code window. Protocol v3 also binds the launcher and worker to the exact same
// extension build so this remains safe after subsequent package updates.
const ACTIVATION_WORKER_MARKER_FILENAME = '.codex-counter-activation-worker-v3.json';
const ACTIVATION_WORKER_SETTINGS_DIRNAME = '.vscode';
const ACTIVATION_WORKER_SETTINGS_FILENAME = 'settings.json';
const MULTITOOL_EXTENSION_ID = 'screph.codex-terminal-recorder';
const CODEX_EXTENSION_ID = 'openai.chatgpt';
const CODEX_OPEN_WITH_COMMAND = 'vscode.openWith';
const CODEX_CONVERSATION_EDITOR_VIEW_TYPE = 'chatgpt.conversationEditor';
const CODEX_CONVERSATION_URI_SCHEME = 'openai-codex';
const CODEX_CONVERSATION_URI_AUTHORITY = 'route';
const JOB_POLL_INTERVAL_MS = 500;
const WORKER_HEARTBEAT_INTERVAL_MS = 5 * 1000;
const WORKER_STARTUP_TIMEOUT_MS = 45 * 1000;
const WORKER_STALE_MS = 3 * 60 * 1000;
const LIMIT_CONFIRMATION_TIMEOUT_MS = 60 * 1000;
const LIMIT_CONFIRMATION_POLL_MS = 3 * 1000;
const COMPLETED_CHAT_VISIBILITY_MS = 2500;
const MAX_REPORT_EVENTS = 500;
const MAX_REPORT_TEXT_LENGTH = 32 * 1024;
const MAX_REPORT_DIAGNOSTICS_LENGTH = 12 * 1024;
const TERMINAL_JOB_STATUSES = new Set(['completed', 'partial', 'failed', 'cancelled']);
const activeWorkerJobs = new Set();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getErrorMessage(error) {
  return error && error.message ? error.message : String(error);
}

function asNonEmptyString(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const normalized = value.trim();
  return normalized || null;
}

function asTimestamp(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.round(numeric) : null;
}

function asVersion(value) {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : null;
}

function normalizeActivationMode(value, fallback = ACTIVATION_MODE_APP_SERVER) {
  if (
    value === ACTIVATION_MODE_APP_SERVER ||
    value === ACTIVATION_MODE_VSCODE_EXTENSION
  ) {
    return value;
  }
  return fallback;
}

function getActivationModeLabel(mode) {
  return normalizeActivationMode(mode) === ACTIVATION_MODE_VSCODE_EXTENSION
    ? 'Official Codex VS Code extension'
    : 'Codex app-server only';
}

function asOptionalNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function asBoundedString(value, maximumLength = MAX_REPORT_TEXT_LENGTH) {
  if (typeof value !== 'string') {
    return null;
  }
  return value.slice(0, maximumLength);
}

function normalizeCandidate(value) {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const profileId = asNonEmptyString(value.profileId);
  if (!profileId) {
    return null;
  }
  return {
    profileId,
    profileName: asNonEmptyString(value.profileName) || profileId
  };
}

function normalizeFailure(value) {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const profileId = asNonEmptyString(value.profileId);
  if (!profileId) {
    return null;
  }
  return {
    profileId,
    profileName: asNonEmptyString(value.profileName) || profileId,
    error: asNonEmptyString(value.error) || 'Unknown counter-activation failure'
  };
}

function normalizeRateLimitWindow(value) {
  if (!value || typeof value !== 'object') {
    return null;
  }
  return {
    usedPercent: asOptionalNumber(value.usedPercent),
    resetAt: asTimestamp(value.resetAt),
    windowMinutes: asOptionalNumber(value.windowMinutes)
  };
}

function normalizeRateLimitSnapshot(value) {
  if (!value || typeof value !== 'object') {
    return null;
  }
  return {
    source: asNonEmptyString(value.source),
    observedAt: asTimestamp(value.observedAt),
    planType: asNonEmptyString(value.planType),
    primary: normalizeRateLimitWindow(value.primary),
    secondary: normalizeRateLimitWindow(value.secondary)
  };
}

function normalizeReportEnvironment(value) {
  if (!value || typeof value !== 'object') {
    return {};
  }
  return {
    extensionVersion: asNonEmptyString(value.extensionVersion),
    vscodeVersion: asNonEmptyString(value.vscodeVersion),
    codexExtensionVersion: asNonEmptyString(value.codexExtensionVersion),
    platform: asNonEmptyString(value.platform),
    architecture: asNonEmptyString(value.architecture),
    workspaceTrusted: value.workspaceTrusted === true
  };
}

function normalizeReportEvent(value) {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const phase = asNonEmptyString(value.phase);
  const at = asTimestamp(value.at);
  if (!phase || !at) {
    return null;
  }
  return {
    at,
    phase,
    profileId: asNonEmptyString(value.profileId),
    profileName: asNonEmptyString(value.profileName),
    detail: asBoundedString(value.detail, 4096)
  };
}

function normalizeAccountResult(value) {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const profileId = asNonEmptyString(value.profileId);
  if (!profileId) {
    return null;
  }
  const status = asNonEmptyString(value.status) || 'unknown';
  return {
    profileId,
    profileName: asNonEmptyString(value.profileName) || profileId,
    status,
    startedAt: asTimestamp(value.startedAt),
    completedAt: asTimestamp(value.completedAt),
    durationMs: asOptionalNumber(value.durationMs),
    failedPhase: asNonEmptyString(value.failedPhase),
    error: asBoundedString(value.error, 16 * 1024),
    prompt: asBoundedString(value.prompt, 4096),
    responseText: asBoundedString(value.responseText),
    responseLength: Math.max(0, Math.round(Number(value.responseLength) || 0)),
    threadId: asNonEmptyString(value.threadId),
    threadReused: value.threadReused === true,
    archived: value.archived === true,
    archiveError: asBoundedString(value.archiveError, 16 * 1024),
    limitConfirmed: value.limitConfirmed === true,
    rateLimit: normalizeRateLimitSnapshot(value.rateLimit),
    diagnostics: asBoundedString(
      value.diagnostics,
      MAX_REPORT_DIAGNOSTICS_LENGTH
    )
  };
}

function normalizeActivationJob(value) {
  let source = value;
  if (typeof source === 'string') {
    source = JSON.parse(source);
  }
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    source = {};
  }

  const candidates = Array.isArray(source.candidates)
    ? source.candidates.map(normalizeCandidate).filter(Boolean)
    : [];
  const failed = Array.isArray(source.failed)
    ? source.failed.map(normalizeFailure).filter(Boolean)
    : [];
  const completedProfileIds = Array.isArray(source.completedProfileIds)
    ? source.completedProfileIds.map(asNonEmptyString).filter(Boolean)
    : [];
  const unconfirmedProfileIds = Array.isArray(source.unconfirmedProfileIds)
    ? source.unconfirmedProfileIds.map(asNonEmptyString).filter(Boolean)
    : [];
  const accountResults = Array.isArray(source.accountResults)
    ? source.accountResults.map(normalizeAccountResult).filter(Boolean)
    : [];
  const events = Array.isArray(source.events)
    ? source.events
        .map(normalizeReportEvent)
        .filter(Boolean)
        .slice(-MAX_REPORT_EVENTS)
    : [];
  const currentIndex = Math.max(
    0,
    Math.min(candidates.length, Math.round(Number(source.currentIndex) || 0))
  );
  const status = asNonEmptyString(source.status) || 'queued';

  return {
    version: asVersion(source.version),
    jobId: asNonEmptyString(source.jobId),
    workerToken: asNonEmptyString(source.workerToken),
    windowTitleToken: asNonEmptyString(source.windowTitleToken),
    mode: normalizeActivationMode(source.mode),
    status,
    phase: asNonEmptyString(source.phase) || 'queued',
    createdAt: asTimestamp(source.createdAt),
    updatedAt: asTimestamp(source.updatedAt),
    heartbeatAt: asTimestamp(source.heartbeatAt),
    completedAt: asTimestamp(source.completedAt),
    cancelRequested: source.cancelRequested === true,
    workerWorkspacePath: asNonEmptyString(source.workerWorkspacePath),
    originalProfileId: asNonEmptyString(source.originalProfileId),
    originalProfileName: asNonEmptyString(source.originalProfileName),
    originalAuthBackupPath: asNonEmptyString(source.originalAuthBackupPath),
    originalHadAuthFile: source.originalHadAuthFile === true,
    originalAccountRestored: source.originalAccountRestored === true,
    environment: normalizeReportEnvironment(source.environment),
    candidates,
    currentIndex,
    readyProfileId: asNonEmptyString(source.readyProfileId),
    attemptStartedAt: asTimestamp(source.attemptStartedAt),
    codexLogStartOffset:
      source.codexLogStartOffset === null || source.codexLogStartOffset === undefined
        ? null
        : asOptionalNumber(source.codexLogStartOffset),
    completedProfileIds,
    unconfirmedProfileIds,
    accountResults,
    events,
    failed,
    lastError: asNonEmptyString(source.lastError)
  };
}

function normalizeWorkerMarker(value) {
  let source = value;
  if (typeof source === 'string') {
    source = JSON.parse(source);
  }
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    source = {};
  }
  return {
    version: asVersion(source.version),
    extensionVersion: asNonEmptyString(source.extensionVersion),
    jobId: asNonEmptyString(source.jobId),
    workerToken: asNonEmptyString(source.workerToken),
    windowTitleToken: asNonEmptyString(source.windowTitleToken),
    jobPath: asNonEmptyString(source.jobPath),
    workerWorkspacePath: asNonEmptyString(source.workerWorkspacePath)
  };
}

function readActivationJob(jobPath) {
  return readJsonFileSync(
    jobPath,
    normalizeActivationJob(null),
    normalizeActivationJob
  );
}

function updateActivationJob(jobPath, mutate) {
  return mutateJsonFileSync(
    jobPath,
    normalizeActivationJob(null),
    normalizeActivationJob,
    (current) => {
      const next = mutate({ ...current });
      return {
        ...next,
        updatedAt: Date.now()
      };
    }
  );
}

function getActivationRoot(storageDirectory) {
  return path.join(storageDirectory, ACTIVATION_JOBS_DIRNAME);
}

function getWorkerWorkspacePath(storageDirectory, jobId) {
  const normalizedJobId = asNonEmptyString(jobId);
  if (!normalizedJobId) {
    throw new Error('An activation job id is required for its worker workspace.');
  }
  return path.join(
    getActivationRoot(storageDirectory),
    ACTIVATION_WORKERS_DIRNAME,
    `worker-${normalizedJobId}`
  );
}

function getWorkerMarkerPath(workerWorkspacePath) {
  return path.join(workerWorkspacePath, ACTIVATION_WORKER_MARKER_FILENAME);
}

function getActivationWindowTitleToken(jobId) {
  const normalizedJobId = asNonEmptyString(jobId);
  if (!normalizedJobId) {
    throw new Error('An activation job id is required for its worker-window title.');
  }
  return `codex-limit-activation-${normalizedJobId}`;
}

function getActivationThreadUri(threadId) {
  const normalizedThreadId = asNonEmptyString(threadId);
  if (!normalizedThreadId) {
    throw new Error('A Codex thread id is required to open the activation chat.');
  }
  return vscode.Uri.parse(
    `${CODEX_CONVERSATION_URI_SCHEME}://${CODEX_CONVERSATION_URI_AUTHORITY}/local/${encodeURIComponent(normalizedThreadId)}`
  );
}

function getActivationThreadTabs(threadId) {
  const uriString = getActivationThreadUri(threadId).toString();
  const groups =
    vscode.window.tabGroups && Array.isArray(vscode.window.tabGroups.all)
      ? vscode.window.tabGroups.all
      : [];
  const tabs = [];
  for (const group of groups) {
    for (const tab of Array.isArray(group && group.tabs) ? group.tabs : []) {
      const input = tab && tab.input;
      if (
        input &&
        input.viewType === CODEX_CONVERSATION_EDITOR_VIEW_TYPE &&
        input.uri &&
        typeof input.uri.toString === 'function' &&
        input.uri.toString() === uriString
      ) {
        tabs.push(tab);
      }
    }
  }
  return tabs;
}

function normalizePathForComparison(value) {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isSamePath(leftPath, rightPath) {
  return (
    normalizePathForComparison(leftPath) ===
    normalizePathForComparison(rightPath)
  );
}

function isPathInside(parentPath, childPath) {
  const parent = normalizePathForComparison(parentPath);
  const child = normalizePathForComparison(childPath);
  return child === parent || child.startsWith(`${parent}${path.sep}`);
}

function writeWorkerMarker(workerWorkspacePath, marker) {
  const normalizedMarker = normalizeWorkerMarker(marker);
  if (
    normalizedMarker.version !== ACTIVATION_JOB_VERSION ||
    !normalizedMarker.extensionVersion ||
    !normalizedMarker.windowTitleToken
  ) {
    throw new Error(
      'A current extension version, worker marker, and unique window-title token are required.'
    );
  }
  fs.mkdirSync(workerWorkspacePath, { recursive: true, mode: 0o700 });
  const settingsDirectory = path.join(
    workerWorkspacePath,
    ACTIVATION_WORKER_SETTINGS_DIRNAME
  );
  fs.mkdirSync(settingsDirectory, { recursive: true, mode: 0o700 });
  writeJsonAtomicSync(
    path.join(settingsDirectory, ACTIVATION_WORKER_SETTINGS_FILENAME),
    {
      // Keep a job-specific literal in the native title even when a Codex conversation
      // becomes the active editor. The UI driver refuses to open or type unless this
      // exact top-level worker window is the sole owner of the token.
      'window.title': `${normalizedMarker.windowTitleToken}\${separator}\${activeEditorShort}\${separator}\${appName}`
    }
  );
  writeJsonAtomicSync(getWorkerMarkerPath(workerWorkspacePath), normalizedMarker);
}

function getCurrentWorkerMarker(profileManager, expectedExtensionVersion) {
  const normalizedExpectedVersion = asNonEmptyString(expectedExtensionVersion);
  if (!normalizedExpectedVersion) {
    return null;
  }
  const folders =
    vscode.workspace && Array.isArray(vscode.workspace.workspaceFolders)
      ? vscode.workspace.workspaceFolders
      : [];
  const storageDirectory = profileManager.getStorageDir();
  const activationRoot = getActivationRoot(storageDirectory);

  for (const folder of folders) {
    const folderPath = folder && folder.uri && folder.uri.fsPath;
    if (!folderPath) {
      continue;
    }
    const markerPath = getWorkerMarkerPath(folderPath);
    if (!fs.existsSync(markerPath)) {
      continue;
    }
    try {
      const marker = normalizeWorkerMarker(fs.readFileSync(markerPath, 'utf8'));
      if (
        marker.version === ACTIVATION_JOB_VERSION &&
        marker.extensionVersion === normalizedExpectedVersion &&
        marker.jobId &&
        marker.workerToken &&
        marker.windowTitleToken &&
        marker.jobPath &&
        marker.workerWorkspacePath &&
        isSamePath(marker.workerWorkspacePath, folderPath) &&
        isPathInside(activationRoot, marker.jobPath)
      ) {
        return marker;
      }
    } catch {
      // Ignore an incomplete marker while another window is replacing it.
    }
  }
  return null;
}

function getActiveRateLimitActivationJob(storageDirectory, now = Date.now()) {
  const activationRoot = getActivationRoot(storageDirectory);
  if (!fs.existsSync(activationRoot)) {
    return null;
  }
  let entries;
  try {
    entries = fs
      .readdirSync(activationRoot, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /^job-.*\.json$/i.test(entry.name))
      .map((entry) => path.join(activationRoot, entry.name));
  } catch {
    return null;
  }

  entries.sort((left, right) => {
    try {
      return fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs;
    } catch {
      return 0;
    }
  });
  for (const jobPath of entries) {
    let job;
    try {
      job = readActivationJob(jobPath);
    } catch {
      continue;
    }
    if (
      job.version !== ACTIVATION_JOB_VERSION ||
      TERMINAL_JOB_STATUSES.has(job.status)
    ) {
      continue;
    }
    const lastActivityAt = job.heartbeatAt || job.updatedAt || job.createdAt;
    const maximumAgeMs = job.heartbeatAt
      ? WORKER_STALE_MS
      : WORKER_STARTUP_TIMEOUT_MS * 2;
    if (lastActivityAt && now - lastActivityAt <= maximumAgeMs) {
      return { ...job, jobPath };
    }
  }
  return null;
}

function resolveCodeExecutable() {
  const processExecutable = asNonEmptyString(process.execPath);
  const executableName = processExecutable
    ? path.basename(processExecutable).toLowerCase()
    : '';
  if (
    processExecutable &&
    fs.existsSync(processExecutable) &&
    ['code.exe', 'code-insiders.exe', 'codium.exe'].includes(executableName)
  ) {
    return processExecutable;
  }

  const appRoot =
    vscode.env && asNonEmptyString(vscode.env.appRoot)
      ? vscode.env.appRoot
      : null;
  if (appRoot && process.platform === 'win32') {
    for (const levels of [2, 3]) {
      const candidate = path.resolve(
        appRoot,
        ...Array.from({ length: levels }, () => '..'),
        'Code.exe'
      );
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
  }

  return process.platform === 'win32' ? 'code.cmd' : 'code';
}

function createCodeLaunchEnvironment(source = process.env) {
  const environment = { ...source };
  const extensionHostVariables = new Set([
    'ELECTRON_RUN_AS_NODE',
    'VSCODE_CODE_CACHE_PATH',
    'VSCODE_CRASH_REPORTER_PROCESS_TYPE',
    'VSCODE_CWD',
    'VSCODE_ESM_ENTRYPOINT',
    'VSCODE_HANDLES_UNCAUGHT_ERRORS',
    'VSCODE_IPC_HOOK',
    'VSCODE_PID',
    'VSCODE_PIPE_LOGGING',
    'VSCODE_VERBOSE_LOGGING'
  ]);

  for (const key of Object.keys(environment)) {
    if (extensionHostVariables.has(key.toUpperCase())) {
      delete environment[key];
    }
  }
  return environment;
}

function spawnCodeWindow(executable, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: createCodeLaunchEnvironment()
    });
    let settled = false;
    const settle = (callback, value) => {
      if (settled) {
        return;
      }
      settled = true;
      callback(value);
    };
    child.once('error', (error) => settle(reject, error));
    child.once('spawn', () => {
      child.unref();
      settle(resolve);
    });
  });
}

function createReportEnvironment(context) {
  const codexExtension =
    vscode.extensions && typeof vscode.extensions.getExtension === 'function'
      ? vscode.extensions.getExtension(CODEX_EXTENSION_ID)
      : null;
  return normalizeReportEnvironment({
    extensionVersion:
      context &&
      context.extension &&
      context.extension.packageJSON &&
      context.extension.packageJSON.version,
    vscodeVersion: vscode.version,
    codexExtensionVersion:
      codexExtension &&
      codexExtension.packageJSON &&
      codexExtension.packageJSON.version,
    platform: process.platform,
    architecture: process.arch,
    workspaceTrusted: Boolean(vscode.workspace && vscode.workspace.isTrusted)
  });
}

function createRateLimitSnapshot(profile) {
  const state =
    profile && profile.rateLimitState && typeof profile.rateLimitState === 'object'
      ? profile.rateLimitState
      : {};
  return normalizeRateLimitSnapshot({
    source: state.sourceFile,
    observedAt: state.observedAt,
    planType: profile && profile.planType,
    primary: state.primary,
    secondary: state.secondary
  });
}

function upsertAccountResult(accountResults, nextResult) {
  return [
    ...(accountResults || []).filter(
      (result) => result.profileId !== nextResult.profileId
    ),
    nextResult
  ];
}

function buildActivationReport(job, options = {}) {
  const accountResultsById = new Map(
    job.accountResults.map((entry) => [entry.profileId, entry])
  );
  const failuresById = new Map(
    job.failed.map((entry) => [entry.profileId, entry])
  );
  const completedIds = new Set(job.completedProfileIds);
  const unconfirmedIds = new Set(job.unconfirmedProfileIds);
  const accounts = job.candidates.map((candidate) => {
    const result = accountResultsById.get(candidate.profileId);
    if (result) {
      return {
        ...result,
        limitConfirmed:
          result.limitConfirmed && !unconfirmedIds.has(candidate.profileId)
      };
    }
    const failure = failuresById.get(candidate.profileId);
    return normalizeAccountResult({
      profileId: candidate.profileId,
      profileName: candidate.profileName,
      status: failure
        ? 'failed'
        : completedIds.has(candidate.profileId)
          ? 'completed'
          : job.status === 'cancelled'
            ? 'cancelled'
            : 'not-run',
      error: failure && failure.error,
      prompt: ACTIVATION_FILE_TEXT,
      limitConfirmed:
        completedIds.has(candidate.profileId) &&
        !unconfirmedIds.has(candidate.profileId)
    });
  });
  const completedAt = job.completedAt || job.updatedAt;
  return {
    jobId: job.jobId,
    mode: job.mode,
    modeLabel: getActivationModeLabel(job.mode),
    status: job.status,
    phase: job.phase,
    createdAt: job.createdAt,
    completedAt,
    durationMs:
      job.createdAt && completedAt
        ? Math.max(0, completedAt - job.createdAt)
        : null,
    attempted: job.candidates.length,
    succeeded: job.completedProfileIds.length,
    failed: job.failed.length,
    unconfirmed: job.unconfirmedProfileIds.length,
    cancelled: job.status === 'cancelled',
    originalProfileId: job.originalProfileId,
    originalProfileName: job.originalProfileName,
    originalAccountRestored: job.originalAccountRestored,
    lastError: job.lastError,
    environment: job.environment,
    jobPath: asNonEmptyString(options.jobPath),
    workerWorkspacePath: job.workerWorkspacePath,
    events: job.events,
    accounts
  };
}

function activationJobToResult(job, options = {}) {
  const succeeded = job.completedProfileIds.length;
  const failed =
    job.status === 'failed' && job.failed.length === 0 && job.lastError
      ? [
          {
            profileId: 'activation-worker',
            profileName: 'dedicated activation window',
            error: job.lastError
          }
        ]
      : job.failed;
  return {
    started: true,
    reason:
      job.status === 'cancelled'
        ? 'cancelled'
        : failed.length === 0
          ? 'completed'
          : succeeded > 0
            ? 'partial'
            : 'failed',
    attempted: job.candidates.length,
    succeeded,
    failed,
    cancelled: job.status === 'cancelled',
    unconfirmed: job.unconfirmedProfileIds,
    report: buildActivationReport(job, options)
  };
}

function getActivationWorkerWindowArgs(workerWorkspacePath, options = {}) {
  const args = [
    '--new-window',
    // The worker folder is extension-owned global storage, so it must not depend
    // on (or write inside) whichever user workspace happened to launch the job.
    '--disable-workspace-trust',
    '--enable-proposed-api',
    MULTITOOL_EXTENSION_ID
  ];
  if (
    normalizeActivationMode(options.mode) === ACTIVATION_MODE_APP_SERVER
  ) {
    args.push('--disable-extension', CODEX_EXTENSION_ID);
  }
  args.push(workerWorkspacePath);
  return args;
}

async function openActivationWorkerWindow(workerWorkspacePath, options = {}) {
  const args = getActivationWorkerWindowArgs(workerWorkspacePath, options);
  await spawnCodeWindow(resolveCodeExecutable(), args);
}

class RateLimitActivationWindowLauncher {
  constructor(context, profileManager, rateLimitMonitor, logger, options = {}) {
    this.context = context;
    this.profileManager = profileManager;
    this.rateLimitMonitor = rateLimitMonitor;
    this.logger = logger;
    this.openWorkerWindow =
      options.openWorkerWindow || openActivationWorkerWindow;
    this.pollIntervalMs = Math.max(
      50,
      Number(options.pollIntervalMs) || JOB_POLL_INTERVAL_MS
    );
    this.workerStartupTimeoutMs = Math.max(
      50,
      Number(options.workerStartupTimeoutMs) || WORKER_STARTUP_TIMEOUT_MS
    );
    this.now = options.now || (() => Date.now());
    this.running = false;
    this.coordinator =
      options.coordinator ||
      new RateLimitRefreshCoordinator(
        () => profileManager.getStorageDir(),
        `counter-activation-launcher-${randomUUID()}`,
        logger
      );
  }

  async restoreOriginalAccount(originalProfileId, originalAuthData, hadAuthFile) {
    if (originalProfileId && (await this.profileManager.getProfile(originalProfileId))) {
      await this.profileManager.setActiveProfileId(originalProfileId, {
        transient: true,
        skipAuthBackup: true
      });
      return;
    }

    const authPath = getDefaultCodexAuthPath(this.logger);
    if (originalAuthData) {
      syncCodexAuthFile(authPath, originalAuthData);
      await this.profileManager.initializeWindowActiveProfileFromCurrentAuth(true);
      return;
    }

    if (!hadAuthFile && fs.existsSync(authPath)) {
      fs.unlinkSync(authPath);
    }
    await this.profileManager.setActiveProfileId(undefined, {
      transient: true,
      skipAuthBackup: true
    });
  }

  async requestCancellation(jobPath) {
    try {
      updateActivationJob(jobPath, (job) => ({
        ...job,
        cancelRequested: true,
        phase: 'cancelling'
      }));
    } catch (error) {
      if (this.logger) {
        this.logger.warn('Failed to request counter-activation worker cancellation.', {
          error: getErrorMessage(error)
        });
      }
    }
  }

  async waitForCompletion(jobPath, options = {}) {
    const cancellationToken = options.cancellationToken;
    const total = Math.max(1, Number(options.total) || 1);
    const timeoutMs = Math.max(
      10 * 60 * 1000,
      total * 8 * 60 * 1000 + 5 * 60 * 1000
    );
    const startedAt = this.now();
    let lastProgressKey = '';

    while (this.now() - startedAt <= timeoutMs) {
      if (cancellationToken && cancellationToken.isCancellationRequested) {
        await this.requestCancellation(jobPath);
      }

      let job = readActivationJob(jobPath);
      if (TERMINAL_JOB_STATUSES.has(job.status)) {
        return job;
      }
      if (job.cancelRequested && job.status === 'queued' && !job.heartbeatAt) {
        job = updateActivationJob(jobPath, (current) => ({
          ...current,
          status: 'cancelled',
          phase: 'cancelled',
          completedAt: this.now(),
          events: [
            ...current.events,
            {
              at: this.now(),
              phase: 'cancelled',
              detail: 'Cancelled before the dedicated VS Code window started.'
            }
          ].slice(-MAX_REPORT_EVENTS)
        }));
        return job;
      }

      const candidate = job.candidates[job.currentIndex];
      const progressKey = [
        job.currentIndex,
        job.phase,
        job.completedProfileIds.length,
        job.failed.length
      ].join(':');
      if (
        candidate &&
        progressKey !== lastProgressKey &&
        typeof options.onProgress === 'function'
      ) {
        lastProgressKey = progressKey;
        options.onProgress({
          profile: {
            id: candidate.profileId,
            name: candidate.profileName
          },
          index: job.currentIndex,
          total: job.candidates.length,
          increment: 0,
          phase: job.phase
        });
      }

      const heartbeatAge = job.heartbeatAt
        ? this.now() - job.heartbeatAt
        : this.now() - (job.createdAt || startedAt);
      if (
        job.status === 'queued' &&
        !job.heartbeatAt &&
        heartbeatAge > this.workerStartupTimeoutMs
      ) {
        throw new Error(
          `The dedicated counter-activation window did not start within ${this.workerStartupTimeoutMs}ms.`
        );
      }
      if (
        job.status === 'running' &&
        heartbeatAge > WORKER_STALE_MS
      ) {
        throw new Error(
          `The dedicated counter-activation window stopped responding during ${job.phase}.`
        );
      }

      await sleep(this.pollIntervalMs);
    }

    throw new Error(
      `The dedicated counter-activation window did not finish within ${timeoutMs}ms.`
    );
  }

  async run(options = {}) {
    if (this.running) {
      return {
        started: false,
        reason: 'already-running',
        attempted: 0,
        succeeded: 0,
        failed: []
      };
    }

    this.running = true;
    const claim = this.coordinator.claim('all-unstarted-counters', {
      leaseTimeoutMs: 2 * 60 * 60 * 1000,
      minimumFreshMs: 0,
      failureBackoffMs: 0
    });
    if (claim && !claim.acquired) {
      this.running = false;
      return {
        started: false,
        reason: 'already-running',
        attempted: 0,
        succeeded: 0,
        failed: []
      };
    }

    let originalProfileId;
    let originalAuthData;
    let hadAuthFile;
    let jobPath;
    let result;
    try {
      originalProfileId = await this.profileManager.getActiveProfileId();
      originalAuthData = await this.profileManager.loadCurrentAuthData();
      const authPath = getDefaultCodexAuthPath(this.logger);
      hadAuthFile = fs.existsSync(authPath);
      const profiles = await this.profileManager.listProfiles();
      const originalProfile = profiles.find(
        (profile) => profile && profile.id === originalProfileId
      );
      const candidates = getUnstartedProfiles(
        profiles,
        originalProfileId
      );
      if (candidates.length === 0) {
        result = {
          started: true,
          reason: 'no-candidates',
          attempted: 0,
          succeeded: 0,
          failed: [],
          cancelled: false,
          unconfirmed: []
        };
        return result;
      }

      const mode = normalizeActivationMode(
        options.mode,
        ACTIVATION_MODE_VSCODE_EXTENSION
      );
      const storageDirectory = this.profileManager.getStorageDir();
      const activationRoot = getActivationRoot(storageDirectory);
      const jobId = randomUUID();
      const workerToken = randomUUID();
      const windowTitleToken = getActivationWindowTitleToken(jobId);
      const workerWorkspacePath = getWorkerWorkspacePath(storageDirectory, jobId);
      jobPath = path.join(activationRoot, `job-${jobId}.json`);
      let originalAuthBackupPath = null;
      if (!originalProfileId && hadAuthFile) {
        originalAuthBackupPath = await this.profileManager.backupCurrentAuth(
          'before-counter-activation-window'
        );
      }

      const createdAt = this.now();
      const job = normalizeActivationJob({
        version: ACTIVATION_JOB_VERSION,
        jobId,
        workerToken,
        windowTitleToken,
        mode,
        status: 'queued',
        phase: 'opening-window',
        createdAt,
        updatedAt: createdAt,
        workerWorkspacePath,
        originalProfileId,
        originalProfileName: originalProfile
          ? displayProfileName(originalProfile)
          : null,
        originalAuthBackupPath,
        originalHadAuthFile: hadAuthFile,
        environment: createReportEnvironment(this.context),
        candidates: candidates.map((profile) => ({
          profileId: profile.id,
          profileName: displayProfileName(profile)
        })),
        currentIndex: 0,
        events: [
          {
            at: createdAt,
            phase: 'opening-window',
            profileId: candidates[0] && candidates[0].id,
            profileName: candidates[0] && displayProfileName(candidates[0])
          }
        ]
      });
      writeJsonAtomicSync(jobPath, job);
      writeWorkerMarker(workerWorkspacePath, {
        version: ACTIVATION_JOB_VERSION,
        extensionVersion: job.environment.extensionVersion,
        jobId,
        workerToken,
        windowTitleToken,
        jobPath,
        workerWorkspacePath
      });

      if (typeof options.onProgress === 'function') {
        options.onProgress({
          profile: candidates[0],
          index: 0,
          total: candidates.length,
          increment: 0,
          phase: 'opening-window'
        });
      }
      await this.openWorkerWindow(workerWorkspacePath, { mode });
      const completedJob = await this.waitForCompletion(jobPath, {
        cancellationToken: options.cancellationToken,
        onProgress: options.onProgress,
        total: candidates.length
      });
      result = activationJobToResult(completedJob, { jobPath });
      return result;
    } catch (error) {
      if (jobPath) {
        try {
          const failedJob = updateActivationJob(jobPath, (job) => ({
            ...job,
            status: 'failed',
            phase: 'failed',
            completedAt: this.now(),
            lastError: getErrorMessage(error),
            events: [
              ...job.events,
              {
                at: this.now(),
                phase: 'failed',
                detail: getErrorMessage(error)
              }
            ].slice(-MAX_REPORT_EVENTS)
          }));
          result = activationJobToResult(failedJob, { jobPath });
          return result;
        } catch {
          // The original error is more useful than a secondary job-file failure.
        }
      }
      throw error;
    } finally {
      try {
        if (originalProfileId !== undefined || originalAuthData || hadAuthFile !== undefined) {
          await this.restoreOriginalAccount(
            originalProfileId,
            originalAuthData,
            hadAuthFile
          );
          if (jobPath && fs.existsSync(jobPath)) {
            const restoredJob = updateActivationJob(jobPath, (job) => ({
              ...job,
              originalAccountRestored: true
            }));
            if (result && result.report) {
              result.report = buildActivationReport(restoredJob, { jobPath });
            }
          }
        }
      } catch (error) {
        if (this.logger) {
          this.logger.error('Failed to restore the original account after counter activation.', {
            error: getErrorMessage(error)
          });
        }
      }
      this.coordinator.complete(
        'all-unstarted-counters',
        claim,
        Boolean(result && result.failed.length === 0 && !result.cancelled)
      );
      this.running = false;
    }
  }
}

class RateLimitActivationWindowWorker {
  constructor(context, profileManager, rateLimitMonitor, logger, marker, options = {}) {
    this.context = context;
    this.profileManager = profileManager;
    this.rateLimitMonitor = rateLimitMonitor;
    this.logger = logger;
    this.marker = marker;
    this.jobPath = marker.jobPath;
    this.codexLogPath = options.codexLogPath;
    this.createWorkspace = options.createWorkspace || createActivationWorkspace;
    this.runActivationTurn = options.runActivationTurn || runActivationTurn;
    this.limitConfirmationTimeoutMs = Math.max(
      0,
      Number(options.limitConfirmationTimeoutMs) || LIMIT_CONFIRMATION_TIMEOUT_MS
    );
    this.limitConfirmationPollMs = Math.max(
      100,
      Number(options.limitConfirmationPollMs) || LIMIT_CONFIRMATION_POLL_MS
    );
    const configuredVisibilityMs = Number(options.completedChatVisibilityMs);
    this.completedChatVisibilityMs = Math.max(
      0,
      Number.isFinite(configuredVisibilityMs)
        ? configuredVisibilityMs
        : COMPLETED_CHAT_VISIBILITY_MS
    );
    const codexExtensionUiActivator =
      options.codexExtensionUiActivator ||
      new CodexExtensionUiActivator(logger, {
        codexLogPath: this.codexLogPath,
        visibilityMs: this.completedChatVisibilityMs
      });
    this.runCodexExtensionTurn =
      options.runCodexExtensionTurn ||
      codexExtensionUiActivator.run.bind(codexExtensionUiActivator);
    this.closeWindow = options.closeWindow !== false;
    this.reloadWindow = options.reloadWindow !== false;
  }

  validateJob(job) {
    const runningExtensionVersion = asNonEmptyString(
      this.context &&
        this.context.extension &&
        this.context.extension.packageJSON &&
        this.context.extension.packageJSON.version
    );
    if (
      this.marker.version !== ACTIVATION_JOB_VERSION ||
      job.version !== ACTIVATION_JOB_VERSION ||
      !runningExtensionVersion ||
      this.marker.extensionVersion !== runningExtensionVersion ||
      job.environment.extensionVersion !== runningExtensionVersion ||
      !job.jobId ||
      job.jobId !== this.marker.jobId ||
      !job.workerToken ||
      job.workerToken !== this.marker.workerToken ||
      !job.windowTitleToken ||
      job.windowTitleToken !== this.marker.windowTitleToken
    ) {
      throw new Error(
        'The counter-activation worker protocol or ownership marker does not match its job.'
      );
    }
  }

  getThreadIds() {
    const value = this.context.globalState.get(ACTIVATION_THREAD_IDS_KEY, {});
    return value && typeof value === 'object' && !Array.isArray(value)
      ? { ...value }
      : {};
  }

  async setThreadId(profileId, threadId) {
    const threadIds = this.getThreadIds();
    threadIds[profileId] = threadId;
    await this.context.globalState.update(ACTIVATION_THREAD_IDS_KEY, threadIds);
  }

  async getRateLimitSnapshot(profileId) {
    try {
      const profile = await this.profileManager.getProfile(profileId);
      return createRateLimitSnapshot(profile);
    } catch (error) {
      if (this.logger) {
        this.logger.warn('Could not add a rate-limit snapshot to the activation report.', {
          profileId,
          error: getErrorMessage(error)
        });
      }
      return null;
    }
  }

  updatePhase(phase, extra = {}) {
    const at = Date.now();
    return updateActivationJob(this.jobPath, (job) => {
      const candidate = job.candidates[job.currentIndex];
      return {
        ...job,
        status: 'running',
        phase,
        heartbeatAt: at,
        events: [
          ...job.events,
          {
            at,
            phase,
            profileId: candidate && candidate.profileId,
            profileName: candidate && candidate.profileName
          }
        ].slice(-MAX_REPORT_EVENTS),
        ...extra
      };
    });
  }

  async closeActivationChatTabs(threadId) {
    const tabs = getActivationThreadTabs(threadId);
    if (
      tabs.length &&
      vscode.window.tabGroups &&
      typeof vscode.window.tabGroups.close === 'function'
    ) {
      await vscode.window.tabGroups.close(tabs, true);
    }
    return tabs.length;
  }

  async showThreadInCodex(threadId, options = {}) {
    const extension = vscode.extensions.getExtension(CODEX_EXTENSION_ID);
    if (!extension) {
      throw new Error(`The official Codex extension ${CODEX_EXTENSION_ID} is not installed.`);
    }
    if (!extension.isActive) {
      await extension.activate();
    }
    await waitForCodexCommands(this.logger, {
      requiredCommands: [CODEX_OPEN_WITH_COMMAND]
    });

    if (options.refresh) {
      await this.closeActivationChatTabs(threadId);
    }
    const resumeOffset = getFileSize(this.codexLogPath);
    const threadUri = getActivationThreadUri(threadId);
    await vscode.commands.executeCommand(
      CODEX_OPEN_WITH_COMMAND,
      threadUri,
      CODEX_CONVERSATION_EDITOR_VIEW_TYPE,
      {
        preview: false,
        preserveFocus: false,
        viewColumn: vscode.ViewColumn.Active
      }
    );
    await waitForConversationResume(this.codexLogPath, threadId, {
      startOffset: resumeOffset,
      timeoutMs: 60 * 1000,
      pollIntervalMs: 250
    });
  }

  async clearArchivedChatFromView(threadId) {
    try {
      await this.closeActivationChatTabs(threadId);
    } catch (error) {
      if (this.logger) {
        this.logger.warn('Archived the activation chat but could not clear it from the Codex view.', {
          error: getErrorMessage(error)
        });
      }
    }
  }

  async waitForLimitConfirmation(profileId) {
    if (
      !this.rateLimitMonitor ||
      typeof this.rateLimitMonitor.refresh !== 'function'
    ) {
      return false;
    }

    const startedAt = Date.now();
    while (Date.now() - startedAt <= this.limitConfirmationTimeoutMs) {
      try {
        await this.rateLimitMonitor.refresh(true);
        const profile = await this.profileManager.getProfile(profileId);
        const status = getProfileRateStatus(profile, Date.now(), {
          activeProfileId: profileId
        });
        if (!status.windowNotStarted) {
          return true;
        }
      } catch (error) {
        if (this.logger) {
          this.logger.warn('Rate-limit confirmation refresh failed after a Codex answer.', {
            profileId,
            error: getErrorMessage(error)
          });
        }
      }
      await sleep(this.limitConfirmationPollMs);
    }
    return false;
  }

  async restoreOriginalAccount(job) {
    if (
      job.originalProfileId &&
      (await this.profileManager.getProfile(job.originalProfileId))
    ) {
      await this.profileManager.setActiveProfileId(job.originalProfileId, {
        transient: true,
        skipAuthBackup: true
      });
      return;
    }

    const authPath = getDefaultCodexAuthPath(this.logger);
    if (job.originalAuthBackupPath && fs.existsSync(job.originalAuthBackupPath)) {
      const authData = await loadAuthDataFromFile(
        job.originalAuthBackupPath,
        this.logger
      );
      if (!authData) {
        throw new Error('The original Codex auth backup is unreadable.');
      }
      syncCodexAuthFile(authPath, authData);
      await this.profileManager.initializeWindowActiveProfileFromCurrentAuth(true);
      return;
    }

    if (!job.originalHadAuthFile && fs.existsSync(authPath)) {
      fs.unlinkSync(authPath);
    }
    await this.profileManager.setActiveProfileId(undefined, {
      transient: true,
      skipAuthBackup: true
    });
  }

  async recordFailure(candidate, error) {
    const completedAt = Date.now();
    const rateLimit = await this.getRateLimitSnapshot(candidate.profileId);
    const activation =
      error && error.activationResult && typeof error.activationResult === 'object'
        ? error.activationResult
        : {};
    const activationState =
      asNonEmptyString(error && error.activationState) ||
      asNonEmptyString(activation.state);
    const accountStatus = [
      'needs-auth',
      'cancelled',
      'chat-closed',
      'conversation-not-created',
      'turn-failed',
      'turn-timeout',
      'empty-response',
      'ui-unavailable'
    ].includes(activationState)
      ? activationState
      : 'failed';
    return updateActivationJob(this.jobPath, (job) => {
      const startedAt = job.attemptStartedAt || completedAt;
      const failedPhase = job.phase;
      return {
        ...job,
        currentIndex: Math.min(job.candidates.length, job.currentIndex + 1),
        readyProfileId: null,
        attemptStartedAt: null,
        codexLogStartOffset: null,
        phase: 'advancing',
        accountResults: upsertAccountResult(job.accountResults, {
          profileId: candidate.profileId,
          profileName: candidate.profileName,
          status: accountStatus,
          startedAt,
          completedAt,
          durationMs: Math.max(0, completedAt - startedAt),
          failedPhase,
          error: getErrorMessage(error),
          prompt: ACTIVATION_FILE_TEXT,
          responseText: activation.responseText,
          responseLength: String(activation.responseText || '').length,
          threadId: activation.threadId,
          threadReused: activation.reused === true,
          archived: activation.archived === true,
          archiveError: activation.archiveError,
          limitConfirmed: false,
          rateLimit,
          diagnostics: activation.diagnostics
        }),
        events: [
          ...job.events,
          {
            at: completedAt,
            phase: accountStatus === 'needs-auth' ? 'account-needs-auth' : 'account-failed',
            profileId: candidate.profileId,
            profileName: candidate.profileName,
            detail: getErrorMessage(error)
          }
        ].slice(-MAX_REPORT_EVENTS),
        failed: [
          ...job.failed,
          {
            profileId: candidate.profileId,
            profileName: candidate.profileName,
            error: getErrorMessage(error)
          }
        ]
      };
    });
  }

  async processCandidate(candidate) {
    const mode = readActivationJob(this.jobPath).mode;
    let workspace;
    try {
      let activation;
      if (mode === ACTIVATION_MODE_VSCODE_EXTENSION) {
        this.updatePhase('opening-codex-panel');
        const cancellationJobPath = this.jobPath;
        const startupLogOffset = readActivationJob(this.jobPath).codexLogStartOffset;
        activation = await this.runCodexExtensionTurn({
          profile: {
            id: candidate.profileId,
            name: candidate.profileName
          },
          windowTitleToken: this.marker.windowTitleToken,
          startupLogOffset,
          cancellationToken: {
            get isCancellationRequested() {
              try {
                return readActivationJob(cancellationJobPath).cancelRequested;
              } catch {
                return false;
              }
            }
          },
          onState: (phase) => this.updatePhase(phase),
          onThreadReady: async () => {
            this.updatePhase('waiting-for-answer');
          },
          onResponseReady: async () => {
            this.updatePhase('showing-answer');
          }
        });
      } else {
        this.updatePhase('starting-app-server');
        workspace = this.createWorkspace();
        this.updatePhase('sending-test');
        activation = await this.runActivationTurn({
          profile: {
            id: candidate.profileId,
            name: candidate.profileName
          },
          existingThreadId: this.getThreadIds()[candidate.profileId],
          workspace,
          logger: this.logger,
          onThreadReady: async () => {
            this.updatePhase('waiting-for-answer');
          },
          onResponseReady: async () => {
            this.updatePhase('answer-received');
          }
        });
      }
      if (!activation || !asNonEmptyString(activation.threadId)) {
        throw new Error('Codex did not preserve the counter-activation chat.');
      }
      await this.setThreadId(candidate.profileId, activation.threadId);
      if (this.logger) {
        this.logger.info(
          'Codex counter-activation response completed.',
          {
            profileId: candidate.profileId,
            mode,
            archived: activation.archived === true,
            responseLength: String(activation.responseText || '').length
          }
        );
      }

      this.updatePhase('confirming-limit');
      const confirmed = await this.waitForLimitConfirmation(candidate.profileId);
      const completedAt = Date.now();
      const rateLimit = await this.getRateLimitSnapshot(candidate.profileId);
      if (this.logger) {
        this.logger.info('Codex counter activation finished for an account.', {
          profileId: candidate.profileId,
          limitConfirmed: confirmed
        });
      }
      updateActivationJob(this.jobPath, (job) => {
        const startedAt = job.attemptStartedAt || completedAt;
        return {
          ...job,
          currentIndex: Math.min(job.candidates.length, job.currentIndex + 1),
          readyProfileId: null,
          attemptStartedAt: null,
          codexLogStartOffset: null,
          phase: 'advancing',
          completedProfileIds: [
            ...job.completedProfileIds.filter((id) => id !== candidate.profileId),
            candidate.profileId
          ],
          unconfirmedProfileIds: confirmed
            ? job.unconfirmedProfileIds.filter((id) => id !== candidate.profileId)
            : [
                ...job.unconfirmedProfileIds.filter((id) => id !== candidate.profileId),
                candidate.profileId
              ],
          accountResults: upsertAccountResult(job.accountResults, {
            profileId: candidate.profileId,
            profileName: candidate.profileName,
            status: 'completed',
            startedAt,
            completedAt,
            durationMs: Math.max(0, completedAt - startedAt),
            prompt: ACTIVATION_FILE_TEXT,
            responseText: activation.responseText,
            responseLength: String(activation.responseText || '').length,
            threadId: activation.threadId,
            threadReused: activation.reused === true,
            archived: activation.archived === true,
            archiveError: activation.archiveError,
            limitConfirmed: confirmed,
            rateLimit,
            diagnostics: activation.diagnostics
          }),
          events: [
            ...job.events,
            {
              at: completedAt,
              phase: 'account-completed',
              profileId: candidate.profileId,
              profileName: candidate.profileName,
              detail: confirmed
                ? `${getActivationModeLabel(mode)}; Usage API confirmed the counter.`
                : `${getActivationModeLabel(mode)}; Usage API confirmation timed out.`
            }
          ].slice(-MAX_REPORT_EVENTS)
        };
      });
    } finally {
      if (workspace) {
        try {
          workspace.cleanup();
        } catch (error) {
          if (this.logger) {
            this.logger.warn('Failed to clean the counter-activation workspace.', {
              error: getErrorMessage(error)
            });
          }
        }
      }
    }
  }

  async switchAndReload(candidate) {
    this.updatePhase('switching-account', {
      attemptStartedAt: Date.now()
    });
    const switched = await this.profileManager.setActiveProfileId(candidate.profileId, {
      transient: true,
      skipAuthBackup: true
    });
    if (!switched) {
      throw new Error('Failed to switch the active Codex account.');
    }
    this.updatePhase('reloading', {
      readyProfileId: candidate.profileId,
      codexLogStartOffset: getFileSize(this.codexLogPath)
    });

    if (!this.reloadWindow) {
      return false;
    }
    void vscode.commands.executeCommand('workbench.action.reloadWindow');
    return true;
  }

  async finish(job) {
    this.updatePhase('restoring-original-account');
    const latest = readActivationJob(this.jobPath);
    await this.restoreOriginalAccount(latest);
    const succeeded = latest.completedProfileIds.length;
    const cancelled = latest.cancelRequested;
    const status = cancelled
      ? 'cancelled'
      : latest.failed.length === 0
        ? 'completed'
        : succeeded > 0
          ? 'partial'
          : 'failed';
    updateActivationJob(this.jobPath, (current) => ({
      ...current,
      status,
      phase: status,
      heartbeatAt: Date.now(),
      completedAt: Date.now(),
      originalAccountRestored: true,
      events: [
        ...current.events,
        {
          at: Date.now(),
          phase: status,
          detail: 'Original Codex account restored.'
        }
      ].slice(-MAX_REPORT_EVENTS)
    }));

    if (this.closeWindow) {
      setTimeout(() => {
        void vscode.commands.executeCommand('workbench.action.closeWindow');
      }, 750);
    }
  }

  async run() {
    const initialJob = readActivationJob(this.jobPath);
    this.validateJob(initialJob);
    if (TERMINAL_JOB_STATUSES.has(initialJob.status)) {
      return;
    }
    if (activeWorkerJobs.has(initialJob.jobId)) {
      return;
    }
    activeWorkerJobs.add(initialJob.jobId);

    const heartbeat = setInterval(() => {
      try {
        updateActivationJob(this.jobPath, (job) => ({
          ...job,
          heartbeatAt: Date.now()
        }));
      } catch {
        // The main worker path will report a useful error if the job becomes unreadable.
      }
    }, WORKER_HEARTBEAT_INTERVAL_MS);

    try {
      this.updatePhase('starting-worker');
      while (true) {
        const job = readActivationJob(this.jobPath);
        this.validateJob(job);
        if (job.cancelRequested || job.currentIndex >= job.candidates.length) {
          await this.finish(job);
          return;
        }

        const candidate = job.candidates[job.currentIndex];
        try {
          if (job.readyProfileId !== candidate.profileId) {
            const reloadRequested = await this.switchAndReload(candidate);
            if (reloadRequested) {
              return;
            }
          }

          const activeProfileId = await this.profileManager.getActiveProfileId();
          if (activeProfileId !== candidate.profileId) {
            throw new Error(
              'The dedicated VS Code window reloaded without the requested Codex account.'
            );
          }
          await this.processCandidate(candidate);
        } catch (error) {
          if (this.logger) {
            this.logger.warn('Failed to activate a Codex account in the dedicated window.', {
              profileId: candidate.profileId,
              error: getErrorMessage(error)
            });
          }
          await this.recordFailure(candidate, error);
        }
      }
    } catch (error) {
      let originalAccountRestored = false;
      try {
        const job = readActivationJob(this.jobPath);
        await this.restoreOriginalAccount(job);
        originalAccountRestored = true;
      } catch (restoreError) {
        if (this.logger) {
          this.logger.error('Failed to restore the original account after worker failure.', {
            error: getErrorMessage(restoreError)
          });
        }
      }
      updateActivationJob(this.jobPath, (job) => ({
        ...job,
        status: 'failed',
        phase: 'failed',
        heartbeatAt: Date.now(),
        completedAt: Date.now(),
        originalAccountRestored,
        lastError: getErrorMessage(error),
        events: [
          ...job.events,
          {
            at: Date.now(),
            phase: 'failed',
            detail: getErrorMessage(error)
          }
        ].slice(-MAX_REPORT_EVENTS)
      }));
      if (this.logger) {
        this.logger.error('Dedicated Codex counter-activation window failed.', {
          error: getErrorMessage(error)
        });
      }
    } finally {
      clearInterval(heartbeat);
      activeWorkerJobs.delete(initialJob.jobId);
    }
  }
}

function tryStartRateLimitActivationWindowWorker(
  context,
  profileManager,
  rateLimitMonitor,
  logger,
  options = {}
) {
  const extensionVersion =
    context &&
    context.extension &&
    context.extension.packageJSON &&
    context.extension.packageJSON.version;
  const marker = getCurrentWorkerMarker(profileManager, extensionVersion);
  if (!marker) {
    return false;
  }

  const worker = new RateLimitActivationWindowWorker(
    context,
    profileManager,
    rateLimitMonitor,
    logger,
    marker,
    options
  );
  void worker.run();
  return true;
}

module.exports = {
  ACTIVATION_JOB_VERSION,
  ACTIVATION_MODE_APP_SERVER,
  ACTIVATION_MODE_VSCODE_EXTENSION,
  ACTIVATION_WORKER_MARKER_FILENAME,
  RateLimitActivationWindowLauncher,
  RateLimitActivationWindowWorker,
  activationJobToResult,
  buildActivationReport,
  createCodeLaunchEnvironment,
  createReportEnvironment,
  getActiveRateLimitActivationJob,
  getActivationThreadUri,
  getActivationModeLabel,
  getActivationRoot,
  getActivationWorkerWindowArgs,
  getActivationWindowTitleToken,
  getCurrentWorkerMarker,
  getWorkerMarkerPath,
  getWorkerWorkspacePath,
  normalizeActivationJob,
  normalizeActivationMode,
  normalizeWorkerMarker,
  openActivationWorkerWindow,
  readActivationJob,
  resolveCodeExecutable,
  tryStartRateLimitActivationWindowWorker,
  updateActivationJob,
  writeWorkerMarker
};
