'use strict';

const vscode = require('vscode');
const { getClipboardSequenceNumber } = require('../native/clipboard');
const {
  rememberTerminalSelectionText,
  runWithTerminalSelectionCacheSuppressed
} = require('../terminalSelection/selectionSources');

const COPY_SELECTION_COMMAND = 'workbench.action.terminal.copySelection';
const SELECT_ALL_COMMAND = 'workbench.action.terminal.selectAll';
const CLEAR_SELECTION_COMMAND = 'workbench.action.terminal.clearSelection';
const TERMINAL_FOCUS_COMMAND = 'workbench.action.terminal.focus';
const TERMINAL_FOCUS_ACCESSIBLE_BUFFER_COMMAND = 'workbench.action.terminal.focusAccessibleBuffer';
const EDITOR_SELECT_ALL_COMMAND = 'editor.action.selectAll';
const EDITOR_COPY_COMMAND = 'editor.action.clipboardCopyAction';
const ACCESSIBLE_VIEW_COMMAND = 'editor.action.accessibleView';
const CLIPBOARD_SENTINEL_PREFIX = '__codex_terminal_snapshot__';

class TerminalCommandSnapshotter {
  constructor(output, logger) {
    this.output = output;
    this.logger = logger;
    this.snapshotQueue = Promise.resolve();
  }

  async captureLastCommandSnapshot(terminal, state) {
    const runCapture = async () => this.captureLastCommandSnapshotOnce(terminal, state);
    const queuedCapture = this.snapshotQueue.catch(() => undefined).then(runCapture, runCapture);
    this.snapshotQueue = queuedCapture.then(() => undefined, () => undefined);
    return queuedCapture;
  }

  async captureLastCommandSnapshotOnce(terminal, state) {
    if (!terminal || !state || terminal !== vscode.window.activeTerminal) {
      return {
        captured: false,
        reason: 'inactive-terminal'
      };
    }

    const clipboardState = await createClipboardSnapshotState();

    try {
      await armClipboardSnapshotState(clipboardState);

      let copiedText = await this.tryCopyVisibleBufferSnapshot(terminal, clipboardState);
      let mode = 'visible-buffer';

      if (!copiedText) {
        copiedText = await this.tryCopyAccessibleBufferSnapshot(terminal, clipboardState);
        mode = 'accessible-buffer';
      }
      if (!copiedText) {
        return {
          captured: false,
          reason: 'no-terminal-output'
        };
      }

      const normalizedText = normalizeSnapshotText(copiedText);
      if (!normalizedText.trim()) {
        return {
          captured: false,
          reason: 'empty-terminal-output'
        };
      }

      const replaced = replaceSnapshotBuffers(state, normalizedText);
      if (!replaced.changed) {
        return {
          captured: false,
          reason:
            mode === 'accessible-buffer' ? 'duplicate-accessible-buffer' : 'duplicate-visible-buffer'
        };
      }

      await state.sink.flush();
      return {
        captured: true,
        reason: mode === 'accessible-buffer' ? 'captured-accessible-buffer' : 'captured-visible-buffer',
        text: normalizedText,
        mode
      };
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      this.logger &&
        this.logger.warn('Terminal snapshot failed.', {
          terminalName: terminal.name,
          error: message
        });
      this.output.appendLine(`Failed to capture terminal snapshot: ${message}`);
      return {
        captured: false,
        reason: 'snapshot-error',
        error: message
      };
    } finally {
      try {
        await restoreClipboardSnapshotState(clipboardState);
      } catch (restoreError) {
        const restoreMessage =
          restoreError && restoreError.message ? restoreError.message : String(restoreError);
        this.logger &&
          this.logger.warn('Failed to restore clipboard after terminal snapshot.', {
            error: restoreMessage
          });
      }
    }
  }

  async tryCopyVisibleBufferSnapshot(terminal, clipboardState) {
    const originalSelection = readTerminalSelectionText(terminal);
    rememberTerminalSelectionText(terminal, originalSelection);

    try {
      return await runWithTerminalSelectionCacheSuppressed(async () => {
        try {
          for (const selectionDelay of [120, 220]) {
            await focusTerminal(terminal);
            await clearTerminalSelection();
            await delay(40);
            await vscode.commands.executeCommand(SELECT_ALL_COMMAND);
            await delay(selectionDelay);

            const selectedAfterSelectAll = readTerminalSelectionText(terminal);
            await vscode.commands.executeCommand(COPY_SELECTION_COMMAND);
            await delay(100);

            const copiedText = await vscode.env.clipboard.readText();
            if (!didClipboardSnapshotCaptureText(copiedText, clipboardState)) {
              continue;
            }

            const normalizedOriginalSelection = normalizeSelectionText(originalSelection);
            const normalizedCopiedText = normalizeSnapshotText(copiedText);
            if (
              normalizedOriginalSelection &&
              normalizedCopiedText === normalizedOriginalSelection &&
              !selectionLooksExpanded(originalSelection, selectedAfterSelectAll)
            ) {
              this.logger &&
                this.logger.info(
                  'Terminal select-all snapshot did not expand beyond the user selection.',
                  {
                    selectionLength: normalizedOriginalSelection.length,
                    attemptDelay: selectionDelay
                  }
                );
              continue;
            }

            return copiedText;
          }

          return '';
        } finally {
          try {
            await clearTerminalSelection();
          } catch (clearError) {
            this.logger &&
              this.logger.warn('Failed to clear terminal selection after buffer snapshot.', {
                error: clearError && clearError.message ? clearError.message : String(clearError)
              });
          }
        }
      });
    } catch (error) {
      this.logger &&
        this.logger.warn('Terminal visible buffer snapshot failed.', {
          error: error && error.message ? error.message : String(error)
        });
      return '';
    }
  }

  async tryCopyAccessibleBufferSnapshot(terminal, clipboardState) {
    let openedAccessibleBuffer = false;

    try {
      await focusTerminal(terminal);
      await vscode.commands.executeCommand(TERMINAL_FOCUS_ACCESSIBLE_BUFFER_COMMAND);
      openedAccessibleBuffer = true;
      await delay(160);
      await vscode.commands.executeCommand(EDITOR_SELECT_ALL_COMMAND);
      await delay(80);

      for (const commandId of [EDITOR_COPY_COMMAND, 'copy']) {
        await vscode.commands.executeCommand(commandId);
        await delay(100);
        const copiedText = await vscode.env.clipboard.readText();
        if (didClipboardSnapshotCaptureText(copiedText, clipboardState)) {
          return copiedText;
        }
      }

      return '';
    } catch (error) {
      this.logger &&
        this.logger.warn('Terminal accessible buffer snapshot failed.', {
          error: error && error.message ? error.message : String(error)
        });
      return '';
    } finally {
      if (openedAccessibleBuffer) {
        try {
          await vscode.commands.executeCommand(ACCESSIBLE_VIEW_COMMAND);
          await delay(40);
        } catch (closeError) {
          this.logger &&
            this.logger.warn('Failed to close terminal accessible buffer after snapshot.', {
              error: closeError && closeError.message ? closeError.message : String(closeError)
            });
        }
      }

      try {
        await focusTerminal(terminal);
      } catch (focusError) {
        this.logger &&
          this.logger.warn('Failed to refocus terminal after accessible buffer snapshot.', {
            error: focusError && focusError.message ? focusError.message : String(focusError)
          });
      }
    }
  }
}

function replaceSnapshotBuffers(state, text) {
  const changed = state.sink.textBuffer !== text;
  state.sink.textBuffer = text;
  return {
    changed
  };
}

function normalizeSnapshotText(value) {
  return String(value || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function normalizeSelectionText(value) {
  return normalizeSnapshotText(value);
}

function readTerminalSelectionText(terminal) {
  return terminal && typeof terminal.selection === 'string' ? terminal.selection : '';
}

function selectionLooksExpanded(previousSelection, nextSelection) {
  const normalizedPrevious = normalizeSelectionText(previousSelection);
  const normalizedNext = normalizeSelectionText(nextSelection);

  if (!normalizedNext) {
    return false;
  }

  if (!normalizedPrevious) {
    return true;
  }

  return normalizedNext !== normalizedPrevious || normalizedNext.length > normalizedPrevious.length;
}

async function focusTerminal(terminal) {
  if (terminal && typeof terminal.show === 'function') {
    terminal.show(false);
  }

  await delay(50);
  await vscode.commands.executeCommand(TERMINAL_FOCUS_COMMAND);
  await delay(50);
}

async function clearTerminalSelection() {
  await vscode.commands.executeCommand(CLEAR_SELECTION_COMMAND);
}

function delay(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

async function createClipboardSnapshotState() {
  const previousText = await vscode.env.clipboard.readText();
  const previousSequenceNumber = getClipboardSequenceNumber();
  const sentinel =
    previousSequenceNumber === null
      ? `${CLIPBOARD_SENTINEL_PREFIX}${Date.now()}_${Math.random().toString(16).slice(2)}`
      : '';

  return {
    previousSequenceNumber,
    previousText,
    sentinel
  };
}

async function armClipboardSnapshotState(clipboardState) {
  if (!clipboardState || !clipboardState.sentinel) {
    return;
  }

  await vscode.env.clipboard.writeText(clipboardState.sentinel);
}

async function restoreClipboardSnapshotState(clipboardState) {
  if (!clipboardState || !clipboardState.sentinel) {
    return;
  }

  await vscode.env.clipboard.writeText(clipboardState.previousText);
}

function didClipboardSnapshotCaptureText(copiedText, clipboardState) {
  const normalizedCopiedText = String(copiedText || '');
  if (!normalizedCopiedText) {
    return false;
  }

  if (
    clipboardState &&
    clipboardState.sentinel &&
    normalizedCopiedText === clipboardState.sentinel
  ) {
    return false;
  }

  if (clipboardState && clipboardState.previousSequenceNumber !== null) {
    const currentSequenceNumber = getClipboardSequenceNumber();
    if (
      currentSequenceNumber !== null &&
      currentSequenceNumber !== clipboardState.previousSequenceNumber
    ) {
      return true;
    }
  }

  return !clipboardState || normalizedCopiedText !== String(clipboardState.previousText || '');
}

module.exports = {
  TerminalCommandSnapshotter
};
