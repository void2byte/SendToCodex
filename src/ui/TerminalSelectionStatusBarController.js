'use strict';

const vscode = require('vscode');
const { loadConfiguration } = require('../config');
const { peekTerminalSelectionText } = require('../terminalSelection/selectionSources');
const {
  SEND_TO_CODEX_COMMAND,
  SEND_TO_CODEX_SHORTCUT_LABEL
} = require('../codex/constants');

class TerminalSelectionStatusBarController {
  constructor(codexAvailabilityController, logger) {
    this.codexAvailabilityController = codexAvailabilityController;
    this.logger = logger;
    this.statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      1000
    );
    this.statusBarItem.command = SEND_TO_CODEX_COMMAND;
    this.statusBarItem.name = 'Send to Codex';
    this.intervalHandle = undefined;
    this.lastVisibilityState = undefined;
  }

  activate() {
    this.intervalHandle = setInterval(() => {
      void this.refresh();
    }, 250);

    void this.refresh();
  }

  async refresh() {
    const configuration = loadConfiguration();
    if (!configuration.sendToCodexEnabled) {
      this.hideWithReason('send-disabled');
      this.statusBarItem.hide();
      return;
    }

    if (!this.codexAvailabilityController.isTerminalSelectionSendAvailable()) {
      this.hideWithReason('terminal-send-unavailable');
      this.statusBarItem.hide();
      return;
    }

    if (!configuration.showCodexSelectionButton) {
      this.hideWithReason('disabled-by-setting');
      this.statusBarItem.hide();
      return;
    }

    const terminal = vscode.window.activeTerminal;
    const selection = peekTerminalSelectionText(terminal);

    if (!selection.trim()) {
      this.hideWithReason('no-terminal-selection');
      this.statusBarItem.hide();
      return;
    }

    this.statusBarItem.text = `$(comment-discussion) Send to Codex (${SEND_TO_CODEX_SHORTCUT_LABEL})`;
    this.statusBarItem.tooltip =
      'Send the resolved terminal selection context to Codex Chat.';
    this.statusBarItem.show();
    this.logVisibilityState('visible');
  }

  dispose() {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = undefined;
    }

    this.statusBarItem.dispose();
  }

  hideWithReason(reason) {
    this.logVisibilityState(reason);
  }

  logVisibilityState(state) {
    if (this.lastVisibilityState === state) {
      return;
    }

    this.lastVisibilityState = state;
    this.logger &&
      this.logger.info('Terminal Codex status button state changed.', {
        state,
        codexAvailable: this.codexAvailabilityController.isAvailable()
      });
  }
}

module.exports = {
  TerminalSelectionStatusBarController
};
