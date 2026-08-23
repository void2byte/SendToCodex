'use strict';

const vscode = require('vscode');
const CODEX_EXTENSION_ID = 'openai.chatgpt';
const CODEX_OPEN_SIDEBAR_COMMAND = 'chatgpt.openSidebar';
const CODEX_NEW_CHAT_COMMAND = 'chatgpt.newChat';
const CODEX_CONVERSATION_EDITOR_VIEW_TYPE = 'chatgpt.conversationEditor';
const CODEX_URI_SCHEME = 'openai-codex';
const CODEX_URI_AUTHORITY = 'route';

const DEFAULT_ACTIVATION_TIMEOUT_MS = 3 * 60 * 1000;
const DEFAULT_COMMAND_READY_TIMEOUT_MS = 3 * 60 * 1000;
const DEFAULT_COMMAND_TIMEOUT_MS = 3 * 60 * 1000;
const DEFAULT_PENDING_WARMUP_MAX_AGE_MS = 15 * 60 * 1000;
const DEFAULT_POST_SWITCH_WARMUP_DELAY_MS = 15 * 1000;
const DEFAULT_TAB_VERIFY_TIMEOUT_MS = 8 * 1000;
const DEFAULT_NATIVE_RESTORE_TIMEOUT_MS = 12 * 1000;
const DEFAULT_TAB_SETTLE_MS = 2 * 1000;
const DEFAULT_POLL_INTERVAL_MS = 1000;

const POST_SWITCH_RESTORE_STRATEGIES = Object.freeze({
  NATIVE_ONLY: 'nativeOnly',
  SIDEBAR_ONLY: 'sidebarOnly',
  OPEN_WITH_IMMEDIATE: 'openWithImmediate',
  OPEN_WITH_AFTER_NATIVE_SETTLE: 'openWithAfterNativeSettle',
  SIDEBAR_THEN_OPEN_WITH_VERIFY: 'sidebarThenOpenWithVerify',
  MULTI_ATTEMPT_NO_CLOSE: 'multiAttemptNoClose',
  LEGACY_CLOSE_THEN_OPEN_WITH: 'legacyCloseThenOpenWith'
});
const DEFAULT_POST_SWITCH_RESTORE_STRATEGY =
  POST_SWITCH_RESTORE_STRATEGIES.SIDEBAR_THEN_OPEN_WITH_VERIFY;
const POST_SWITCH_RESTORE_STRATEGY_OPTIONS = Object.freeze([
  {
    id: POST_SWITCH_RESTORE_STRATEGIES.SIDEBAR_THEN_OPEN_WITH_VERIFY,
    label: 'Verified editor restore',
    description: 'recommended',
    detail:
      'Restores and verifies a previously open conversation editor. Does nothing when no editor tab was open.'
  },
  {
    id: POST_SWITCH_RESTORE_STRATEGIES.NATIVE_ONLY,
    label: 'Native VS Code restore only',
    description: 'control',
    detail:
      'Does not call Codex commands after reload; only checks whether VS Code restored the previous Codex editor tab by itself.'
  },
  {
    id: POST_SWITCH_RESTORE_STRATEGIES.SIDEBAR_ONLY,
    label: 'Sidebar only',
    description: 'fallback',
    detail:
      'Activates Codex and opens the sidebar without trying to reopen the central conversation editor.'
  },
  {
    id: POST_SWITCH_RESTORE_STRATEGIES.OPEN_WITH_IMMEDIATE,
    label: 'Open editor immediately',
    description: 'no close',
    detail:
      'Runs vscode.openWith for the previous Codex conversation without closing any restored tabs first.'
  },
  {
    id: POST_SWITCH_RESTORE_STRATEGIES.OPEN_WITH_AFTER_NATIVE_SETTLE,
    label: 'Wait for native restore, then open editor',
    description: 'settle first',
    detail:
      'Waits for VS Code tab restoration to settle, keeps an already restored tab, and only then tries vscode.openWith.'
  },
  {
    id: POST_SWITCH_RESTORE_STRATEGIES.MULTI_ATTEMPT_NO_CLOSE,
    label: 'Multi-attempt editor restore',
    description: 'diagnostic',
    detail:
      'Retries editor restoration in stages without closing existing Codex tabs, with extra diagnostics.'
  },
  {
    id: POST_SWITCH_RESTORE_STRATEGIES.LEGACY_CLOSE_THEN_OPEN_WITH,
    label: 'Legacy close + open editor',
    description: 'old behavior',
    detail:
      'Closes matching Codex conversation tabs before vscode.openWith. Kept only for local comparison.'
  }
]);

function normalizePostSwitchRestoreStrategy(value) {
  const normalized = String(value || '').trim();
  return POST_SWITCH_RESTORE_STRATEGY_OPTIONS.some((option) => option.id === normalized)
    ? normalized
    : DEFAULT_POST_SWITCH_RESTORE_STRATEGY;
}

function getPostSwitchRestoreStrategyOption(strategy) {
  const normalized = normalizePostSwitchRestoreStrategy(strategy);
  return POST_SWITCH_RESTORE_STRATEGY_OPTIONS.find((option) => option.id === normalized);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getErrorMessage(error) {
  return error && error.message ? error.message : String(error);
}

function debugLog(logger, message, data) {
  if (logger && typeof logger.debug === 'function') {
    logger.debug(message, data);
  } else if (logger && typeof logger.info === 'function') {
    logger.info(message, data);
  }
}

function withTimeout(promise, timeoutMs, description) {
  const ms = Math.max(0, Number(timeoutMs) || 0);
  if (!ms) {
    return Promise.resolve(promise);
  }

  let timer;
  return Promise.race([
    Promise.resolve(promise).finally(() => {
      if (timer) {
        clearTimeout(timer);
      }
    }),
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`${description} timed out after ${ms}ms.`));
      }, ms);
    })
  ]);
}

function asUriString(uri) {
  if (!uri) {
    return null;
  }

  if (typeof uri === 'string') {
    return uri;
  }

  if (typeof uri.toString === 'function') {
    return uri.toString();
  }

  return null;
}

function isCodexConversationUri(uri) {
  return Boolean(
    uri &&
      uri.scheme === CODEX_URI_SCHEME &&
      (!uri.authority || uri.authority === CODEX_URI_AUTHORITY)
  );
}

function isCodexConversationTab(tab) {
  const input = tab && tab.input;
  return Boolean(
    input &&
      input.viewType === CODEX_CONVERSATION_EDITOR_VIEW_TYPE &&
      isCodexConversationUri(input.uri)
  );
}

function getTabUriString(tab) {
  return asUriString(tab && tab.input && tab.input.uri);
}

function getGroupViewColumn(group) {
  const viewColumn = Number(group && group.viewColumn);
  return Number.isFinite(viewColumn) && viewColumn > 0 ? viewColumn : undefined;
}

function createConversationContext(tab, group, source) {
  return {
    kind: 'conversationEditor',
    source,
    uri: getTabUriString(tab),
    viewType: CODEX_CONVERSATION_EDITOR_VIEW_TYPE,
    viewColumn: getGroupViewColumn(group)
  };
}

function isRestorableCodexChatContext(context) {
  if (!context || typeof context !== 'object') {
    return false;
  }

  return Boolean(context.kind === 'conversationEditor' && context.uri);
}

function captureCurrentCodexChatContext(logger) {
  const groups = vscode.window.tabGroups && Array.isArray(vscode.window.tabGroups.all)
    ? vscode.window.tabGroups.all
    : [];
  const activeGroup = vscode.window.tabGroups && vscode.window.tabGroups.activeTabGroup;

  debugLog(logger, 'Codex restore debug: scanning VS Code tab groups before profile switch.', {
    groupCount: groups.length,
    activeGroupViewColumn: getGroupViewColumn(activeGroup) || null,
    groups: getTabGroupsSignature()
  });

  const candidates = [];
  for (const group of groups) {
    const tabs = Array.isArray(group && group.tabs) ? group.tabs : [];
    for (const tab of tabs) {
      if (!isCodexConversationTab(tab)) {
        continue;
      }

      const isActiveGroup = Boolean(activeGroup && activeGroup === group);
      const isActiveTab = Boolean(
        tab.isActive || (group && group.activeTab && group.activeTab === tab)
      );
      candidates.push({
        tab,
        group,
        rank: isActiveGroup && isActiveTab ? 0 : isActiveTab ? 1 : isActiveGroup ? 2 : 3
      });
    }
  }

  candidates.sort((left, right) => left.rank - right.rank);
  const selected = candidates[0];
  if (selected) {
    const context = createConversationContext(
      selected.tab,
      selected.group,
      selected.rank === 0 ? 'active-codex-tab' : 'visible-codex-tab'
    );
    logger &&
      logger.info &&
      logger.info('Captured Codex chat context for post-switch restore.', {
        kind: context.kind,
        source: context.source,
        uri: context.uri,
        viewColumn: context.viewColumn || null
      });
    debugLog(logger, 'Codex restore debug: captured conversation editor context.', {
      selected: context,
      candidates: candidates.map((candidate) => ({
        rank: candidate.rank,
        uri: getTabUriString(candidate.tab),
        viewColumn: getGroupViewColumn(candidate.group) || null,
        isActiveTab: Boolean(candidate.tab && candidate.tab.isActive)
      }))
    });
    return context;
  }

  logger &&
    logger.info &&
    logger.info(
      'No Codex conversation editor tab is open; post-switch chat restore will be skipped.'
    );
  return null;
}

function getCodexConversationTabsForUri(uriString) {
  const groups = vscode.window.tabGroups && Array.isArray(vscode.window.tabGroups.all)
    ? vscode.window.tabGroups.all
    : [];
  const tabs = [];
  for (const group of groups) {
    for (const tab of Array.isArray(group && group.tabs) ? group.tabs : []) {
      if (isCodexConversationTab(tab) && getTabUriString(tab) === uriString) {
        tabs.push(tab);
      }
    }
  }
  return tabs;
}

function getTabGroupsSignature() {
  const groups = vscode.window.tabGroups && Array.isArray(vscode.window.tabGroups.all)
    ? vscode.window.tabGroups.all
    : [];
  return groups.map((group) => {
    const tabs = Array.isArray(group && group.tabs) ? group.tabs : [];
    return {
      viewColumn: getGroupViewColumn(group) || null,
      activeUri: getTabUriString(group && group.activeTab) || null,
      tabs: tabs.map((tab) => ({
        viewType: tab && tab.input ? tab.input.viewType || null : null,
        uri: getTabUriString(tab),
        active: Boolean(tab && tab.isActive)
      }))
    };
  });
}

function getCodexConversationTabDiagnostic(uriString) {
  const groups = vscode.window.tabGroups && Array.isArray(vscode.window.tabGroups.all)
    ? vscode.window.tabGroups.all
    : [];
  let totalCodexConversationTabs = 0;
  let matchingTabs = 0;
  const matchingViewColumns = [];

  for (const group of groups) {
    const tabs = Array.isArray(group && group.tabs) ? group.tabs : [];
    for (const tab of tabs) {
      if (!isCodexConversationTab(tab)) {
        continue;
      }

      totalCodexConversationTabs += 1;
      if (getTabUriString(tab) === uriString) {
        matchingTabs += 1;
        matchingViewColumns.push(getGroupViewColumn(group) || null);
      }
    }
  }

  return {
    groupCount: groups.length,
    totalCodexConversationTabs,
    matchingTabs,
    matchingViewColumns
  };
}

async function waitForCodexConversationTab(uriString, logger, options = {}) {
  const timeoutMs = Math.max(
    0,
    Number(options.tabVerifyTimeoutMs || DEFAULT_TAB_VERIFY_TIMEOUT_MS)
  );
  const pollIntervalMs = Math.max(
    100,
    Number(options.pollIntervalMs || DEFAULT_POLL_INTERVAL_MS)
  );
  const startedAt = Date.now();

  while (Date.now() - startedAt <= timeoutMs) {
    const diagnostic = getCodexConversationTabDiagnostic(uriString);
    if (diagnostic.matchingTabs > 0) {
      logger &&
        logger.info &&
        logger.info('Verified Codex conversation editor tab after profile switch.', {
          uri: uriString,
          waitedMs: Date.now() - startedAt,
          matchingTabs: diagnostic.matchingTabs,
          totalCodexConversationTabs: diagnostic.totalCodexConversationTabs,
          viewColumns: diagnostic.matchingViewColumns
        });
      return {
        found: true,
        waitedMs: Date.now() - startedAt,
        diagnostic
      };
    }

    await sleep(pollIntervalMs);
  }

  const diagnostic = getCodexConversationTabDiagnostic(uriString);
  logger &&
    logger.warn &&
    logger.warn('Codex conversation editor tab was not visible after waiting.', {
      uri: uriString,
      waitedMs: Date.now() - startedAt,
      matchingTabs: diagnostic.matchingTabs,
      totalCodexConversationTabs: diagnostic.totalCodexConversationTabs,
      groupCount: diagnostic.groupCount
    });
  return {
    found: false,
    waitedMs: Date.now() - startedAt,
    diagnostic
  };
}

async function waitForTabGroupsToSettle(logger, options = {}) {
  const timeoutMs = Math.max(
    0,
    Number(options.tabSettleTimeoutMs || DEFAULT_NATIVE_RESTORE_TIMEOUT_MS)
  );
  const settleMs = Math.max(0, Number(options.tabSettleMs || DEFAULT_TAB_SETTLE_MS));
  const pollIntervalMs = Math.max(
    100,
    Number(options.pollIntervalMs || DEFAULT_POLL_INTERVAL_MS)
  );
  const startedAt = Date.now();
  let lastSignature = JSON.stringify(getTabGroupsSignature());
  let stableSince = Date.now();

  while (Date.now() - startedAt <= timeoutMs) {
    await sleep(pollIntervalMs);
    const signature = JSON.stringify(getTabGroupsSignature());
    if (signature !== lastSignature) {
      lastSignature = signature;
      stableSince = Date.now();
      continue;
    }

    if (Date.now() - stableSince >= settleMs) {
      logger &&
        logger.info &&
        logger.info('VS Code tab groups settled before Codex post-switch restore.', {
          waitedMs: Date.now() - startedAt,
          stableMs: Date.now() - stableSince
        });
      return {
        settled: true,
        waitedMs: Date.now() - startedAt,
        stableMs: Date.now() - stableSince
      };
    }
  }

  logger &&
    logger.warn &&
    logger.warn('VS Code tab groups did not settle before Codex post-switch restore.', {
      waitedMs: Date.now() - startedAt,
      timeoutMs,
      settleMs
    });
  return {
    settled: false,
    waitedMs: Date.now() - startedAt,
    stableMs: Date.now() - stableSince
  };
}

async function closeCodexConversationTabs(uriString, logger) {
  const tabs = getCodexConversationTabsForUri(uriString);
  if (!tabs.length) {
    return 0;
  }

  await vscode.window.tabGroups.close(tabs, true);
  logger &&
    logger.info &&
    logger.info('Closed stale Codex conversation tabs before restore.', {
      uri: uriString,
      count: tabs.length
    });
  return tabs.length;
}

async function activateCodexExtension(logger, options = {}) {
  const extension = vscode.extensions.getExtension(CODEX_EXTENSION_ID);
  if (!extension) {
    throw new Error(`Codex extension ${CODEX_EXTENSION_ID} is not installed.`);
  }

  if (extension.isActive) {
    return extension;
  }

  logger &&
    logger.info &&
    logger.info('Activating Codex extension before post-switch warm-up.', {
      extensionId: CODEX_EXTENSION_ID
    });
  await withTimeout(
    extension.activate(),
    options.activationTimeoutMs || DEFAULT_ACTIVATION_TIMEOUT_MS,
    'Codex extension activation'
  );
  logger &&
    logger.info &&
    logger.info('Codex extension activated before post-switch warm-up.', {
      extensionId: CODEX_EXTENSION_ID
    });
  return extension;
}

async function waitForCodexCommands(logger, options = {}) {
  const timeoutMs = Math.max(
    0,
    Number(options.commandReadyTimeoutMs || DEFAULT_COMMAND_READY_TIMEOUT_MS)
  );
  const pollIntervalMs = Math.max(
    100,
    Number(options.pollIntervalMs || DEFAULT_POLL_INTERVAL_MS)
  );
  const requiredCommands = Array.isArray(options.requiredCommands) && options.requiredCommands.length
    ? options.requiredCommands
    : [CODEX_OPEN_SIDEBAR_COMMAND, CODEX_NEW_CHAT_COMMAND];
  const startedAt = Date.now();
  let lastCommands = [];

  while (Date.now() - startedAt <= timeoutMs) {
    const commands = await vscode.commands.getCommands(true);
    lastCommands = commands;
    const missingCommands = requiredCommands.filter((command) => !commands.includes(command));
    if (!missingCommands.length) {
      logger &&
        logger.info &&
        logger.info('Codex commands are ready after profile switch.', {
          waitedMs: Date.now() - startedAt,
          requiredCommands
        });
      return {
        waitedMs: Date.now() - startedAt,
        commands
      };
    }

    await sleep(pollIntervalMs);
  }

  throw new Error(
    `Codex commands were not ready after ${timeoutMs}ms. Missing: ${requiredCommands
      .filter((command) => !lastCommands.includes(command))
      .join(', ')}`
  );
}

async function executeCodexCommand(command, args, logger, options = {}) {
  logger &&
    logger.info &&
    logger.info('Executing Codex command after profile switch.', { command });
  return withTimeout(
    vscode.commands.executeCommand(command, ...(Array.isArray(args) ? args : [])),
    options.commandTimeoutMs || DEFAULT_COMMAND_TIMEOUT_MS,
    `Codex command ${command}`
  );
}

async function restoreCodexConversationEditor(context, logger, options = {}) {
  const uri = vscode.Uri.parse(context.uri);
  if (!isCodexConversationUri(uri)) {
    throw new Error(`Refusing to restore non-Codex URI: ${context.uri}`);
  }

  if (options.closeBeforeOpen) {
    await closeCodexConversationTabs(context.uri, logger);
  }

  const viewColumn = context.viewColumn || vscode.ViewColumn.Active;
  debugLog(logger, 'Codex restore debug: executing vscode.openWith for conversation editor.', {
    uri: context.uri,
    viewColumn,
    closeBeforeOpen: Boolean(options.closeBeforeOpen),
    verifyAfterOpen: options.verifyAfterOpen !== false
  });
  await executeCodexCommand(
    'vscode.openWith',
    [
      uri,
      CODEX_CONVERSATION_EDITOR_VIEW_TYPE,
      {
        preview: false,
        preserveFocus: false,
        viewColumn
      }
    ],
    logger,
    options
  );
  logger &&
    logger.info &&
    logger.info('Restored Codex conversation editor after profile switch.', {
      uri: context.uri,
      viewColumn,
      closeBeforeOpen: Boolean(options.closeBeforeOpen)
    });

  if (options.verifyAfterOpen) {
    const verification = await waitForCodexConversationTab(context.uri, logger, options);
    if (!verification.found) {
      throw new Error(
        `Codex conversation editor did not appear after vscode.openWith for ${context.uri}.`
      );
    }
  }
}

async function openCodexSidebar(logger, options = {}) {
  await executeCodexCommand(CODEX_OPEN_SIDEBAR_COMMAND, [], logger, options);
  logger &&
    logger.info &&
    logger.info('Opened Codex sidebar after profile switch.');
}

async function prepareCodexExtensionForWarmup(logger, options = {}) {
  await activateCodexExtension(logger, options);
  await waitForCodexCommands(logger, options);
}

async function restoreWithOpenWithAndVerify(context, logger, options = {}) {
  await restoreCodexConversationEditor(context, logger, {
    ...options,
    closeBeforeOpen: Boolean(options.closeBeforeOpen),
    verifyAfterOpen: options.verifyAfterOpen !== false
  });
}

async function runNativeOnlyRestore(context, logger, options = {}) {
  if (context.kind !== 'conversationEditor') {
    logger &&
      logger.warn &&
      logger.warn('Native-only Codex restore has no conversation editor context to watch.', {
        restoredKind: context.kind,
        restoredSource: context.source || null
      });
    throw new Error('Native-only Codex restore requires a captured conversation editor tab.');
  }

  const verification = await waitForCodexConversationTab(context.uri, logger, {
    ...options,
    tabVerifyTimeoutMs: options.nativeRestoreTimeoutMs || DEFAULT_NATIVE_RESTORE_TIMEOUT_MS
  });
  if (!verification.found) {
    throw new Error(`VS Code did not natively restore Codex conversation ${context.uri}.`);
  }

  return true;
}

async function runOpenWithImmediateRestore(context, logger, options = {}) {
  await prepareCodexExtensionForWarmup(logger, {
    ...options,
    requiredCommands: options.requiredCommands || [CODEX_OPEN_SIDEBAR_COMMAND]
  });

  if (context.kind !== 'conversationEditor') {
    await openCodexSidebar(logger, options);
    return true;
  }

  await restoreWithOpenWithAndVerify(context, logger, options);
  return true;
}

async function runOpenWithAfterNativeSettleRestore(context, logger, options = {}) {
  if (context.kind === 'conversationEditor') {
    await waitForTabGroupsToSettle(logger, options);
    const nativeRestore = await waitForCodexConversationTab(context.uri, logger, {
      ...options,
      tabVerifyTimeoutMs: options.nativeCheckTimeoutMs || 1000
    });
    if (nativeRestore.found) {
      logger &&
        logger.info &&
        logger.info('Using VS Code native Codex conversation restore after tab-settle wait.', {
          uri: context.uri
        });
      return true;
    }
  }

  return runOpenWithImmediateRestore(context, logger, options);
}

async function runSidebarThenOpenWithVerifyRestore(context, logger, options = {}) {
  debugLog(logger, 'Codex restore debug: running verified editor restore strategy.', {
    restoredKind: context.kind,
    restoredSource: context.source || null,
    uri: context.uri || null
  });
  await prepareCodexExtensionForWarmup(logger, {
    ...options,
    requiredCommands: options.requiredCommands || [CODEX_OPEN_SIDEBAR_COMMAND]
  });

  if (context.kind !== 'conversationEditor') {
    debugLog(logger, 'Codex restore debug: no conversation editor context; opening sidebar fallback.', {
      restoredKind: context.kind,
      restoredSource: context.source || null
    });
    await openCodexSidebar(logger, options);
    return true;
  }

  await waitForTabGroupsToSettle(logger, {
    ...options,
    tabSettleTimeoutMs: options.sidebarSettleTimeoutMs || 4000,
    tabSettleMs: options.sidebarSettleMs || 1000
  });

  const existingRestore = await waitForCodexConversationTab(context.uri, logger, {
    ...options,
    tabVerifyTimeoutMs: options.nativeCheckTimeoutMs || 1000
  });
  if (existingRestore.found) {
    logger &&
      logger.info &&
      logger.info('Codex conversation tab is already present before verified openWith restore.', {
        uri: context.uri
      });
  }

  try {
    await restoreWithOpenWithAndVerify(context, logger, options);
    return true;
  } catch (firstError) {
    const firstMessage = getErrorMessage(firstError);
    logger &&
      logger.warn &&
      logger.warn('First verified Codex conversation restore attempt failed; retrying once.', {
        uri: context.uri,
        error: firstMessage
      });
    await sleep(Math.max(100, Number(options.retryDelayMs || 3000)));
    await restoreWithOpenWithAndVerify(context, logger, options);
    return true;
  }
}

async function runMultiAttemptNoCloseRestore(context, logger, options = {}) {
  await prepareCodexExtensionForWarmup(logger, {
    ...options,
    requiredCommands: options.requiredCommands || [CODEX_OPEN_SIDEBAR_COMMAND]
  });

  if (context.kind !== 'conversationEditor') {
    await openCodexSidebar(logger, options);
    return true;
  }

  const errors = [];
  const attempts = [
    {
      name: 'immediate-openWith',
      before: async () => {}
    },
    {
      name: 'sidebar-then-openWith',
      before: async () => {
        await openCodexSidebar(logger, options);
        await waitForTabGroupsToSettle(logger, {
          ...options,
          tabSettleTimeoutMs: options.sidebarSettleTimeoutMs || 4000,
          tabSettleMs: options.sidebarSettleMs || 1000
        });
      }
    },
    {
      name: 'delayed-openWith',
      before: async () => {
        await sleep(Math.max(100, Number(options.retryDelayMs || 5000)));
      }
    }
  ];

  for (const attempt of attempts) {
    try {
      logger &&
        logger.info &&
        logger.info('Trying Codex conversation restore attempt.', {
          attempt: attempt.name,
          before: getCodexConversationTabDiagnostic(context.uri)
        });
      await attempt.before();
      await restoreWithOpenWithAndVerify(context, logger, {
        ...options,
        tabVerifyTimeoutMs: options.multiAttemptVerifyTimeoutMs || DEFAULT_TAB_VERIFY_TIMEOUT_MS
      });
      logger &&
        logger.info &&
        logger.info('Codex conversation restore attempt succeeded.', {
          attempt: attempt.name,
          after: getCodexConversationTabDiagnostic(context.uri)
        });
      return true;
    } catch (error) {
      const message = getErrorMessage(error);
      errors.push(`${attempt.name}: ${message}`);
      logger &&
        logger.warn &&
        logger.warn('Codex conversation restore attempt failed.', {
          attempt: attempt.name,
          error: message,
          after: getCodexConversationTabDiagnostic(context.uri)
        });
    }
  }

  throw new Error(`All Codex conversation restore attempts failed. ${errors.join(' | ')}`);
}

async function runLegacyCloseThenOpenWithRestore(context, logger, options = {}) {
  await prepareCodexExtensionForWarmup(logger, options);

  if (context.kind !== 'conversationEditor') {
    await openCodexSidebar(logger, options);
    return true;
  }

  await restoreWithOpenWithAndVerify(context, logger, {
    ...options,
    closeBeforeOpen: true
  });
  return true;
}

async function warmUpCodexAfterProfileSwitch(reason, logger, options = {}) {
  const restoreChatContext = options.restoreChatContext;
  if (!isRestorableCodexChatContext(restoreChatContext)) {
    logger &&
      logger.info &&
      logger.info('Skipped Codex chat restore because no conversation editor tab was captured.', {
        reason
      });
    return false;
  }
  const strategy = normalizePostSwitchRestoreStrategy(options.restoreStrategy);

  try {
    debugLog(logger, 'Codex restore debug: starting post-switch warm-up.', {
      reason,
      strategy,
      restoreChatContext
    });
    logger &&
      logger.info &&
      logger.info('Running Codex post-switch warm-up strategy.', {
        reason,
        strategy,
        restoredKind: restoreChatContext.kind,
        restoredSource: restoreChatContext.source || null
      });

    switch (strategy) {
      case POST_SWITCH_RESTORE_STRATEGIES.NATIVE_ONLY:
        await runNativeOnlyRestore(restoreChatContext, logger, options);
        break;
      case POST_SWITCH_RESTORE_STRATEGIES.SIDEBAR_ONLY:
        throw new Error(
          'The sidebar-only strategy cannot restore a conversation and is disabled to avoid a false success.'
        );
      case POST_SWITCH_RESTORE_STRATEGIES.OPEN_WITH_IMMEDIATE:
        await runOpenWithImmediateRestore(restoreChatContext, logger, options);
        break;
      case POST_SWITCH_RESTORE_STRATEGIES.OPEN_WITH_AFTER_NATIVE_SETTLE:
        await runOpenWithAfterNativeSettleRestore(restoreChatContext, logger, options);
        break;
      case POST_SWITCH_RESTORE_STRATEGIES.MULTI_ATTEMPT_NO_CLOSE:
        await runMultiAttemptNoCloseRestore(restoreChatContext, logger, options);
        break;
      case POST_SWITCH_RESTORE_STRATEGIES.LEGACY_CLOSE_THEN_OPEN_WITH:
        await runLegacyCloseThenOpenWithRestore(restoreChatContext, logger, options);
        break;
      case POST_SWITCH_RESTORE_STRATEGIES.SIDEBAR_THEN_OPEN_WITH_VERIFY:
      default:
        await runSidebarThenOpenWithVerifyRestore(restoreChatContext, logger, options);
        break;
    }

    logger &&
      logger.info &&
      logger.info('Warmed up Codex after profile switch.', {
        reason,
        strategy,
        restoredKind: restoreChatContext.kind,
        restoredSource: restoreChatContext.source || null
      });
    debugLog(logger, 'Codex restore debug: post-switch warm-up completed.', {
      reason,
      strategy,
      restoredKind: restoreChatContext.kind,
      restoredSource: restoreChatContext.source || null
    });
    return true;
  } catch (error) {
    const message = getErrorMessage(error);
    logger &&
      logger.error &&
      logger.error('Failed to warm up Codex after profile switch.', {
        reason,
        strategy,
        restoredKind: restoreChatContext.kind,
        restoredSource: restoreChatContext.source || null,
        error: message
      });
    debugLog(logger, 'Codex restore debug: post-switch warm-up failed.', {
      reason,
      strategy,
      restoreChatContext,
      error: message
    });
    if (options.showErrorMessage !== false && vscode.window && vscode.window.showErrorMessage) {
      void vscode.window.showErrorMessage(
        `Codex chat did not reopen after account switch: ${message}`
      );
    }
    return false;
  }
}

function isPendingCodexPostSwitchWarmupFresh(pending, now = Date.now(), maxAgeMs = DEFAULT_PENDING_WARMUP_MAX_AGE_MS) {
  return Boolean(
    pending &&
      pending.scheduledAt &&
      now - Number(pending.scheduledAt) <= Math.max(0, Number(maxAgeMs) || 0)
  );
}

module.exports = {
  CODEX_CONVERSATION_EDITOR_VIEW_TYPE,
  CODEX_EXTENSION_ID,
  CODEX_NEW_CHAT_COMMAND,
  CODEX_OPEN_SIDEBAR_COMMAND,
  CODEX_URI_AUTHORITY,
  CODEX_URI_SCHEME,
  DEFAULT_ACTIVATION_TIMEOUT_MS,
  DEFAULT_COMMAND_READY_TIMEOUT_MS,
  DEFAULT_COMMAND_TIMEOUT_MS,
  DEFAULT_NATIVE_RESTORE_TIMEOUT_MS,
  DEFAULT_PENDING_WARMUP_MAX_AGE_MS,
  DEFAULT_POST_SWITCH_WARMUP_DELAY_MS,
  DEFAULT_POST_SWITCH_RESTORE_STRATEGY,
  DEFAULT_TAB_SETTLE_MS,
  DEFAULT_TAB_VERIFY_TIMEOUT_MS,
  POST_SWITCH_RESTORE_STRATEGIES,
  POST_SWITCH_RESTORE_STRATEGY_OPTIONS,
  captureCurrentCodexChatContext,
  closeCodexConversationTabs,
  getCodexConversationTabDiagnostic,
  getPostSwitchRestoreStrategyOption,
  isPendingCodexPostSwitchWarmupFresh,
  isRestorableCodexChatContext,
  normalizePostSwitchRestoreStrategy,
  warmUpCodexAfterProfileSwitch,
  waitForCodexConversationTab,
  waitForCodexCommands,
  waitForTabGroupsToSettle,
  withTimeout
};
