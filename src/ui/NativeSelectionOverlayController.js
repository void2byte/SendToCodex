'use strict';

const vscode = require('vscode');
const { loadConfiguration } = require('../config');
const { peekTerminalSelectionText } = require('../terminalSelection/selectionSources');
const {
  SEND_EDITOR_TO_CODEX_COMMAND,
  SEND_TO_CODEX_COMMAND,
  SEND_TO_CODEX_SHORTCUT_LABEL
} = require('../codex/constants');

const EDITOR_SOURCE = 'editor';
const TERMINAL_SOURCE = 'terminal';
const POPUP_DEBOUNCE_MS = 260;
const TERMINAL_POLL_INTERVAL_MS = 250;
const WINDOW_BLUR_DISMISS_DELAY_MS = 180;

class NativeSelectionOverlayController {
  constructor(popupPresenter, suppression, logger, codexAvailabilityController) {
    this.popupPresenter = popupPresenter;
    this.suppression = suppression;
    this.logger = logger;
    this.codexAvailabilityController = codexAvailabilityController;
    this.disposables = [];
    this.scheduledTimers = new Map();
    this.currentSelectionKeys = new Map();
    this.lastOfferedKeys = new Map();
    this.pendingDescriptors = new Map();
    this.popupInFlight = false;
    this.activePopupSource = undefined;
    this.terminalIntervalHandle = undefined;
    this.windowBlurTimer = undefined;
    this.terminalIds = new WeakMap();
    this.nextTerminalId = 1;
  }

  activate() {
    this.disposables.push(
      vscode.window.onDidChangeWindowState((state) => {
        this.handleWindowStateChange(state);
      }),
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        this.syncEditorSelection(editor);
      }),
      vscode.window.onDidChangeTextEditorSelection((event) => {
        if (event.textEditor === vscode.window.activeTextEditor) {
          this.handleEditorSelectionEvent(event);
        }
      }),
      vscode.window.onDidChangeActiveTerminal(() => {
        this.pollTerminalSelection();
      })
    );

    this.terminalIntervalHandle = setInterval(() => {
      this.pollTerminalSelection();
    }, TERMINAL_POLL_INTERVAL_MS);

    this.syncEditorSelection(vscode.window.activeTextEditor);
    this.pollTerminalSelection();
  }

  dispose() {
    for (const disposable of this.disposables.splice(0)) {
      disposable.dispose();
    }

    if (this.terminalIntervalHandle) {
      clearInterval(this.terminalIntervalHandle);
      this.terminalIntervalHandle = undefined;
    }

    this.clearWindowBlurTimer();

    for (const timer of this.scheduledTimers.values()) {
      clearTimeout(timer);
    }

    this.scheduledTimers.clear();
    this.popupPresenter.dispose();
  }

  syncEditorSelection(editor) {
    const descriptor = buildEditorDescriptor(editor);
    if (!isNativeEditorPopupEnabled() || !this.isPopupSupported()) {
      this.clearSource(EDITOR_SOURCE, 'editor-popup-disabled');
      return;
    }

    if (!descriptor) {
      this.clearSource(EDITOR_SOURCE, 'editor-selection-cleared');
      return;
    }

    this.recordSilentSelection(EDITOR_SOURCE, descriptor.key, 'editor-activation');
  }

  handleEditorSelectionEvent(event) {
    if (!isNativeEditorPopupEnabled() || !this.isPopupSupported()) {
      this.clearSource(EDITOR_SOURCE, 'editor-popup-disabled');
      return;
    }

    const descriptor = buildEditorDescriptor(event.textEditor);
    if (!descriptor) {
      this.clearSource(EDITOR_SOURCE, 'editor-selection-cleared');
      return;
    }

    if (!isUserInitiatedEditorSelection(event.kind)) {
      this.recordSilentSelection(EDITOR_SOURCE, descriptor.key, 'non-user-editor-selection');
      return;
    }

    this.scheduleDescriptor(descriptor);
  }

  pollTerminalSelection() {
    if (
      this.codexAvailabilityController &&
      !this.codexAvailabilityController.isTerminalSelectionSendAvailable()
    ) {
      this.clearSource(TERMINAL_SOURCE, 'terminal-send-unavailable');
      return;
    }

    if (!isNativeTerminalPopupEnabled() || !this.isPopupSupported()) {
      this.clearSource(TERMINAL_SOURCE, 'terminal-popup-disabled');
      return;
    }

    const descriptor = this.buildTerminalDescriptor();
    if (!descriptor) {
      this.clearSource(TERMINAL_SOURCE, 'terminal-selection-cleared');
      return;
    }

    if (this.currentSelectionKeys.get(TERMINAL_SOURCE) === descriptor.key) {
      return;
    }

    this.scheduleDescriptor(descriptor);
  }

  recordSilentSelection(source, key, reason) {
    this.currentSelectionKeys.set(source, key);
    this.lastOfferedKeys.set(source, key);
    this.pendingDescriptors.delete(source);
    this.clearScheduledTimer(source);
    this.logger &&
      this.logger.info('Native selection popup skipped for current selection.', {
        source,
        reason
      });
  }

  scheduleDescriptor(descriptor, delayMs = POPUP_DEBOUNCE_MS) {
    this.currentSelectionKeys.set(descriptor.source, descriptor.key);
    this.pendingDescriptors.delete(descriptor.source);

    if (this.lastOfferedKeys.get(descriptor.source) === descriptor.key) {
      return;
    }

    this.clearScheduledTimer(descriptor.source);
    const timer = setTimeout(() => {
      this.scheduledTimers.delete(descriptor.source);
      void this.maybeShowDescriptor(descriptor);
    }, delayMs);

    this.scheduledTimers.set(descriptor.source, timer);
  }

  async maybeShowDescriptor(descriptor) {
    if (!this.isPopupSupported()) {
      this.clearSource(descriptor.source, 'popup-presenter-unsupported');
      return;
    }

    if (!isWindowFocused()) {
      this.clearSource(descriptor.source, 'window-not-focused');
      return;
    }

    if (this.currentSelectionKeys.get(descriptor.source) !== descriptor.key) {
      return;
    }

    if (this.lastOfferedKeys.get(descriptor.source) === descriptor.key) {
      return;
    }

    if (this.suppression.isSuppressed()) {
      const delayMs = Math.max(POPUP_DEBOUNCE_MS, this.suppression.getRemainingMs() + 50);
      this.scheduleDescriptor(descriptor, delayMs);
      return;
    }

    if (this.popupInFlight) {
      this.pendingDescriptors.set(descriptor.source, descriptor);
      return;
    }

    this.popupInFlight = true;
    this.activePopupSource = descriptor.source;
    this.lastOfferedKeys.set(descriptor.source, descriptor.key);

    this.logger &&
      this.logger.info('Showing native selection popup.', {
        source: descriptor.source,
        key: descriptor.key
      });

    try {
      const result = await this.popupPresenter.showAction({
        label: descriptor.label,
        offsetX: 12,
        offsetY: 18,
        shortcutLabel: SEND_TO_CODEX_SHORTCUT_LABEL,
        source: descriptor.source
      });

      this.logger &&
        this.logger.info('Native selection popup completed.', {
          source: descriptor.source,
          action: result.action,
          message: result.message,
          stderr: result.stderr,
          stdout: result.stdout
        });

      if (result.action === 'invoke') {
        this.suppression.suppress(1500, `native-selection-popup-${descriptor.source}`);
        await vscode.commands.executeCommand(descriptor.command);
      } else if (result.action === 'skip') {
        this.suppression.suppress(1200, `native-selection-popup-skip-${descriptor.source}`);
      } else if (result.action === 'error') {
        void vscode.window.setStatusBarMessage(
          `Native selection popup failed. Use ${SEND_TO_CODEX_SHORTCUT_LABEL} or enable the status bar fallback button in settings.`,
          5000
        );
      }
    } finally {
      this.activePopupSource = undefined;
      this.popupInFlight = false;
      await this.flushPendingDescriptors();
    }
  }

  handleWindowStateChange(state) {
    if (state && state.focused) {
      this.clearWindowBlurTimer();
      this.syncEditorSelection(vscode.window.activeTextEditor);
      this.pollTerminalSelection();
      return;
    }

    if (this.popupInFlight) {
      this.scheduleWindowBlurDismiss();
      return;
    }

    this.clearAllSources('window-blurred');
  }

  async flushPendingDescriptors() {
    if (this.popupInFlight) {
      return;
    }

    for (const [source, descriptor] of Array.from(this.pendingDescriptors.entries())) {
      this.pendingDescriptors.delete(source);

      if (descriptor && this.currentSelectionKeys.get(source) === descriptor.key) {
        await this.maybeShowDescriptor(descriptor);
        break;
      }
    }
  }

  clearSource(source, reason) {
    const hadState =
      this.currentSelectionKeys.has(source) ||
      this.lastOfferedKeys.has(source) ||
      this.pendingDescriptors.has(source) ||
      this.scheduledTimers.has(source);

    this.currentSelectionKeys.delete(source);
    this.lastOfferedKeys.delete(source);
    this.pendingDescriptors.delete(source);
    this.clearScheduledTimer(source);
    if (!hadState) {
      return;
    }

    if (this.activePopupSource === source && this.popupPresenter) {
      this.popupPresenter.dispose();
    }

    this.logger &&
      this.logger.info('Native selection popup source cleared.', {
        source,
        reason
      });
  }

  clearAllSources(reason) {
    this.clearSource(EDITOR_SOURCE, reason);
    this.clearSource(TERMINAL_SOURCE, reason);
  }

  scheduleWindowBlurDismiss() {
    this.clearWindowBlurTimer();
    this.windowBlurTimer = setTimeout(() => {
      this.windowBlurTimer = undefined;

      if (!isWindowFocused() && this.popupInFlight) {
        this.clearAllSources('window-blurred');
      }
    }, WINDOW_BLUR_DISMISS_DELAY_MS);
  }

  clearWindowBlurTimer() {
    if (!this.windowBlurTimer) {
      return;
    }

    clearTimeout(this.windowBlurTimer);
    this.windowBlurTimer = undefined;
  }

  clearScheduledTimer(source) {
    const timer = this.scheduledTimers.get(source);
    if (!timer) {
      return;
    }

    clearTimeout(timer);
    this.scheduledTimers.delete(source);
  }

  isPopupSupported() {
    return !this.popupPresenter || typeof this.popupPresenter.isSupported !== 'function'
      ? false
      : this.popupPresenter.isSupported();
  }

  buildTerminalDescriptor() {
    const terminal = vscode.window.activeTerminal;
    const selection = peekTerminalSelectionText(terminal);
    const normalizedSelection = selection.trim();

    if (!terminal || !normalizedSelection) {
      return null;
    }

    return {
      command: SEND_TO_CODEX_COMMAND,
      key: `${this.getTerminalSessionId(terminal)}:${hashText(normalizedSelection)}`,
      label: 'Send to Codex',
      source: TERMINAL_SOURCE
    };
  }

  getTerminalSessionId(terminal) {
    const existing = this.terminalIds.get(terminal);
    if (existing) {
      return existing;
    }

    const nextId = `terminal-${String(this.nextTerminalId).padStart(3, '0')}`;
    this.nextTerminalId += 1;
    this.terminalIds.set(terminal, nextId);
    return nextId;
  }
}

function buildEditorDescriptor(editor) {
  if (
    !editor ||
    !editor.document ||
    editor.document.uri.scheme !== 'file' ||
    isGeneratedSelectionFallbackFile(editor.document.uri.fsPath) ||
    !editor.selection ||
    editor.selection.isEmpty
  ) {
    return null;
  }

  return {
    command: SEND_EDITOR_TO_CODEX_COMMAND,
    key: [
      editor.document.uri.fsPath,
      editor.document.version,
      editor.selection.start.line,
      editor.selection.start.character,
      editor.selection.end.line,
      editor.selection.end.character
    ].join(':'),
    label: 'Send to Codex',
    source: EDITOR_SOURCE
  };
}

function hashText(value) {
  let hash = 5381;

  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) + hash + value.charCodeAt(index)) >>> 0;
  }

  return String(hash);
}

function isNativeEditorPopupEnabled() {
  return Boolean(
    loadConfiguration().showNativeEditorSelectionPopup &&
      (process.platform === 'win32' || process.platform === 'darwin')
  );
}

function isNativeTerminalPopupEnabled() {
  return Boolean(
    loadConfiguration().showNativeTerminalSelectionPopup &&
      (process.platform === 'win32' || process.platform === 'darwin')
  );
}

function isUserInitiatedEditorSelection(kind) {
  return (
    kind === undefined ||
    kind === vscode.TextEditorSelectionChangeKind.Mouse ||
    kind === vscode.TextEditorSelectionChangeKind.Keyboard
  );
}

function isWindowFocused() {
  return !vscode.window.state || vscode.window.state.focused !== false;
}

function isGeneratedSelectionFallbackFile(filePath) {
  const normalized = String(filePath || '').toLowerCase();
  return /\.selection(?:-[^.]+)?\.(txt|md)$/i.test(normalized);
}

module.exports = {
  NativeSelectionOverlayController
};
