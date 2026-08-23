'use strict';

const fs = require('fs');
const path = require('path');
const vscode = require('vscode');
const {
  getDefaultCodexAuthPath
} = require('./authManager');
const {
  waitForCodexCommands
} = require('../codex/CodexPostSwitchWarmup');
const {
  getFileSize
} = require('../codex/CodexSidebarConversation');
const {
  focusWorkerWindow,
  sendTextAndEnterToWorkerWindow
} = require('../native/windows/CodexWorkerWindowInput');

const CODEX_EXTENSION_ID = 'openai.chatgpt';
const CODEX_NEW_PANEL_COMMAND = 'chatgpt.newCodexPanel';
const CODEX_CONVERSATION_EDITOR_VIEW_TYPE = 'chatgpt.conversationEditor';
const ACTIVATION_PROMPT = 'тест';
const DEFAULT_UI_READY_TIMEOUT_MS = 60 * 1000;
const DEFAULT_CONVERSATION_TIMEOUT_MS = 90 * 1000;
const DEFAULT_TURN_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_POLL_INTERVAL_MS = 250;
const MAX_SESSION_READ_BYTES = 8 * 1024 * 1024;
const UUID_PATTERN =
  '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}';
const CONVERSATION_CREATED_PATTERN = new RegExp(
  `Conversation created conversationId=(${UUID_PATTERN})`
);
const UI_READY_PATTERNS = [
  /\[startup\]\[renderer\] app routes mounted/i
];
const AUTH_REQUIRED_PATTERNS = [
  /token_revoked/i,
  /invalidated oauth token/i,
  /refresh token (?:was|has been) revoked/i,
  /access token could not be refreshed/i,
  /session has ended\. Please log in again/i,
  /Failed to refresh token:\s*401/i,
  /auth error code:\s*(?:token_revoked|unauthorized|invalid_grant)/i,
  /not logged in/i,
  /login required/i,
  /please (?:log in|sign in) again/i,
  /active credentials don't match the configured restrictions/i,
  /forced_(?:login_method|chatgpt_workspace_id)/i,
  /workspace[^\r\n]{0,100}(?:not allowed|does not match|mismatch)/i
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function asNonEmptyString(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const normalized = value.trim();
  return normalized || null;
}

function getErrorMessage(error) {
  if (error && typeof error === 'object' && typeof error.message === 'string') {
    return error.message;
  }
  return typeof error === 'string' ? error : JSON.stringify(error);
}

function createActivationError(message, state, cause) {
  const error = new Error(message);
  error.code = state === 'needs-auth'
    ? 'codex-auth-required'
    : `codex-extension-${state || 'failed'}`;
  error.activationState = state || 'failed';
  if (cause !== undefined) {
    error.cause = cause;
  }
  return error;
}

function attachDiagnostics(error, diagnostics) {
  error.diagnostics = safeLogDiagnostics(diagnostics);
  return error;
}

function isCancellationRequested(token) {
  return Boolean(token && token.isCancellationRequested);
}

function throwIfCancelled(token) {
  if (isCancellationRequested(token)) {
    throw createActivationError(
      'Codex counter activation was cancelled.',
      'cancelled'
    );
  }
}

function isAuthRequiredText(value) {
  const text = String(value || '');
  return AUTH_REQUIRED_PATTERNS.some((pattern) => pattern.test(text));
}

function isUiReadyText(value) {
  const text = String(value || '');
  return UI_READY_PATTERNS.some((pattern) => pattern.test(text));
}

function readLogChunk(logPath, startOffset) {
  if (!logPath || !fs.existsSync(logPath)) {
    return { text: '', offset: 0 };
  }
  const size = getFileSize(logPath);
  const safeStart = size >= startOffset ? startOffset : 0;
  if (size <= safeStart) {
    return { text: '', offset: safeStart };
  }
  const length = size - safeStart;
  const descriptor = fs.openSync(logPath, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const bytesRead = fs.readSync(descriptor, buffer, 0, length, safeStart);
    return {
      text: buffer.subarray(0, bytesRead).toString('utf8'),
      offset: safeStart + bytesRead
    };
  } finally {
    fs.closeSync(descriptor);
  }
}

function safeLogDiagnostics(value) {
  return String(value || '')
    .split(/\r?\n/)
    .filter((line) =>
      isAuthRequiredText(line) ||
      isUiReadyText(line) ||
      /Conversation created conversationId=/i.test(line) ||
      /Request failed conversationId=/i.test(line)
    )
    .map((line) =>
      line
        .replace(/(access|refresh|id)[_-]?token\s*[=:]\s*[^\s,}\]]+/gi, '$1_token=[redacted]')
        .slice(0, 2000)
    )
    .slice(-20)
    .join('\n');
}

async function waitForUiReady(logPath, startOffset, options = {}) {
  const timeoutMs = Math.max(
    1000,
    Number(options.timeoutMs) || DEFAULT_UI_READY_TIMEOUT_MS
  );
  const pollIntervalMs = Math.max(
    50,
    Number(options.pollIntervalMs) || DEFAULT_POLL_INTERVAL_MS
  );
  const startedAt = Date.now();
  let offset = Math.max(0, Number(startOffset) || 0);
  let diagnostics = '';

  while (Date.now() - startedAt <= timeoutMs) {
    throwIfCancelled(options.cancellationToken);
    const chunk = readLogChunk(logPath, offset);
    offset = chunk.offset;
    diagnostics = [diagnostics, safeLogDiagnostics(chunk.text)]
      .filter(Boolean)
      .join('\n')
      .slice(-12 * 1024);
    if (isAuthRequiredText(chunk.text)) {
      throw attachDiagnostics(
        createActivationError(
          'The selected Codex account is signed out or its server session was revoked. Sign in again before activating its counter.',
          'needs-auth'
        ),
        diagnostics
      );
    }
    if (isUiReadyText(chunk.text)) {
      return { offset, diagnostics };
    }
    await sleep(pollIntervalMs);
  }
  throw createActivationError(
    'The official Codex extension did not finish opening its chat UI.',
    'ui-unavailable'
  );
}

function getCodexPanelTabs() {
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
        input.uri.scheme === 'openai-codex'
      ) {
        tabs.push(tab);
      }
    }
  }
  return tabs;
}

function isTabOpen(tab) {
  return getCodexPanelTabs().includes(tab);
}

async function openNewCodexPanel(options = {}) {
  const before = new Set(getCodexPanelTabs());
  await vscode.commands.executeCommand(CODEX_NEW_PANEL_COMMAND);
  const timeoutMs = Math.max(1000, Number(options.timeoutMs) || 15 * 1000);
  const startedAt = Date.now();
  while (Date.now() - startedAt <= timeoutMs) {
    throwIfCancelled(options.cancellationToken);
    const tabs = getCodexPanelTabs();
    const created = tabs.find((tab) => !before.has(tab));
    if (created) {
      return created;
    }
    await sleep(DEFAULT_POLL_INTERVAL_MS);
  }
  throw createActivationError(
    'The official Codex extension did not open a conversation editor tab.',
    'chat-closed'
  );
}

async function closeCodexPanelTab(tab) {
  if (
    tab &&
    isTabOpen(tab) &&
    vscode.window.tabGroups &&
    typeof vscode.window.tabGroups.close === 'function'
  ) {
    await vscode.window.tabGroups.close([tab], true);
    return true;
  }
  return false;
}

async function waitForConversationCreated(logPath, startOffset, tab, options = {}) {
  const timeoutMs = Math.max(
    1000,
    Number(options.timeoutMs) || DEFAULT_CONVERSATION_TIMEOUT_MS
  );
  const pollIntervalMs = Math.max(
    50,
    Number(options.pollIntervalMs) || DEFAULT_POLL_INTERVAL_MS
  );
  const startedAt = Date.now();
  let offset = Math.max(0, Number(startOffset) || 0);
  let diagnostics = '';

  while (Date.now() - startedAt <= timeoutMs) {
    throwIfCancelled(options.cancellationToken);
    if (tab && !isTabOpen(tab)) {
      throw createActivationError(
        'The Codex activation chat closed before a conversation was created.',
        'chat-closed'
      );
    }
    const chunk = readLogChunk(logPath, offset);
    offset = chunk.offset;
    diagnostics = [diagnostics, safeLogDiagnostics(chunk.text)]
      .filter(Boolean)
      .join('\n')
      .slice(-12 * 1024);
    if (isAuthRequiredText(chunk.text)) {
      throw attachDiagnostics(
        createActivationError(
          'The selected Codex account was logged out by the server while the activation chat was starting.',
          'needs-auth'
        ),
        diagnostics
      );
    }
    const match = CONVERSATION_CREATED_PATTERN.exec(chunk.text);
    if (match) {
      return { threadId: match[1], offset, diagnostics };
    }
    await sleep(pollIntervalMs);
  }
  throw createActivationError(
    'Codex did not create a conversation after the activation prompt was submitted. The account may be signed out, or the composer did not receive focus.',
    'conversation-not-created'
  );
}

function findThreadSessionFile(sessionsRoot, threadId) {
  if (!sessionsRoot || !threadId || !fs.existsSync(sessionsRoot)) {
    return null;
  }
  const pending = [sessionsRoot];
  while (pending.length) {
    const directory = pending.pop();
    let entries;
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    // Directories are pushed onto a LIFO stack, so ascending insertion visits the
    // newest year/month/day first. Activation threads are normally in today's folder.
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(entryPath);
      } else if (
        entry.isFile() &&
        entry.name.startsWith('rollout-') &&
        entry.name.endsWith('.jsonl') &&
        entry.name.includes(threadId)
      ) {
        return entryPath;
      }
    }
  }
  return null;
}

function extractAssistantTextFromResponseItem(payload) {
  if (
    !payload ||
    payload.type !== 'message' ||
    payload.role !== 'assistant' ||
    !Array.isArray(payload.content)
  ) {
    return null;
  }
  const text = payload.content
    .map((part) =>
      part && typeof part === 'object'
        ? asNonEmptyString(part.text) || asNonEmptyString(part.output_text)
        : null
    )
    .filter(Boolean)
    .join('\n');
  return asNonEmptyString(text);
}

function readOfficialTurnState(sessionPath) {
  if (!sessionPath || !fs.existsSync(sessionPath)) {
    return { completed: false };
  }
  let content;
  try {
    const size = fs.statSync(sessionPath).size;
    const start = Math.max(0, size - MAX_SESSION_READ_BYTES);
    const descriptor = fs.openSync(sessionPath, 'r');
    try {
      const buffer = Buffer.alloc(size - start);
      const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, start);
      content = buffer.subarray(0, bytesRead).toString('utf8');
      if (start > 0) {
        content = content.slice(Math.max(0, content.indexOf('\n') + 1));
      }
    } finally {
      fs.closeSync(descriptor);
    }
  } catch {
    return { completed: false };
  }

  let latestTaskStarted = null;
  let latestAssistantText = null;
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    const payload = record && record.payload;
    if (!payload || typeof payload !== 'object') {
      continue;
    }
    if (record.type === 'event_msg' && payload.type === 'task_started') {
      latestTaskStarted = asNonEmptyString(payload.turn_id);
      latestAssistantText = null;
      continue;
    }
    if (
      record.type === 'event_msg' &&
      payload.type === 'agent_message' &&
      (payload.phase === 'final_answer' || !payload.phase)
    ) {
      latestAssistantText = asNonEmptyString(payload.message) || latestAssistantText;
      continue;
    }
    if (record.type === 'response_item') {
      latestAssistantText =
        extractAssistantTextFromResponseItem(payload) || latestAssistantText;
      continue;
    }
    if (
      record.type === 'event_msg' &&
      payload.type === 'task_complete' &&
      (!latestTaskStarted || !payload.turn_id || payload.turn_id === latestTaskStarted)
    ) {
      const errorText = payload.error ? getErrorMessage(payload.error) : null;
      const responseText =
        asNonEmptyString(payload.last_agent_message) || latestAssistantText;
      return {
        completed: true,
        turnId: asNonEmptyString(payload.turn_id) || latestTaskStarted,
        responseText,
        error: asNonEmptyString(errorText)
      };
    }
  }
  return { completed: false, turnId: latestTaskStarted };
}

async function waitForOfficialTurnCompletion(
  sessionsRoot,
  threadId,
  logPath,
  startLogOffset,
  tab,
  options = {}
) {
  const timeoutMs = Math.max(
    1000,
    Number(options.timeoutMs) || DEFAULT_TURN_TIMEOUT_MS
  );
  const pollIntervalMs = Math.max(
    50,
    Number(options.pollIntervalMs) || DEFAULT_POLL_INTERVAL_MS
  );
  const startedAt = Date.now();
  let sessionPath = null;
  let logOffset = Math.max(0, Number(startLogOffset) || 0);
  let diagnostics = '';

  while (Date.now() - startedAt <= timeoutMs) {
    throwIfCancelled(options.cancellationToken);
    if (tab && !isTabOpen(tab)) {
      throw createActivationError(
        'The Codex activation chat closed before the assistant finished responding.',
        'chat-closed'
      );
    }
    const chunk = readLogChunk(logPath, logOffset);
    logOffset = chunk.offset;
    diagnostics = [diagnostics, safeLogDiagnostics(chunk.text)]
      .filter(Boolean)
      .join('\n')
      .slice(-12 * 1024);
    if (isAuthRequiredText(chunk.text)) {
      throw attachDiagnostics(
        createActivationError(
          'The selected Codex account was logged out by the server while waiting for the activation response.',
          'needs-auth'
        ),
        diagnostics
      );
    }

    sessionPath = sessionPath || findThreadSessionFile(sessionsRoot, threadId);
    const state = readOfficialTurnState(sessionPath);
    if (state.completed) {
      if (state.error) {
        throw createActivationError(
          isAuthRequiredText(state.error)
            ? 'The selected Codex account needs to sign in again.'
            : `The official Codex extension failed the activation turn: ${state.error}`,
          isAuthRequiredText(state.error) ? 'needs-auth' : 'turn-failed',
          state.error
        );
      }
      if (!state.responseText) {
        throw createActivationError(
          'The official Codex extension completed the activation turn without an assistant response.',
          'empty-response'
        );
      }
      return {
        responseText: state.responseText,
        turnId: state.turnId,
        sessionPath,
        diagnostics
      };
    }
    await sleep(pollIntervalMs);
  }
  throw createActivationError(
    'The official Codex extension did not finish the activation response in time.',
    'turn-timeout'
  );
}

class CodexExtensionUiActivator {
  constructor(logger, options = {}) {
    this.logger = logger;
    this.codexLogPath = options.codexLogPath;
    this.focusWorkerWindow = options.focusWorkerWindow || focusWorkerWindow;
    this.sendTextAndEnter =
      options.sendTextAndEnter || sendTextAndEnterToWorkerWindow;
    this.waitForUiReady = options.waitForUiReady || waitForUiReady;
    this.waitForConversationCreated =
      options.waitForConversationCreated || waitForConversationCreated;
    this.waitForTurnCompletion =
      options.waitForTurnCompletion || waitForOfficialTurnCompletion;
    this.openNewPanel = options.openNewPanel || openNewCodexPanel;
    this.closePanelTab = options.closePanelTab || closeCodexPanelTab;
    const configuredComposerSettleMs = Number(options.composerSettleMs);
    this.composerSettleMs = Math.max(
      0,
      Number.isFinite(configuredComposerSettleMs)
        ? configuredComposerSettleMs
        : 1000
    );
    const configuredVisibilityMs = Number(options.visibilityMs);
    this.visibilityMs = Math.max(
      0,
      Number.isFinite(configuredVisibilityMs) ? configuredVisibilityMs : 2500
    );
  }

  async run(options = {}) {
    const extension = vscode.extensions.getExtension(CODEX_EXTENSION_ID);
    if (!extension) {
      throw createActivationError(
        `The official Codex extension ${CODEX_EXTENSION_ID} is not installed.`,
        'ui-unavailable'
      );
    }

    let tab = null;
    let threadId = null;
    let responseText = '';
    let diagnostics = '';
    let workerWindow = null;
    try {
      throwIfCancelled(options.cancellationToken);
      if (!asNonEmptyString(options.windowTitleToken)) {
        throw createActivationError(
          'The activation chat has no dedicated worker-window ownership token.',
          'ui-unavailable'
        );
      }
      const hasConfiguredStartupOffset =
        options.startupLogOffset !== null && options.startupLogOffset !== undefined;
      const configuredStartupOffset = Number(options.startupLogOffset);
      const startupOffset =
        hasConfiguredStartupOffset && Number.isFinite(configuredStartupOffset)
        ? Math.max(0, configuredStartupOffset)
        : getFileSize(this.codexLogPath);
      if (!extension.isActive) {
        await extension.activate();
      }
      await waitForCodexCommands(this.logger, {
        requiredCommands: [CODEX_NEW_PANEL_COMMAND]
      });
      try {
        workerWindow = this.focusWorkerWindow(options.windowTitleToken);
      } catch (error) {
        throw createActivationError(
          `Could not establish ownership of the dedicated Codex worker window: ${getErrorMessage(error)}`,
          'ui-unavailable',
          error
        );
      }
      tab = await this.openNewPanel({
        cancellationToken: options.cancellationToken
      });
      try {
        workerWindow = this.focusWorkerWindow(
          options.windowTitleToken,
          workerWindow.windowId
        );
      } catch (error) {
        throw createActivationError(
          `The activation chat did not remain in its dedicated worker window: ${getErrorMessage(error)}`,
          'ui-unavailable',
          error
        );
      }
      if (typeof options.onState === 'function') {
        options.onState('checking-codex-auth');
      }
      const ready = await this.waitForUiReady(
        this.codexLogPath,
        startupOffset,
        { cancellationToken: options.cancellationToken }
      );
      diagnostics = ready.diagnostics || '';
      if (this.composerSettleMs > 0) {
        await sleep(this.composerSettleMs);
        throwIfCancelled(options.cancellationToken);
      }

      // The official extension owns the composer and the app-server connection. Input is
      // delivered only after Windows confirms that this job's uniquely named worker window
      // is foreground, which prevents a prompt from leaking into another VS Code window.
      if (typeof options.onState === 'function') {
        options.onState('typing-test');
      }
      const conversationOffset = getFileSize(this.codexLogPath);
      try {
        this.sendTextAndEnter(options.windowTitleToken, ACTIVATION_PROMPT, {
          expectedWindowId: workerWindow.windowId
        });
      } catch (error) {
        throw createActivationError(
          `Refused to send the activation prompt outside the dedicated worker window: ${getErrorMessage(error)}`,
          'ui-unavailable',
          error
        );
      }
      if (typeof options.onState === 'function') {
        options.onState('waiting-for-chat');
      }
      const conversation = await this.waitForConversationCreated(
        this.codexLogPath,
        conversationOffset,
        tab,
        { cancellationToken: options.cancellationToken }
      );
      threadId = conversation.threadId;
      diagnostics = [diagnostics, conversation.diagnostics]
        .filter(Boolean)
        .join('\n');
      if (typeof options.onThreadReady === 'function') {
        await options.onThreadReady(threadId);
      }

      if (typeof options.onState === 'function') {
        options.onState('waiting-for-answer');
      }
      const authPath = getDefaultCodexAuthPath(this.logger);
      const completion = await this.waitForTurnCompletion(
        path.join(path.dirname(authPath), 'sessions'),
        threadId,
        this.codexLogPath,
        conversation.offset,
        tab,
        { cancellationToken: options.cancellationToken }
      );
      responseText = completion.responseText;
      diagnostics = [diagnostics, completion.diagnostics]
        .filter(Boolean)
        .join('\n');
      if (typeof options.onResponseReady === 'function') {
        await options.onResponseReady(threadId, responseText);
      }
      if (this.visibilityMs > 0) {
        await sleep(this.visibilityMs);
      }
      return {
        threadId,
        reused: false,
        archived: false,
        archiveError: null,
        responseText,
        diagnostics: [
          'Activation method: official Codex VS Code extension UI.',
          'The exact activation editor tab was closed after the answer; the thread remains in Codex history because the extension exposes no archive command to other extensions.',
          safeLogDiagnostics(diagnostics)
        ]
          .filter(Boolean)
          .join('\n')
      };
    } catch (error) {
      const resultError =
        error instanceof Error
          ? error
          : createActivationError(getErrorMessage(error), 'failed', error);
      resultError.activationResult = {
        threadId,
        reused: false,
        archived: false,
        archiveError: null,
        responseText,
        diagnostics: safeLogDiagnostics(
          [diagnostics, resultError.diagnostics].filter(Boolean).join('\n')
        ),
        state: resultError.activationState || 'failed'
      };
      throw resultError;
    } finally {
      try {
        await this.closePanelTab(tab);
      } catch (error) {
        if (this.logger) {
          this.logger.warn('Could not close the exact Codex activation editor tab.', {
            error: getErrorMessage(error)
          });
        }
      }
    }
  }
}

module.exports = {
  ACTIVATION_PROMPT,
  AUTH_REQUIRED_PATTERNS,
  CODEX_NEW_PANEL_COMMAND,
  CodexExtensionUiActivator,
  closeCodexPanelTab,
  attachDiagnostics,
  createActivationError,
  findThreadSessionFile,
  getCodexPanelTabs,
  isAuthRequiredText,
  isUiReadyText,
  openNewCodexPanel,
  readLogChunk,
  readOfficialTurnState,
  safeLogDiagnostics,
  waitForConversationCreated,
  waitForOfficialTurnCompletion,
  waitForUiReady
};
