'use strict';

const vscode = require('vscode');

class RecorderSettingsStatusBarController {
  constructor(codexAvailabilityController, terminalLogManager, logger) {
    this.codexAvailabilityController = codexAvailabilityController;
    this.terminalLogManager = terminalLogManager;
    this.logger = logger;
    this.statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      998
    );
    this.statusBarItem.command = 'codexTerminalRecorder.openSettings';
    this.statusBarItem.name = 'Send to Codex Settings';
    this.disposables = [];
    this.lastVisibilityState = undefined;
  }

  activate() {
    this.disposables.push(
      this.terminalLogManager.onDidChangeCapturedTerminalCount(() => {
        void this.refresh();
      })
    );

    void this.refresh();
  }

  async refresh() {
    if (!this.codexAvailabilityController.isAvailable()) {
      this.hideWithReason('codex-unavailable');
      this.statusBarItem.hide();
      return;
    }

    const capturedTerminalCount = this.terminalLogManager.getCapturedTerminalCount();
    const terminalsWithOutput = this.terminalLogManager.getCapturedOutputTerminalCount();
    const terminalLabel = capturedTerminalCount === 1 ? 'terminal' : 'terminals';

    this.statusBarItem.text = `$(settings-gear) Send to Codex: ${capturedTerminalCount} ${terminalLabel}`;
    this.statusBarItem.tooltip =
      `Open Send to Codex settings. Tracking ${capturedTerminalCount} ${terminalLabel}; ` +
      `${terminalsWithOutput} currently have captured output.`;
    this.statusBarItem.show();
    this.logVisibilityState('visible', capturedTerminalCount);
  }

  dispose() {
    for (const disposable of this.disposables.splice(0)) {
      disposable.dispose();
    }

    this.statusBarItem.dispose();
  }

  hideWithReason(reason) {
    this.logVisibilityState(reason, this.terminalLogManager.getCapturedTerminalCount());
  }

  logVisibilityState(state, capturedTerminalCount) {
    if (this.lastVisibilityState === state) {
      return;
    }

    this.lastVisibilityState = state;
    this.logger &&
      this.logger.info('Recorder settings status button state changed.', {
        state,
        codexAvailable: this.codexAvailabilityController.isAvailable(),
        capturedTerminalCount
      });
  }
}

module.exports = {
  RecorderSettingsStatusBarController
};
