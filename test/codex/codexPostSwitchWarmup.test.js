'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createMockVscode, installMockVscode } = require('../helpers/mockVscode');

const MODULE_PATH = '../../src/codex/CodexPostSwitchWarmup';

function loadWarmupModule(mock) {
  const restore = installMockVscode(mock.vscode);
  delete require.cache[require.resolve(MODULE_PATH)];
  const mod = require(MODULE_PATH);
  return {
    mod,
    restore: () => {
      delete require.cache[require.resolve(MODULE_PATH)];
      restore();
    }
  };
}

function createCodexTab(mock, uriString, options = {}) {
  return {
    isActive: Boolean(options.isActive),
    input: {
      viewType: 'chatgpt.conversationEditor',
      uri: mock.vscode.Uri.parse(uriString)
    }
  };
}

function createLogger() {
  const entries = [];
  return {
    entries,
    info: (message, data) => entries.push({ level: 'info', message, data }),
    warn: (message, data) => entries.push({ level: 'warn', message, data }),
    error: (message, data) => entries.push({ level: 'error', message, data })
  };
}

test('pending Codex warm-up stays fresh long enough for slow Codex startup', () => {
  const mock = createMockVscode();
  const { mod, restore } = loadWarmupModule(mock);
  try {
    const now = Date.parse('2026-05-20T10:00:00.000Z');
    assert.equal(mod.DEFAULT_COMMAND_READY_TIMEOUT_MS, 3 * 60 * 1000);
    assert.equal(
      mod.isPendingCodexPostSwitchWarmupFresh(
        { scheduledAt: now - 3 * 60 * 1000 - 5 * 1000 },
        now
      ),
      true
    );
    assert.equal(
      mod.isPendingCodexPostSwitchWarmupFresh(
        { scheduledAt: now - mod.DEFAULT_PENDING_WARMUP_MAX_AGE_MS - 1 },
        now
      ),
      false
    );
  } finally {
    restore();
  }
});

test('captures the active Codex conversation editor tab before account switch', () => {
  const mock = createMockVscode();
  const inactiveUri = 'openai-codex://route/local/thread-inactive';
  const activeUri = 'openai-codex://route/local/thread-active';
  const inactiveTab = createCodexTab(mock, inactiveUri);
  const activeTab = createCodexTab(mock, activeUri, { isActive: true });
  const activeGroup = {
    viewColumn: 2,
    activeTab,
    tabs: [inactiveTab, activeTab]
  };
  mock.setTabGroups([activeGroup], activeGroup);

  const { mod, restore } = loadWarmupModule(mock);
  try {
    const context = mod.captureCurrentCodexChatContext(createLogger());

    assert.equal(context.kind, 'conversationEditor');
    assert.equal(context.uri, activeUri);
    assert.equal(context.viewColumn, 2);
    assert.equal(context.source, 'active-codex-tab');
  } finally {
    restore();
  }
});

test('does not infer an open chat from historical Codex log events', () => {
  const mock = createMockVscode();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-stale-chat-'));
  const logPath = path.join(directory, 'Codex.log');
  const conversationId = '019ed0b4-722c-7180-9d34-8cf7e7c5c455';
  fs.writeFileSync(
    logPath,
    [
      `2026-06-20 21:54:45.739 [info] Conversation created conversationId=${conversationId}`,
      `2026-06-20 21:54:46.000 [info] thread_stream_view_activity_changed active=true conversationId=${conversationId}`,
      `2026-06-20 21:54:47.000 [info] maybe_resume_success conversationId=${conversationId} turnCount=243`
    ].join('\n')
  );

  const { mod, restore } = loadWarmupModule(mock);
  try {
    const context = mod.captureCurrentCodexChatContext(createLogger(), {
      fallbackToSidebar: true,
      codexLogPath: logPath
    });

    assert.equal(context, null);
    assert.equal(mod.isRestorableCodexChatContext(context), false);
    assert.equal(
      mod.isRestorableCodexChatContext({
        kind: 'sidebarConversation',
        conversationId,
        route: `/local/${conversationId}`
      }),
      false
    );
    assert.deepEqual(mock.externalUris, []);
  } finally {
    restore();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('openWith strategy restores a Codex conversation editor without closing native tabs', async () => {
  const mock = createMockVscode({
    commands: ['chatgpt.openSidebar', 'chatgpt.newChat', 'vscode.openWith']
  });
  mock.setExtension('openai.chatgpt', {
    isActive: true,
    activate: async () => {}
  });
  const uri = 'openai-codex://route/local/thread-restore';
  const staleTab = createCodexTab(mock, uri, { isActive: true });
  const group = {
    viewColumn: 1,
    activeTab: staleTab,
    tabs: [staleTab]
  };
  mock.setTabGroups([group], group);

  const { mod, restore } = loadWarmupModule(mock);
  try {
    const restored = await mod.warmUpCodexAfterProfileSwitch(
      'unit-test',
      createLogger(),
      {
        restoreChatContext: {
          kind: 'conversationEditor',
          uri,
          viewColumn: 1,
          source: 'unit-test'
        },
        restoreStrategy: 'openWithImmediate',
        showErrorMessage: false,
        commandReadyTimeoutMs: 50,
        commandTimeoutMs: 50,
        tabVerifyTimeoutMs: 50,
        pollIntervalMs: 1
      }
    );

    assert.equal(restored, true);
    assert.equal(mock.closedTabs.length, 0);
    assert.deepEqual(
      mock.commandCalls.map((call) => call.command),
      ['vscode.openWith']
    );
    assert.equal(mock.commandCalls.some((call) => call.command === 'chatgpt.newChat'), false);
    assert.equal(mock.commandCalls.some((call) => call.command === 'chatgpt.openSidebar'), false);
    assert.equal(mock.commandCalls[0].args[1], 'chatgpt.conversationEditor');
    assert.equal(mock.commandCalls[0].args[2].preview, false);
  } finally {
    restore();
  }
});

test('default strategy restores the previous editor without opening the sidebar', async () => {
  const mock = createMockVscode({
    commands: ['chatgpt.openSidebar', 'vscode.openWith']
  });
  mock.setExtension('openai.chatgpt', {
    isActive: true,
    activate: async () => {}
  });
  const uri = 'openai-codex://route/local/thread-native';
  const nativeTab = createCodexTab(mock, uri, { isActive: true });
  const group = {
    viewColumn: 1,
    activeTab: nativeTab,
    tabs: [nativeTab]
  };
  mock.setTabGroups([group], group);

  const { mod, restore } = loadWarmupModule(mock);
  try {
    const restored = await mod.warmUpCodexAfterProfileSwitch(
      'unit-test-default',
      createLogger(),
      {
        restoreChatContext: {
          kind: 'conversationEditor',
          uri,
          viewColumn: 1,
          source: 'unit-test'
        },
        showErrorMessage: false,
        commandReadyTimeoutMs: 50,
        commandTimeoutMs: 50,
        sidebarSettleTimeoutMs: 5,
        sidebarSettleMs: 1,
        nativeCheckTimeoutMs: 1,
        pollIntervalMs: 1
      }
    );

    assert.equal(restored, true);
    assert.equal(mock.closedTabs.length, 0);
    assert.deepEqual(
      mock.commandCalls.map((call) => call.command),
      ['vscode.openWith']
    );
  } finally {
    restore();
  }
});

test('legacy close strategy keeps the old close-before-open behavior available', async () => {
  const mock = createMockVscode({
    commands: ['chatgpt.openSidebar', 'chatgpt.newChat', 'vscode.openWith']
  });
  mock.setExtension('openai.chatgpt', {
    isActive: true,
    activate: async () => {}
  });
  const uri = 'openai-codex://route/local/thread-legacy';
  const staleTab = createCodexTab(mock, uri, { isActive: true });
  const group = {
    viewColumn: 1,
    activeTab: staleTab,
    tabs: [staleTab]
  };
  mock.setTabGroups([group], group);

  const { mod, restore } = loadWarmupModule(mock);
  try {
    const restored = await mod.warmUpCodexAfterProfileSwitch(
      'unit-test-legacy',
      createLogger(),
      {
        restoreChatContext: {
          kind: 'conversationEditor',
          uri,
          viewColumn: 1,
          source: 'unit-test'
        },
        restoreStrategy: 'legacyCloseThenOpenWith',
        showErrorMessage: false,
        commandReadyTimeoutMs: 50,
        commandTimeoutMs: 50,
        tabVerifyTimeoutMs: 50,
        pollIntervalMs: 1
      }
    );

    assert.equal(restored, true);
    assert.equal(mock.closedTabs.length, 1);
    assert.equal(mock.closedTabs[0].tabs[0], staleTab);
    assert.equal(mock.closedTabs[0].preserveFocus, true);
    assert.deepEqual(
      mock.commandCalls.map((call) => call.command),
      ['vscode.openWith']
    );
  } finally {
    restore();
  }
});

test('does not open built-in or Codex chat when official Codex commands are not ready', async () => {
  const mock = createMockVscode({
    commands: ['vscode.openWith']
  });
  mock.setExtension('openai.chatgpt', {
    isActive: true,
    activate: async () => {}
  });

  const { mod, restore } = loadWarmupModule(mock);
  try {
    const restored = await mod.warmUpCodexAfterProfileSwitch(
      'commands-missing',
      createLogger(),
      {
        restoreChatContext: { kind: 'sidebar', source: 'unit-test' },
        showErrorMessage: false,
        commandReadyTimeoutMs: 5,
        commandTimeoutMs: 50,
        pollIntervalMs: 1
      }
    );

    assert.equal(restored, false);
    assert.deepEqual(mock.commandCalls, []);
  } finally {
    restore();
  }
});
