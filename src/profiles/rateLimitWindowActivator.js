'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { randomUUID } = require('crypto');
const { spawn, execFileSync } = require('child_process');
const vscode = require('vscode');
const {
  getDefaultCodexAuthPath,
  shouldUseWslAuthPath
} = require('./authManager');
const { syncCodexAuthFile } = require('./codexAuthSync');
const { getProfileRateStatus } = require('./profileStatus');
const { displayProfileName } = require('./privacy');
const { RateLimitRefreshCoordinator } = require('./rateLimitRefreshCoordinator');

const ACTIVATION_THREAD_IDS_KEY = 'codexSwitch.rateLimitActivationThreadIds';
const ACTIVATION_FILE_NAME = 'test.txt';
const ACTIVATION_FILE_TEXT = 'тест';
const CODEX_EXTENSION_ID = 'openai.chatgpt';
const APP_SERVER_REQUEST_TIMEOUT_MS = 30 * 1000;
const APP_SERVER_TURN_TIMEOUT_MS = 3 * 60 * 1000;
const ARCHIVE_RETRY_COUNT = 3;
const ARCHIVE_RETRY_DELAY_MS = 500;
const MAX_ACTIVATION_DIAGNOSTICS_LENGTH = 12 * 1024;

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

function quoteShellSingle(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sanitizeActivationDiagnostics(value) {
  return String(value || '')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(
      /("(?:access_token|refresh_token|id_token|token)"\s*:\s*")[^"]+(")/gi,
      '$1[redacted]$2'
    )
    .replace(/\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\b/g, '[redacted-jwt]')
    .slice(-MAX_ACTIVATION_DIAGNOSTICS_LENGTH);
}

function getBundledCodexPlatformDirectory() {
  const platform =
    process.platform === 'win32'
      ? 'windows'
      : process.platform === 'darwin'
        ? 'macos'
        : process.platform === 'linux'
          ? 'linux'
          : null;
  const architecture =
    process.arch === 'x64'
      ? 'x86_64'
      : process.arch === 'arm64'
        ? 'aarch64'
        : process.arch;
  return platform ? `${platform}-${architecture}` : null;
}

function findExecutableOnPath(commandName, env = process.env) {
  const pathValue = String((env && (env.PATH || env.Path)) || '');
  if (!pathValue) {
    return null;
  }

  const extensions =
    process.platform === 'win32'
      ? String((env && env.PATHEXT) || '.EXE;.CMD;.BAT;.COM')
          .split(';')
          .filter(Boolean)
      : [''];
  for (const directory of pathValue.split(path.delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = path.join(
        directory.replace(/^"(.*)"$/, '$1'),
        process.platform === 'win32' ? `${commandName}${extension.toLowerCase()}` : commandName
      );
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

function resolveLocalCodexExecutable(options = {}) {
  const extension =
    options.codexExtension ||
    (vscode.extensions && vscode.extensions.getExtension
      ? vscode.extensions.getExtension(CODEX_EXTENSION_ID)
      : null);
  const extensionPath = asNonEmptyString(extension && extension.extensionPath);
  const executableName = process.platform === 'win32' ? 'codex.exe' : 'codex';
  const platformDirectory = getBundledCodexPlatformDirectory();
  const candidates = [];

  if (extensionPath && platformDirectory) {
    candidates.push(
      path.join(extensionPath, 'bin', platformDirectory, executableName)
    );
  }

  if (extensionPath) {
    const binDirectory = path.join(extensionPath, 'bin');
    try {
      for (const entry of fs.readdirSync(binDirectory, { withFileTypes: true })) {
        if (!entry.isDirectory()) {
          continue;
        }
        candidates.push(path.join(binDirectory, entry.name, executableName));
      }
    } catch {
      // Fall through to PATH lookup and the actionable error below.
    }
  }

  const bundledExecutable = candidates.find((candidate) => fs.existsSync(candidate));
  if (bundledExecutable) {
    return bundledExecutable;
  }

  const pathExecutable = findExecutableOnPath('codex', options.env || process.env);
  if (pathExecutable) {
    return pathExecutable;
  }

  throw new Error(
    'Codex CLI was not found. Reinstall or enable the official OpenAI Codex extension, then retry.'
  );
}

function createActivationWorkspace() {
  if (shouldUseWslAuthPath()) {
    const linuxDirectory = String(
      execFileSync(
        'wsl.exe',
        ['sh', '-lc', 'mktemp -d /tmp/codex-multitool-counter-activation.XXXXXX'],
        { encoding: 'utf8', windowsHide: true }
      )
    ).trim();
    if (!linuxDirectory.startsWith('/tmp/codex-multitool-counter-activation.')) {
      throw new Error(`Unexpected WSL activation directory: ${linuxDirectory}`);
    }
    const windowsDirectory = String(
      execFileSync(
        'wsl.exe',
        ['sh', '-lc', `wslpath -w ${quoteShellSingle(linuxDirectory)}`],
        { encoding: 'utf8', windowsHide: true }
      )
    ).trim();
    const windowsFilePath = path.join(windowsDirectory, ACTIVATION_FILE_NAME);
    const linuxFilePath = `${linuxDirectory}/${ACTIVATION_FILE_NAME}`;
    fs.writeFileSync(windowsFilePath, ACTIVATION_FILE_TEXT, 'utf8');
    return {
      cwd: linuxDirectory,
      filePath: linuxFilePath,
      localFilePath: windowsFilePath,
      runtime: {
        command: 'wsl.exe',
        args: ['sh', '-lc', 'codex app-server --stdio'],
        env: process.env
      },
      cleanup() {
        execFileSync(
          'wsl.exe',
          [
            'sh',
            '-lc',
            `case ${quoteShellSingle(linuxDirectory)} in /tmp/codex-multitool-counter-activation.*) rm -rf -- ${quoteShellSingle(linuxDirectory)} ;; *) exit 2 ;; esac`
          ],
          { windowsHide: true }
        );
      }
    };
  }

  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'codex-multitool-counter-activation-')
  );
  const filePath = path.join(directory, ACTIVATION_FILE_NAME);
  fs.writeFileSync(filePath, ACTIVATION_FILE_TEXT, 'utf8');
  return {
    cwd: directory,
    filePath,
    localFilePath: filePath,
    runtime: {
      command: resolveLocalCodexExecutable(),
      args: ['app-server', '--stdio'],
      env: process.env
    },
    cleanup() {
      const resolved = path.resolve(directory);
      const tempRoot = path.resolve(os.tmpdir());
      if (!resolved.startsWith(`${tempRoot}${path.sep}`)) {
        throw new Error(`Refusing to clean unexpected activation directory: ${resolved}`);
      }
      fs.rmSync(resolved, { recursive: true, force: true });
    }
  };
}

function buildActivationTurnInput(filePath) {
  return [
    {
      type: 'text',
      text: ACTIVATION_FILE_TEXT
    }
  ];
}

function getUnstartedProfiles(profiles, activeProfileId, now = Date.now()) {
  return (profiles || []).filter((profile) => {
    const status = getProfileRateStatus(profile, now, { activeProfileId });
    return status.windowNotStarted === true;
  });
}

class CodexAppServerConnection {
  constructor(runtime, logger, options = {}) {
    this.runtime = runtime;
    this.logger = logger;
    this.requestTimeoutMs =
      Number(options.requestTimeoutMs) || APP_SERVER_REQUEST_TIMEOUT_MS;
    this.turnTimeoutMs = Number(options.turnTimeoutMs) || APP_SERVER_TURN_TIMEOUT_MS;
    this.child = null;
    this.stdoutBuffer = '';
    this.stderrBuffer = '';
    this.nextRequestId = 1;
    this.pendingRequests = new Map();
    this.turnWaiters = new Map();
    this.closed = false;
  }

  async start() {
    this.child = spawn(this.runtime.command, this.runtime.args, {
      env: this.runtime.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    });
    this.child.stdout.on('data', (chunk) => this.handleStdout(chunk));
    this.child.stderr.on('data', (chunk) => {
      this.stderrBuffer += chunk.toString('utf8');
      if (this.stderrBuffer.length > 8000) {
        this.stderrBuffer = this.stderrBuffer.slice(-8000);
      }
    });
    this.child.on('error', (error) => this.failAll(error));
    this.child.on('exit', (code, signal) => {
      if (!this.closed) {
        this.failAll(
          new Error(`Codex app-server exited unexpectedly: code=${code} signal=${signal}`)
        );
      }
    });

    await this.request('initialize', {
      protocolVersion: '2',
      capabilities: {},
      clientInfo: {
        name: 'codex-multitool-counter-activation',
        title: 'Codex Multitool counter activation',
        version: '1.0.0'
      }
    });
    this.notify('initialized', {});
  }

  handleStdout(chunk) {
    this.stdoutBuffer += chunk.toString('utf8');
    let newlineIndex = this.stdoutBuffer.indexOf('\n');
    while (newlineIndex !== -1) {
      const line = this.stdoutBuffer.slice(0, newlineIndex).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      newlineIndex = this.stdoutBuffer.indexOf('\n');
      if (!line) {
        continue;
      }

      let message;
      try {
        message = JSON.parse(line);
      } catch (error) {
        if (this.logger) {
          this.logger.warn('Ignored unreadable counter-activation app-server output.', {
            error: getErrorMessage(error)
          });
        }
        continue;
      }
      this.handleMessage(message);
    }
  }

  handleMessage(message) {
    if (message && message.id != null && this.pendingRequests.has(message.id)) {
      const pending = this.pendingRequests.get(message.id);
      this.pendingRequests.delete(message.id);
      clearTimeout(pending.timeout);
      if (message.error) {
        pending.reject(
          new Error(
            message.error && message.error.message
              ? message.error.message
              : JSON.stringify(message.error)
          )
        );
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (message && message.method === 'turn/completed') {
      const threadId = asNonEmptyString(message.params && message.params.threadId);
      const waiter = threadId && this.turnWaiters.get(threadId);
      if (waiter) {
        this.turnWaiters.delete(threadId);
        clearTimeout(waiter.timeout);
        if (waiter.cancellationDisposable) {
          waiter.cancellationDisposable.dispose();
        }
        waiter.resolve({
          ...(message.params && message.params.turn),
          agentMessageText: waiter.agentMessageText.trim()
        });
      }
      return;
    }

    if (
      message &&
      (message.method === 'item/agentMessage/delta' ||
        message.method === 'item/completed')
    ) {
      const params = message.params || {};
      const threadId = asNonEmptyString(params.threadId);
      const waiter = threadId && this.turnWaiters.get(threadId);
      if (!waiter) {
        return;
      }

      if (message.method === 'item/agentMessage/delta') {
        if (typeof params.delta === 'string') {
          waiter.agentMessageText += params.delta;
        }
        return;
      }

      const item = params.item;
      if (
        item &&
        item.type === 'agentMessage' &&
        typeof item.text === 'string' &&
        item.text.trim()
      ) {
        waiter.agentMessageText = item.text;
      }
      return;
    }

    if (message && message.id != null && message.method) {
      this.write({
        id: message.id,
        error: {
          code: -32601,
          message: `Unsupported request during counter activation: ${message.method}`
        }
      });
    }
  }

  write(message) {
    if (this.closed || !this.child || !this.child.stdin.writable) {
      throw new Error('Codex app-server connection is closed.');
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`, 'utf8');
  }

  notify(method, params) {
    this.write({ method, params });
  }

  request(method, params) {
    if (this.closed) {
      return Promise.reject(new Error('Codex app-server connection is closed.'));
    }
    const id = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Codex app-server request timed out: ${method}`));
      }, this.requestTimeoutMs);
      this.pendingRequests.set(id, { resolve, reject, timeout, method });
      try {
        this.write({ id, method, params });
      } catch (error) {
        clearTimeout(timeout);
        this.pendingRequests.delete(id);
        reject(error);
      }
    });
  }

  waitForTurn(threadId, cancellationToken) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.turnWaiters.delete(threadId);
        reject(new Error('Codex counter-activation turn timed out.'));
      }, this.turnTimeoutMs);
      const cancellationDisposable =
        cancellationToken &&
        typeof cancellationToken.onCancellationRequested === 'function'
          ? cancellationToken.onCancellationRequested(() => {
              this.turnWaiters.delete(threadId);
              clearTimeout(timeout);
              reject(new Error('Codex counter activation was cancelled.'));
            })
          : null;
      this.turnWaiters.set(threadId, {
        resolve,
        reject,
        timeout,
        cancellationDisposable,
        agentMessageText: ''
      });
    });
  }

  async startTurn(threadId, input, cwd, cancellationToken, onStarted) {
    const completion = this.waitForTurn(threadId, cancellationToken);
    let completedTurn = null;
    let completionError = null;
    const guardedCompletion = completion.then(
      (turn) => {
        completedTurn = turn;
      },
      (error) => {
        completionError = error;
      }
    );
    try {
      await this.request('turn/start', {
        threadId,
        cwd,
        approvalPolicy: 'never',
        sandboxPolicy: {
          type: 'readOnly',
          networkAccess: false
        },
        effort: 'low',
        input
      });
    } catch (error) {
      const waiter = this.turnWaiters.get(threadId);
      if (waiter) {
        this.turnWaiters.delete(threadId);
        clearTimeout(waiter.timeout);
        if (waiter.cancellationDisposable) {
          waiter.cancellationDisposable.dispose();
        }
      }
      throw error;
    }

    let visibilityError = null;
    if (typeof onStarted === 'function') {
      try {
        await onStarted(threadId);
      } catch (error) {
        visibilityError = error;
      }
    }

    await guardedCompletion;
    if (completionError) {
      throw completionError;
    }
    if (visibilityError) {
      throw visibilityError;
    }
    return completedTurn;
  }

  failAll(error) {
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pendingRequests.clear();
    for (const waiter of this.turnWaiters.values()) {
      clearTimeout(waiter.timeout);
      if (waiter.cancellationDisposable) {
        waiter.cancellationDisposable.dispose();
      }
      waiter.reject(error);
    }
    this.turnWaiters.clear();
  }

  async close() {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.failAll(new Error('Codex app-server connection closed.'));
    const child = this.child;
    let exited = Promise.resolve();
    if (child && child.exitCode == null && child.signalCode == null) {
      exited = new Promise((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(timeout);
          resolve();
        };
        const timeout = setTimeout(finish, 2 * 1000);
        child.once('exit', finish);
      });
      try {
        child.kill();
      } catch {
        // Ignore process cleanup failures.
      }
    }
    await exited;
    if (this.logger && this.stderrBuffer.trim()) {
      this.logger.debug('Counter-activation app-server diagnostics.', {
        stderr: this.stderrBuffer
      });
    }
  }
}

async function openActivationThread(connection, existingThreadId, workspace) {
  let threadId = asNonEmptyString(existingThreadId);
  let reused = false;

  if (threadId) {
    try {
      await connection.request('thread/unarchive', { threadId });
    } catch {
      // The thread may already be unarchived. thread/resume below is authoritative.
    }
    try {
      const resumed = await connection.request('thread/resume', {
        threadId,
        cwd: workspace.cwd,
        approvalPolicy: 'never',
        sandbox: 'read-only'
      });
      const resumedThreadId = asNonEmptyString(
        resumed && resumed.thread && resumed.thread.id
      );
      if (resumedThreadId) {
        threadId = resumedThreadId;
        reused = true;
      } else {
        threadId = null;
      }
    } catch {
      threadId = null;
    }
  }

  if (!threadId) {
    const started = await connection.request('thread/start', {
      cwd: workspace.cwd,
      approvalPolicy: 'never',
      sandbox: 'read-only',
      ephemeral: false,
      developerInstructions:
        'This is a dedicated Codex Multitool rate-limit activation chat. Do not run tools or modify files. Reply as briefly as possible.'
    });
    threadId = asNonEmptyString(started && started.thread && started.thread.id);
    if (!threadId) {
      throw new Error('Codex did not return a thread id for counter activation.');
    }
  }

  return { threadId, reused };
}

async function runActivationTurn(options) {
  const connection =
    options.connection ||
    new CodexAppServerConnection(
      options.workspace.runtime,
      options.logger,
      options.connectionOptions
    );
  let threadId = null;
  let reused = false;
  let archiveError = null;
  let turnError = null;
  let responseText = '';
  try {
    await connection.start();
    const thread = await openActivationThread(
      connection,
      options.existingThreadId,
      options.workspace
    );
    threadId = thread.threadId;
    reused = thread.reused;
    const turn = await connection.startTurn(
      threadId,
      buildActivationTurnInput(options.workspace.filePath),
      options.workspace.cwd,
      options.cancellationToken,
      options.onThreadReady
    );
    if (!turn || turn.status !== 'completed') {
      const detail =
        turn && turn.error && turn.error.message
          ? `: ${turn.error.message}`
          : '';
      throw new Error(`Codex counter-activation turn did not complete${detail}`);
    }
    responseText = asNonEmptyString(turn.agentMessageText) || '';
    if (!responseText) {
      throw new Error('Codex completed the activation turn without an assistant response.');
    }
    if (typeof options.onResponseReady === 'function') {
      await options.onResponseReady(threadId, responseText);
    }
  } catch (error) {
    turnError = error;
  } finally {
    if (threadId) {
      for (let attempt = 1; attempt <= ARCHIVE_RETRY_COUNT; attempt += 1) {
        try {
          await connection.request('thread/archive', { threadId });
          archiveError = null;
          break;
        } catch (error) {
          archiveError = getErrorMessage(error);
          if (attempt < ARCHIVE_RETRY_COUNT) {
            await sleep(ARCHIVE_RETRY_DELAY_MS);
          }
        }
      }
    }
    await connection.close();
  }

  const activationResult = {
    threadId,
    reused,
    archived: Boolean(threadId && !archiveError),
    archiveError,
    responseText,
    diagnostics: sanitizeActivationDiagnostics(connection.stderrBuffer)
  };

  if (turnError) {
    let resultError =
      turnError instanceof Error
        ? turnError
        : new Error(getErrorMessage(turnError));
    if (archiveError) {
      resultError = new Error(
        `${getErrorMessage(turnError)} Chat archival also failed: ${archiveError}`
      );
    }
    resultError.activationResult = activationResult;
    throw resultError;
  }
  if (archiveError) {
    const resultError = new Error(
      `Codex answered, but the activation chat could not be archived: ${archiveError}`
    );
    resultError.activationResult = activationResult;
    throw resultError;
  }

  return activationResult;
}

class RateLimitWindowActivator {
  constructor(context, profileManager, rateLimitMonitor, logger, options = {}) {
    this.context = context;
    this.profileManager = profileManager;
    this.rateLimitMonitor = rateLimitMonitor;
    this.logger = logger;
    this.runActivationTurn = options.runActivationTurn || runActivationTurn;
    this.createWorkspace = options.createWorkspace || createActivationWorkspace;
    this.coordinator =
      options.coordinator ||
      (typeof profileManager.getStorageDir === 'function'
        ? new RateLimitRefreshCoordinator(
            () => profileManager.getStorageDir(),
            `counter-activation-${randomUUID()}`,
            logger
          )
        : null);
    this.running = false;
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

  async restoreOriginalAccount(originalProfileId, originalAuthData, hadAuthFile) {
    if (originalProfileId && (await this.profileManager.getProfile(originalProfileId))) {
      await this.profileManager.setActiveProfileId(originalProfileId, { transient: true });
      return;
    }

    const authPath = getDefaultCodexAuthPath(this.logger);
    if (originalAuthData) {
      syncCodexAuthFile(authPath, originalAuthData);
      if (
        typeof this.profileManager.initializeWindowActiveProfileFromCurrentAuth ===
        'function'
      ) {
        await this.profileManager.initializeWindowActiveProfileFromCurrentAuth(true);
      }
      return;
    }

    if (!hadAuthFile && fs.existsSync(authPath)) {
      fs.unlinkSync(authPath);
    }
    await this.profileManager.setActiveProfileId(undefined, { transient: true });
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
    const claim = this.coordinator
      ? this.coordinator.claim('all-unstarted-counters', {
          leaseTimeoutMs: 15 * 60 * 1000,
          minimumFreshMs: 0,
          failureBackoffMs: 0
        })
      : null;
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
    let candidates;
    try {
      originalProfileId = await this.profileManager.getActiveProfileId();
      originalAuthData =
        typeof this.profileManager.loadCurrentAuthData === 'function'
          ? await this.profileManager.loadCurrentAuthData()
          : null;
      const authPath = getDefaultCodexAuthPath(this.logger);
      hadAuthFile = fs.existsSync(authPath);
      const profiles = await this.profileManager.listProfiles();
      candidates = getUnstartedProfiles(profiles, originalProfileId);
    } catch (error) {
      if (this.coordinator) {
        this.coordinator.complete('all-unstarted-counters', claim, false);
      }
      this.running = false;
      throw error;
    }
    const result = {
      started: true,
      reason: candidates.length ? 'completed' : 'no-candidates',
      attempted: candidates.length,
      succeeded: 0,
      failed: [],
      cancelled: false
    };
    if (candidates.length === 0) {
      if (this.coordinator) {
        this.coordinator.complete('all-unstarted-counters', claim, true);
      }
      this.running = false;
      return result;
    }
    let workspace;
    try {
      workspace = this.createWorkspace();
    } catch (error) {
      if (this.coordinator) {
        this.coordinator.complete('all-unstarted-counters', claim, false);
      }
      this.running = false;
      throw error;
    }

    try {
      for (let index = 0; index < candidates.length; index += 1) {
        const profile = candidates[index];
        if (options.cancellationToken && options.cancellationToken.isCancellationRequested) {
          result.cancelled = true;
          result.reason = 'cancelled';
          break;
        }

        if (typeof options.onProgress === 'function') {
          options.onProgress({
            profile,
            index,
            total: candidates.length,
            increment: candidates.length ? 100 / candidates.length : 100
          });
        }

        try {
          const authData = await this.profileManager.loadAuthData(profile.id);
          if (!authData) {
            throw new Error('Saved Codex credentials are unavailable.');
          }
          const switched = await this.profileManager.setActiveProfileId(profile.id, {
            transient: true
          });
          if (!switched) {
            throw new Error('Failed to switch the active Codex account.');
          }

          const activation = await this.runActivationTurn({
            profile,
            authData,
            existingThreadId: this.getThreadIds()[profile.id],
            workspace,
            logger: this.logger,
            cancellationToken: options.cancellationToken
          });
          if (!activation || !asNonEmptyString(activation.threadId)) {
            throw new Error('Codex did not preserve the counter-activation chat.');
          }
          await this.setThreadId(profile.id, activation.threadId);
          result.succeeded += 1;

          if (activation.archiveError && this.logger) {
            this.logger.warn('The counter-activation chat could not be archived.', {
              profileId: profile.id,
              threadId: activation.threadId,
              error: activation.archiveError
            });
          }

          if (
            this.rateLimitMonitor &&
            typeof this.rateLimitMonitor.refresh === 'function'
          ) {
            await this.rateLimitMonitor.refresh(true);
          }
        } catch (error) {
          result.failed.push({
            profileId: profile.id,
            profileName: displayProfileName(profile),
            error: getErrorMessage(error)
          });
          if (this.logger) {
            this.logger.warn('Failed to activate a Codex account rate-limit window.', {
              profileId: profile.id,
              error: getErrorMessage(error)
            });
          }
        }
      }
    } finally {
      try {
        await this.restoreOriginalAccount(
          originalProfileId,
          originalAuthData,
          hadAuthFile
        );
      } finally {
        try {
          workspace.cleanup();
        } catch (error) {
          if (this.logger) {
            this.logger.warn('Failed to clean the counter-activation test file.', {
              error: getErrorMessage(error)
            });
          }
        }
        this.running = false;
        if (this.coordinator) {
          this.coordinator.complete(
            'all-unstarted-counters',
            claim,
            result.failed.length === 0 && !result.cancelled
          );
        }
      }
    }

    if (result.failed.length > 0 && result.succeeded === 0) {
      result.reason = 'failed';
    } else if (result.failed.length > 0) {
      result.reason = 'partial';
    }
    return result;
  }
}

module.exports = {
  ACTIVATION_FILE_NAME,
  ACTIVATION_FILE_TEXT,
  ACTIVATION_THREAD_IDS_KEY,
  CodexAppServerConnection,
  RateLimitWindowActivator,
  buildActivationTurnInput,
  createActivationWorkspace,
  findExecutableOnPath,
  getUnstartedProfiles,
  openActivationThread,
  resolveLocalCodexExecutable,
  runActivationTurn,
  sanitizeActivationDiagnostics
};
