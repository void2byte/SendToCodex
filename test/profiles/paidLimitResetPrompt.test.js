'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createMockVscode, installMockVscode } = require('../helpers/mockVscode');

function loadPrompt(selection) {
  const mock = createMockVscode({
    overrides: {
      window: {
        showQuickPick: async (items, options) => {
          mock.quickPickCalls.push({ items, options });
          return selection;
        }
      }
    }
  });
  const restore = installMockVscode(mock.vscode);
  delete require.cache[require.resolve('../../src/profiles/paidLimitResetPrompt')];
  const module = require('../../src/profiles/paidLimitResetPrompt');
  restore();
  return { module, mock };
}

function loadResetDecision(selection) {
  const warningCalls = [];
  const mock = createMockVscode({
    overrides: {
      window: {
        showWarningMessage: async (...args) => {
          warningCalls.push(args);
          return selection;
        }
      }
    }
  });
  const restore = installMockVscode(mock.vscode);
  delete require.cache[require.resolve('../../src/profiles/paidLimitResetPrompt')];
  const module = require('../../src/profiles/paidLimitResetPrompt');
  restore();
  return { module, warningCalls };
}

test('early-reset decision requires an explicit shared-reset action', async () => {
  const initial = loadResetDecision(undefined);
  assert.equal(await initial.module.showUnexpectedRateLimitResetDecision(), 'dismissed');

  const accountOnly = loadResetDecision(initial.module.ACCOUNT_ONLY_RESET_ACTION);
  assert.equal(
    await accountOnly.module.showUnexpectedRateLimitResetDecision(),
    'account-only'
  );

  const shared = loadResetDecision(initial.module.SHARED_RESET_ACTION);
  assert.equal(await shared.module.showUnexpectedRateLimitResetDecision(), 'shared');
  assert.equal(shared.warningCalls[0][1].modal, true);
  assert.match(shared.warningCalls[0][1].detail, /leave every other stored counter unchanged/i);
});

test('paid-limit reset prompt exposes automatic counter activation as a checkbox', async () => {
  const { module, mock } = loadPrompt([]);
  const result = await module.showPaidLimitResetPrompt();

  assert.deepEqual(result, {
    confirmed: true,
    activateAfterReset: false
  });
  assert.equal(mock.quickPickCalls.length, 1);
  assert.equal(mock.quickPickCalls[0].options.canPickMany, true);
  assert.equal(mock.quickPickCalls[0].items[0].id, module.ACTIVATE_AFTER_RESET_OPTION_ID);
});

test('paid-limit reset prompt reports the checked activation option', async () => {
  const { module } = loadPrompt([
    { id: 'activate-unstarted-counters' }
  ]);

  assert.deepEqual(await module.showPaidLimitResetPrompt(), {
    confirmed: true,
    activateAfterReset: true
  });
});

test('paid-limit reset prompt treats Escape as cancellation', async () => {
  const { module } = loadPrompt(undefined);

  assert.deepEqual(await module.showPaidLimitResetPrompt(), {
    confirmed: false,
    activateAfterReset: false
  });
});
