'use strict';

const vscode = require('vscode');

const ACTIVATE_AFTER_RESET_OPTION_ID = 'activate-unstarted-counters';
const SHARED_RESET_ACTION = 'Shared reset — clear all';
const ACCOUNT_ONLY_RESET_ACTION = 'Only this account — keep others';

async function showUnexpectedRateLimitResetDecision(options = {}) {
  const selection = await vscode.window.showWarningMessage(
    options.message || 'An early Codex limit reset was detected.',
    {
      modal: true,
      detail:
        options.detail ||
        'Was this a shared OpenAI reset for all paid accounts? The detected account already has fresh server data. Choose the account-only option to leave every other stored counter unchanged.'
    },
    SHARED_RESET_ACTION,
    ACCOUNT_ONLY_RESET_ACTION
  );

  if (selection === SHARED_RESET_ACTION) {
    return 'shared';
  }
  if (selection === ACCOUNT_ONLY_RESET_ACTION) {
    return 'account-only';
  }
  return 'dismissed';
}

async function showPaidLimitResetPrompt(options = {}) {
  const activationOption = {
    id: ACTIVATE_AFTER_RESET_OPTION_ID,
    label: '$(play) Activate counters after reset',
    description: 'Send test.txt to the dedicated archived Codex chat for each account',
    detail:
      'The extension will switch accounts one by one, reuse one service chat per account, send a file containing "тест", archive the chat, and restore the original account.'
  };
  const selections = await vscode.window.showQuickPick(
    [activationOption],
    {
      canPickMany: true,
      ignoreFocusOut: true,
      title: options.title || 'Reset paid Codex limits',
      placeHolder:
        options.placeHolder ||
        'Optionally check automatic counter activation, then press Enter to reset. Esc cancels.'
    }
  );

  if (selections === undefined) {
    return {
      confirmed: false,
      activateAfterReset: false
    };
  }

  return {
    confirmed: true,
    activateAfterReset: selections.some(
      (selection) => selection && selection.id === ACTIVATE_AFTER_RESET_OPTION_ID
    )
  };
}

module.exports = {
  ACCOUNT_ONLY_RESET_ACTION,
  ACTIVATE_AFTER_RESET_OPTION_ID,
  SHARED_RESET_ACTION,
  showUnexpectedRateLimitResetDecision,
  showPaidLimitResetPrompt
};
