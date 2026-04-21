'use strict';

const vscode = require('vscode');

const CODEX_AVAILABLE_CONTEXT = 'codexTerminalRecorder.codexAvailable';
const CODEX_FILE_ATTACHMENT_AVAILABLE_CONTEXT =
  'codexTerminalRecorder.codexFileAttachmentAvailable';
const TERMINAL_SELECTION_SEND_AVAILABLE_CONTEXT =
  'codexTerminalRecorder.terminalSelectionSendAvailable';

const {
  isSendToCodexEnabled,
  loadConfiguration,
  TERMINAL_CONTEXT_SEND_MODES
} = require('../config');

class CodexAvailabilityController {
  constructor(codexCommandClient, logger) {
    this.codexCommandClient = codexCommandClient;
    this.logger = logger;
    this.available = false;
    this.fileAttachmentAvailable = false;
    this.selectionCommandAvailable = false;
    this.terminalSelectionSendAvailable = false;
    this.initialized = false;
    this.disposables = [];
    this.onDidChangeAvailabilityEmitter = new vscode.EventEmitter();
    this.onDidChangeAvailability = this.onDidChangeAvailabilityEmitter.event;
  }

  activate() {
    this.disposables.push(
      vscode.extensions.onDidChange(() => {
        void this.refresh(true);
      })
    );

    void this.refresh(true);
  }

  isAvailable() {
    return this.available;
  }

  isFileAttachmentAvailable() {
    return this.fileAttachmentAvailable;
  }

  isSelectionCommandAvailable() {
    return this.selectionCommandAvailable;
  }

  isTerminalSelectionSendAvailable() {
    return this.terminalSelectionSendAvailable;
  }

  async refresh(forceRefresh = false) {
    const configuration = loadConfiguration();
    if (!isSendToCodexEnabled(configuration)) {
      return this.applyAvailabilityState({
        available: false,
        fileAttachmentAvailable: false,
        selectionCommandAvailable: false,
        terminalSelectionSendAvailable: false
      });
    }

    const selectionCommandAvailable = Boolean(
      await this.codexCommandClient.getSelectionAttachmentCommand({ forceRefresh })
    );
    const fileAttachmentAvailable = Boolean(
      await this.codexCommandClient.getFileAttachmentCommand({ forceRefresh })
    );
    const available = selectionCommandAvailable || fileAttachmentAvailable;
    const terminalSelectionSendAvailable =
      configuration.terminalContextSendMode === TERMINAL_CONTEXT_SEND_MODES.editorSelection
        ? selectionCommandAvailable
        : fileAttachmentAvailable;
    this.logger &&
      this.logger.info('Codex availability refreshed.', {
        available,
        selectionCommandAvailable,
        fileAttachmentAvailable,
        terminalSelectionSendAvailable,
        forceRefresh
      });
    return this.applyAvailabilityState({
      available,
      fileAttachmentAvailable,
      selectionCommandAvailable,
      terminalSelectionSendAvailable
    });
  }

  async applyAvailabilityState(state) {
    const available = Boolean(state && state.available);
    const fileAttachmentAvailable = Boolean(state && state.fileAttachmentAvailable);
    const selectionCommandAvailable = Boolean(state && state.selectionCommandAvailable);
    const terminalSelectionSendAvailable = Boolean(
      state && state.terminalSelectionSendAvailable
    );

    if (
      this.initialized &&
      this.available === available &&
      this.fileAttachmentAvailable === fileAttachmentAvailable &&
      this.selectionCommandAvailable === selectionCommandAvailable &&
      this.terminalSelectionSendAvailable === terminalSelectionSendAvailable
    ) {
      return available;
    }

    this.available = available;
    this.fileAttachmentAvailable = fileAttachmentAvailable;
    this.selectionCommandAvailable = selectionCommandAvailable;
    this.terminalSelectionSendAvailable = terminalSelectionSendAvailable;
    this.initialized = true;
    await vscode.commands.executeCommand('setContext', CODEX_AVAILABLE_CONTEXT, available);
    await vscode.commands.executeCommand(
      'setContext',
      CODEX_FILE_ATTACHMENT_AVAILABLE_CONTEXT,
      fileAttachmentAvailable
    );
    await vscode.commands.executeCommand(
      'setContext',
      TERMINAL_SELECTION_SEND_AVAILABLE_CONTEXT,
      terminalSelectionSendAvailable
    );
    this.onDidChangeAvailabilityEmitter.fire(available);
    return available;
  }

  dispose() {
    for (const disposable of this.disposables.splice(0)) {
      disposable.dispose();
    }

    this.onDidChangeAvailabilityEmitter.dispose();
  }
}

module.exports = {
  CODEX_AVAILABLE_CONTEXT,
  CODEX_FILE_ATTACHMENT_AVAILABLE_CONTEXT,
  TERMINAL_SELECTION_SEND_AVAILABLE_CONTEXT,
  CodexAvailabilityController
};
