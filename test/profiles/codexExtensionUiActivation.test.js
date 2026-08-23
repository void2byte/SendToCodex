'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { createMockVscode, installMockVscode } = require('../helpers/mockVscode');

function loadModule() {
  const mock = createMockVscode({
    overrides: {
      workspace: {
        getConfiguration: () => ({
          get: (_key, fallback) => fallback
        })
      }
    }
  });
  const restore = installMockVscode(mock.vscode);
  for (const modulePath of [
    '../../src/profiles/codexExtensionUiActivation',
    '../../src/profiles/authManager',
    '../../src/codex/CodexPostSwitchWarmup',
    '../../src/codex/CodexSidebarConversation'
  ]) {
    delete require.cache[require.resolve(modulePath)];
  }
  const module = require('../../src/profiles/codexExtensionUiActivation');
  restore();
  return { module, mock };
}

test('official Codex log classifier recognizes revoked and forced-login sessions', () => {
  const { module } = loadModule();

  assert.equal(
    module.isAuthRequiredText(
      'Failed to refresh token: 401 Unauthorized; auth error code: token_revoked'
    ),
    true
  );
  assert.equal(
    module.isAuthRequiredText(
      "The active credentials don't match the configured restrictions"
    ),
    true
  );
  assert.equal(
    module.isAuthRequiredText('Error fetching httpStatus=403 url=/settings/user'),
    false
  );
  assert.equal(
    module.isUiReadyText('[startup][renderer] app routes mounted after 7000ms'),
    true
  );
});

test('official session observer reads the completed assistant answer', () => {
  const { module } = loadModule();
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'codex-extension-turn-state-test-')
  );
  const sessionPath = path.join(directory, 'rollout-test.jsonl');
  const records = [
    {
      timestamp: new Date().toISOString(),
      type: 'event_msg',
      payload: { type: 'task_started', turn_id: 'turn-test' }
    },
    {
      timestamp: new Date().toISOString(),
      type: 'event_msg',
      payload: {
        type: 'agent_message',
        phase: 'final_answer',
        message: 'Готово.'
      }
    },
    {
      timestamp: new Date().toISOString(),
      type: 'event_msg',
      payload: {
        type: 'task_complete',
        turn_id: 'turn-test',
        last_agent_message: 'Готово.'
      }
    }
  ];
  fs.writeFileSync(
    sessionPath,
    `${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
    'utf8'
  );

  try {
    assert.deepEqual(module.readOfficialTurnState(sessionPath), {
      completed: true,
      turnId: 'turn-test',
      responseText: 'Готово.',
      error: null
    });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('official extension mode submits only to the worker window and closes its exact tab', async () => {
  const { module, mock } = loadModule();
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'codex-extension-ui-activation-test-')
  );
  const logPath = path.join(directory, 'Codex.log');
  fs.writeFileSync(logPath, '', 'utf8');
  const tab = {
    input: {
      viewType: 'chatgpt.conversationEditor',
      uri: {
        scheme: 'openai-codex',
        toString: () => 'openai-codex://route/extension/panel/new'
      }
    }
  };
  mock.setCommands(['chatgpt.newCodexPanel']);
  mock.setExtension('openai.chatgpt', {
    isActive: true,
    async activate() {}
  });
  mock.setTabGroups([{ tabs: [tab], activeTab: tab }]);
  let sent = null;
  let closedTab = null;
  const focusCalls = [];
  const phases = [];
  const activator = new module.CodexExtensionUiActivator(null, {
    codexLogPath: logPath,
    visibilityMs: 0,
    composerSettleMs: 0,
    openNewPanel: async () => tab,
    closePanelTab: async (value) => {
      closedTab = value;
      return true;
    },
    focusWorkerWindow: (titleToken, expectedWindowId) => {
      focusCalls.push({ titleToken, expectedWindowId });
      return { title: titleToken, windowId: 'worker-hwnd' };
    },
    sendTextAndEnter: (titleToken, prompt, options) => {
      sent = { titleToken, prompt, options };
    },
    waitForUiReady: async () => ({ offset: 0, diagnostics: 'ui ready' }),
    waitForConversationCreated: async () => ({
      threadId: '11111111-2222-4333-8444-555555555555',
      offset: 0,
      diagnostics: 'conversation created'
    }),
    waitForTurnCompletion: async () => ({
      responseText: 'Ответ.',
      turnId: 'turn-test',
      diagnostics: 'turn complete'
    })
  });

  try {
    const result = await activator.run({
      windowTitleToken: 'worker-job-test',
      onState: (phase) => phases.push(phase)
    });

    assert.deepEqual(sent, {
      titleToken: 'worker-job-test',
      prompt: 'тест',
      options: { expectedWindowId: 'worker-hwnd' }
    });
    assert.deepEqual(focusCalls, [
      { titleToken: 'worker-job-test', expectedWindowId: undefined },
      { titleToken: 'worker-job-test', expectedWindowId: 'worker-hwnd' }
    ]);
    assert.equal(closedTab, tab);
    assert.equal(result.threadId, '11111111-2222-4333-8444-555555555555');
    assert.equal(result.responseText, 'Ответ.');
    assert.equal(result.archived, false);
    assert.match(result.diagnostics, /official Codex VS Code extension UI/i);
    assert.deepEqual(phases, [
      'checking-codex-auth',
      'typing-test',
      'waiting-for-chat',
      'waiting-for-answer'
    ]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('official extension mode aborts before input when worker-window ownership changes', async () => {
  const { module, mock } = loadModule();
  mock.setCommands(['chatgpt.newCodexPanel']);
  mock.setExtension('openai.chatgpt', {
    isActive: true,
    async activate() {}
  });
  const tab = {
    input: {
      viewType: 'chatgpt.conversationEditor',
      uri: { scheme: 'openai-codex' }
    }
  };
  let focusCount = 0;
  let sent = false;
  let closedTab = null;
  const activator = new module.CodexExtensionUiActivator(null, {
    codexLogPath: '',
    openNewPanel: async () => tab,
    closePanelTab: async (value) => {
      closedTab = value;
      return true;
    },
    focusWorkerWindow: (_titleToken, expectedWindowId) => {
      focusCount += 1;
      if (expectedWindowId) {
        throw new Error('worker HWND changed');
      }
      return { title: 'worker', windowId: 'original-hwnd' };
    },
    sendTextAndEnter: () => {
      sent = true;
    }
  });

  await assert.rejects(
    activator.run({ windowTitleToken: 'worker-job-test' }),
    (error) => {
      assert.equal(error.activationState, 'ui-unavailable');
      assert.match(error.message, /did not remain in its dedicated worker window/i);
      return true;
    }
  );
  assert.equal(focusCount, 2);
  assert.equal(sent, false);
  assert.equal(closedTab, tab);
});
