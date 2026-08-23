'use strict';

const vscode = require('vscode');
const { loadConfiguration } = require('../config');
const {
  SEND_EDITOR_TO_CODEX_COMMAND,
  SEND_TO_CODEX_SHORTCUT_LABEL
} = require('../codex/constants');

class EditorSelectionStatusBarController {
  constructor(codexAvailabilityController, logger) {
    this.codexAvailabilityController = codexAvailabilityController;
    this.logger = logger;
    this.statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      999
    );
    this.statusBarItem.command = SEND_EDITOR_TO_CODEX_COMMAND;
    this.statusBarItem.name = 'Send Selection to Codex';
    this.statusBarItem.text = `$(code) Send to Codex (${SEND_TO_CODEX_SHORTCUT_LABEL})`;
    this.statusBarItem.tooltip = 'Send the active editor selection to Codex Chat.';
    this.disposables = [];
    this.isVisible = false;
    this.lastVisibilityState = undefined;
  }

  activate() {
    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor(() => {
        void this.refresh();
      }),
      vscode.window.onDidChangeTextEditorSelection((event) => {
        if (event.textEditor === vscode.window.activeTextEditor) {
          void this.refresh();
        }
      })
    );

    void this.refresh();
  }

  async refresh() {
    const configuration = loadConfiguration();
    if (!configuration.sendToCodexEnabled) {
      this.setVisible(false, 'send-disabled');
      return;
    }

    if (!this.codexAvailabilityController.isAvailable()) {
      this.setVisible(false, 'codex-unavailable');
      return;
    }

    if (!configuration.showCodexEditorSelectionButton) {
      this.setVisible(false, 'disabled-by-setting');
      return;
    }

    const editor = vscode.window.activeTextEditor;
    if (!hasSupportedEditorSelection(editor)) {
      this.setVisible(false, 'no-file-selection');
      return;
    }

    this.setVisible(true, 'visible');
  }

  dispose() {
    for (const disposable of this.disposables.splice(0)) {
      disposable.dispose();
    }

    this.statusBarItem.dispose();
  }

  setVisible(visible, reason) {
    if (this.isVisible !== visible) {
      this.isVisible = visible;
      if (visible) {
        this.statusBarItem.show();
      } else {
        this.statusBarItem.hide();
      }
    }

    this.logVisibilityState(reason);
  }

  logVisibilityState(state) {
    if (this.lastVisibilityState === state) {
      return;
    }

    this.lastVisibilityState = state;
    this.logger &&
      this.logger.info('Editor Codex status button state changed.', {
        state,
        codexAvailable: this.codexAvailabilityController.isAvailable()
      });
  }
}

function hasSupportedEditorSelection(editor) {
  return Boolean(
    editor &&
      editor.document &&
      editor.document.uri.scheme === 'file' &&
      editor.selection &&
      !editor.selection.isEmpty
  );
}

module.exports = {
  EditorSelectionStatusBarController
};
