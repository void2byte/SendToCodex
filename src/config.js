'use strict';

const vscode = require('vscode');

const CONFIG_SECTION = 'codexTerminalRecorder';
const OUTPUT_CHANNEL_NAME = 'Send to Codex';
const PROPOSED_API_HINT =
  'Terminal capture requires VS Code Insiders (or extension development mode) with --enable-proposed-api=local.codex-terminal-recorder.';
const DIAGNOSTICS_LOGGING_ENABLED_DEFAULT = false;
const DIAGNOSTICS_LOG_FILE_ENABLED_DEFAULT = false;
const TERMINAL_CONTEXT_SEND_MODES = {
  contextBundle: 'contextBundle',
  attachmentFile: 'attachmentFile',
  editorSelection: 'editorSelection'
};
const SELECTION_TRACKING_STRATEGIES = {
  terminalSelectionTextSearch: 'terminalSelectionTextSearch',
  indexedTerminalSelectionSearch: 'indexedTerminalSelectionSearch',
  clipboardTextSearch: 'clipboardTextSearch'
};

function loadConfiguration() {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const parsedMaxFileSizeMb = Number(config.get('maxFileSizeMb', 1));
  const maxFileSizeMb =
    Number.isFinite(parsedMaxFileSizeMb) && parsedMaxFileSizeMb > 0
      ? parsedMaxFileSizeMb
      : 1;
  const configuredSelectionStrategy = String(
    config.get(
      'selectionTrackingStrategy',
      SELECTION_TRACKING_STRATEGIES.terminalSelectionTextSearch
    )
  );
  const selectionTrackingStrategy = Object.values(SELECTION_TRACKING_STRATEGIES).includes(
    configuredSelectionStrategy
  )
    ? configuredSelectionStrategy
    : SELECTION_TRACKING_STRATEGIES.terminalSelectionTextSearch;
  const parsedSelectionContextLines = Number(config.get('selectionContextLines', 3));
  const selectionContextLines =
    Number.isFinite(parsedSelectionContextLines) && parsedSelectionContextLines >= 0
      ? Math.min(50, Math.round(parsedSelectionContextLines))
      : 3;
  const configuredTerminalContextSendMode = String(
    config.get('terminalContextSendMode', TERMINAL_CONTEXT_SEND_MODES.contextBundle)
  );
  const terminalContextSendMode = Object.values(TERMINAL_CONTEXT_SEND_MODES).includes(
    configuredTerminalContextSendMode
  )
    ? configuredTerminalContextSendMode
    : TERMINAL_CONTEXT_SEND_MODES.contextBundle;

  return {
    enabled: config.get('enabled', true),
    logDirectory: normalizeLogDirectory(config.get('logDirectory', '')),
    maxBytes: Math.max(1, Math.round(maxFileSizeMb * 1024 * 1024)),
    selectionTrackingStrategy,
    selectionContextLines,
    terminalContextSendMode,
    diagnosticsLoggingEnabled: config.get(
      'diagnosticsLoggingEnabled',
      DIAGNOSTICS_LOGGING_ENABLED_DEFAULT
    ),
    diagnosticsLogFileEnabled: config.get(
      'diagnosticsLogFileEnabled',
      DIAGNOSTICS_LOG_FILE_ENABLED_DEFAULT
    ),
    showNativeTerminalSelectionPopup: config.get('showNativeTerminalSelectionPopup', true),
    showNativeEditorSelectionPopup: config.get('showNativeEditorSelectionPopup', true),
    showCodexSelectionButton: config.get('showCodexSelectionButton', false),
    showCodexEditorSelectionButton: config.get('showCodexEditorSelectionButton', false)
  };
}

function normalizeLogDirectory(value) {
  const normalized = String(value || '').trim();
  if (!normalized) {
    return '';
  }

  const normalizedSlashes = normalized.replace(/\\/g, '/').replace(/\/+$/g, '');
  if (
    normalizedSlashes === '.codex-terminal-logs' ||
    normalizedSlashes === './.codex-terminal-logs'
  ) {
    return '';
  }

  return normalized;
}

module.exports = {
  CONFIG_SECTION,
  DIAGNOSTICS_LOG_FILE_ENABLED_DEFAULT,
  DIAGNOSTICS_LOGGING_ENABLED_DEFAULT,
  OUTPUT_CHANNEL_NAME,
  PROPOSED_API_HINT,
  SELECTION_TRACKING_STRATEGIES,
  TERMINAL_CONTEXT_SEND_MODES,
  loadConfiguration
};
