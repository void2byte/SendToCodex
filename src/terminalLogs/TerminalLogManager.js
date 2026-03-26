'use strict';

const vscode = require('vscode');
const { loadConfiguration, TERMINAL_CAPTURE_API_HINT } = require('../config');
const {
  ensureDirectory,
  readTextFileIfExists,
  writeTextFile
} = require('../files/fileSystem');
const { TerminalLogCleaner } = require('./TerminalLogCleaner');
const {
  buildSelectionSnapshotPath,
  buildTerminalLogPaths,
  resolveLogDirectory
} = require('./logPaths');
const { TerminalCommandSnapshotter } = require('./TerminalCommandSnapshotter');
const { TerminalLogSink } = require('./TerminalLogSink');
const {
  createCaptureHealth,
  describeCaptureHealth,
  hasCapturedData,
  markCapturedChunk,
  markShellExecutionStart,
  markShellIntegrationActive
} = require('./captureHealth');
const { formatMegabytes } = require('./textBuffer');

class TerminalLogManager {
  constructor(context, output, logger) {
    this.context = context;
    this.output = output;
    this.logger = logger;
    this.terminalStates = new Map();
    this.runtimeDisposables = [];
    this.nextTerminalNumber = 1;
    this.configuration = loadConfiguration();
    this.logDirectory = '';
    this.cleaner = new TerminalLogCleaner(output);
    this.commandSnapshotter = new TerminalCommandSnapshotter(output, logger);
    this.onDidChangeCapturedTerminalCountEmitter = new vscode.EventEmitter();
    this.onDidChangeCapturedTerminalCount = this.onDidChangeCapturedTerminalCountEmitter.event;
  }

  async activate() {
    const terminalWriteApiAvailable = this.isTerminalWriteApiAvailable();
    const shellExecutionApiAvailable = this.isShellExecutionApiAvailable();

    this.logger &&
      this.logger.info('Activating terminal log manager.', {
        vscodeVersion: vscode.version,
        terminalCount: vscode.window.terminals.length,
        terminalWriteApiAvailable,
        shellExecutionApiAvailable
      });
    await this.reloadConfiguration(false);

    this.runtimeDisposables.push(
      vscode.window.onDidOpenTerminal((terminal) => {
        if (this.configuration.enabled) {
          void this.ensureState(terminal);
        }
      }),
      vscode.window.onDidCloseTerminal((terminal) => {
        void this.closeTerminal(terminal);
      })
    );

    if (typeof vscode.window.onDidChangeTerminalShellIntegration === 'function') {
      this.runtimeDisposables.push(
        vscode.window.onDidChangeTerminalShellIntegration((event) => {
          this.handleTerminalShellIntegrationChange(event);
        })
      );
    }

    if (!terminalWriteApiAvailable) {
      this.logger &&
        this.logger.warn('Terminal write API is unavailable.', {
          terminalWriteApiAvailable: false
        });
      this.output.appendLine(TERMINAL_CAPTURE_API_HINT);
      void vscode.window.showWarningMessage(TERMINAL_CAPTURE_API_HINT);
    } else {
      this.runtimeDisposables.push(
        vscode.window.onDidWriteTerminalData((event) => {
          if (!this.configuration.enabled) {
            return;
          }

          this.handleTerminalDataWrite(event.terminal, event.data);
        })
      );
    }

    if (shellExecutionApiAvailable) {
      this.runtimeDisposables.push(
        vscode.window.onDidStartTerminalShellExecution((event) => {
          if (!this.configuration.enabled) {
            return;
          }

          void this.handleShellExecutionStart(event);
        })
      );
    }
  }

  async reloadConfiguration(notify) {
    const previousLogDirectory = this.logDirectory;
    const isFirstLoad = !previousLogDirectory;

    this.configuration = loadConfiguration();
    this.logDirectory = resolveLogDirectory(this.context, this.configuration.logDirectory);
    this.logger &&
      this.logger.info('Reloading terminal recorder configuration.', {
        enabled: this.configuration.enabled,
        logDirectory: this.logDirectory,
        maxBytes: this.configuration.maxBytes
      });
    await ensureDirectory(this.logDirectory);

    if (isFirstLoad) {
      await this.cleaner.cleanupDeadLogFiles(this.logDirectory, new Set());
    }

    if (this.configuration.enabled) {
      for (const terminal of vscode.window.terminals) {
        await this.ensureState(terminal);
      }
    }

    const activeFilePaths = new Set();

    for (const [terminal, state] of this.terminalStates) {
      state.selectionAttachmentPaths = state.selectionAttachmentPaths || new Set();
      state.selectionSnapshotPaths = state.selectionSnapshotPaths || new Set();
      state.nextSelectionAttachmentNumber = Math.max(
        1,
        Number(state.nextSelectionAttachmentNumber) || 1
      );
      state.nextSelectionSnapshotNumber = Math.max(
        1,
        Number(state.nextSelectionSnapshotNumber) || 1
      );
      const nextPaths = buildTerminalLogPaths(this.logDirectory, state.number, terminal.name);
      const selectionPrefixChanged =
        !state.paths ||
        state.paths.selectionFilePrefix !== nextPaths.selectionFilePrefix ||
        state.paths.snapshotFilePrefix !== nextPaths.snapshotFilePrefix;
      await state.sink.rebind(nextPaths, this.configuration.maxBytes);
      state.paths = nextPaths;
      if (selectionPrefixChanged) {
        state.selectionAttachmentPaths.clear();
        state.selectionSnapshotPaths.clear();
        state.lastSelectionSnapshotPath = '';
      }

      for (const filePath of nextPaths.allFilePaths) {
        activeFilePaths.add(filePath);
      }

      for (const filePath of state.selectionAttachmentPaths) {
        activeFilePaths.add(filePath);
      }

      for (const filePath of state.selectionSnapshotPaths) {
        activeFilePaths.add(filePath);
      }
    }

    await this.cleaner.cleanupDeadLogFiles(this.logDirectory, activeFilePaths);

    if (previousLogDirectory && previousLogDirectory !== this.logDirectory) {
      await this.cleaner.cleanupDeadLogFiles(previousLogDirectory, new Set());
    }

    if (notify) {
      const status = this.configuration.enabled ? 'enabled' : 'disabled';
      vscode.window.setStatusBarMessage(
        `Send to Codex ${status}, ${formatMegabytes(this.configuration.maxBytes)} MB per terminal`,
        3000
      );
    }
  }

  async openLogDirectory() {
    await ensureDirectory(this.logDirectory);
    const uri = vscode.Uri.file(this.logDirectory);
    await vscode.commands.executeCommand('revealFileInOS', uri);
  }

  async openActiveTerminalLog() {
    const terminal = vscode.window.activeTerminal;
    if (!terminal) {
      void vscode.window.showInformationMessage('No active terminal found.');
      return;
    }

    await this.captureLastCommandSnapshot(terminal);
    const state = await this.ensureState(terminal);
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(state.paths.textLogPath));
    await vscode.window.showTextDocument(document, { preview: false });

    if (!hasCapturedData(state.captureHealth)) {
      const message = formatStateCaptureSummary(state);
      this.output.appendLine(message);
      void vscode.window.showInformationMessage(message);
    }
  }

  async ensureState(terminal) {
    const existing = this.terminalStates.get(terminal);
    if (existing) {
      return existing;
    }

    const state = this.createStateSync(terminal);
    await state.sink.initialize();
    return state;
  }

  ensureStateSync(terminal) {
    const existing = this.terminalStates.get(terminal);
    if (existing) {
      return existing;
    }

    const state = this.createStateSync(terminal);
    void state.sink.initialize();
    return state;
  }

  async closeTerminal(terminal) {
    const state = this.terminalStates.get(terminal);
    if (!state) {
      return;
    }

    this.terminalStates.delete(terminal);
    this.emitCapturedTerminalCountChanged();
    await state.sink.dispose();
    const selectionAttachmentPaths = state.selectionAttachmentPaths || new Set();
    const selectionSnapshotPaths = state.selectionSnapshotPaths || new Set();
    await this.cleaner.deleteTerminalFiles([
      ...state.paths.allFilePaths,
      ...selectionAttachmentPaths,
      ...selectionSnapshotPaths
    ]);
  }

  getCapturedTerminalCount() {
    return this.terminalStates.size;
  }

  isTerminalWriteApiAvailable() {
    return typeof vscode.window.onDidWriteTerminalData === 'function';
  }

  isShellExecutionApiAvailable() {
    return typeof vscode.window.onDidStartTerminalShellExecution === 'function';
  }

  dispose() {
    for (const disposable of this.runtimeDisposables.splice(0)) {
      disposable.dispose();
    }

    for (const [, state] of this.terminalStates) {
      void state.sink.dispose();
    }

    this.terminalStates.clear();
    this.emitCapturedTerminalCountChanged();
    this.onDidChangeCapturedTerminalCountEmitter.dispose();
  }

  createStateSync(terminal) {
    const number = this.nextTerminalNumber++;
    const paths = buildTerminalLogPaths(this.logDirectory, number, terminal.name);
    const sink = new TerminalLogSink(paths, this.configuration.maxBytes, this.output);
    const state = {
      number,
      paths,
      sink,
      captureMode: 'unknown',
      nextSelectionAttachmentNumber: 1,
      nextSelectionSnapshotNumber: 1,
      selectionAttachmentPaths: new Set(),
      selectionSnapshotPaths: new Set(),
      lastSelectionSnapshotPath: '',
      captureHealth: createCaptureHealth({
        terminalWriteApiAvailable: this.isTerminalWriteApiAvailable(),
        shellExecutionApiAvailable: this.isShellExecutionApiAvailable(),
        shellIntegrationActive: Boolean(terminal.shellIntegration)
      })
    };

    this.terminalStates.set(terminal, state);
    this.emitCapturedTerminalCountChanged();

    this.logger &&
      this.logger.info('Tracking terminal for capture.', {
        terminalName: terminal.name,
        baseName: state.paths.baseName,
        shellIntegrationActive: Boolean(terminal.shellIntegration)
      });
    return state;
  }

  emitCapturedTerminalCountChanged() {
    this.onDidChangeCapturedTerminalCountEmitter.fire(this.terminalStates.size);
  }

  handleTerminalDataWrite(terminal, data) {
    const state = this.ensureStateSync(terminal);
    const hadCapturedData = hasCapturedData(state.captureHealth);
    if (state.captureMode === 'shellExecution') {
      return;
    }

    if (state.captureMode !== 'terminalDataWrite') {
      state.captureMode = 'terminalDataWrite';
      this.logger &&
        this.logger.info('Terminal capture mode selected.', {
          terminalName: terminal.name,
          mode: state.captureMode
        });
    }

    markCapturedChunk(state.captureHealth, 'terminalDataWrite', data);
    if (!hadCapturedData && hasCapturedData(state.captureHealth)) {
      this.emitCapturedTerminalCountChanged();
    }
    state.sink.append(data);
  }

  handleTerminalShellIntegrationChange(event) {
    const state = this.ensureStateSync(event.terminal);
    markShellIntegrationActive(state.captureHealth);
    this.logger &&
      this.logger.info('Terminal shell integration activated.', {
        terminalName: event.terminal.name,
        baseName: state.paths.baseName
      });
  }

  async handleShellExecutionStart(event) {
    const executionStream = event.execution.read();
    const state = this.ensureStateSync(event.terminal);
    markShellExecutionStart(state.captureHealth);
    if (state.captureMode === 'terminalDataWrite') {
      return;
    }

    this.logger &&
      this.logger.info('Started shell execution capture.', {
        terminalName: event.terminal.name,
        baseName: state.paths.baseName,
        shellIntegrationActive: Boolean(event.shellIntegration)
      });

    try {
      for await (const chunk of executionStream) {
        const hadCapturedData = hasCapturedData(state.captureHealth);
        if (state.captureMode === 'terminalDataWrite') {
          return;
        }

        if (state.captureMode !== 'shellExecution') {
          state.captureMode = 'shellExecution';
          this.logger &&
            this.logger.info('Terminal capture mode selected.', {
              terminalName: event.terminal.name,
              mode: state.captureMode
            });
        }

        markCapturedChunk(state.captureHealth, 'shellExecution', chunk);
        if (!hadCapturedData && hasCapturedData(state.captureHealth)) {
          this.emitCapturedTerminalCountChanged();
        }
        state.sink.append(chunk);
      }
    } catch (error) {
      this.logger &&
        this.logger.error('Shell execution capture failed.', {
          terminalName: event.terminal.name,
          error: error && error.message ? error.message : String(error)
        });
    }
  }

  getCapturedOutputTerminalCount() {
    let count = 0;

    for (const [, state] of this.terminalStates) {
      if (hasCapturedData(state.captureHealth)) {
        count += 1;
      }
    }

    return count;
  }

  async captureLastCommandSnapshot(terminal) {
    const state = await this.ensureState(terminal);
    const hadCapturedData = hasCapturedData(state.captureHealth);
    const result = await this.commandSnapshotter.captureLastCommandSnapshot(terminal, state);

    this.recordSnapshotCaptureResult(terminal, state, result, hadCapturedData);

    return result;
  }

  async captureSelectionSnapshot(terminal, options = {}) {
    const state = await this.ensureState(terminal);
    const useCurrentBufferOnly = Boolean(options.useCurrentBufferOnly);
    let snapshotResult = null;

    if (!useCurrentBufferOnly) {
      const hadCapturedData = hasCapturedData(state.captureHealth);
      snapshotResult = await this.commandSnapshotter.captureLastCommandSnapshot(terminal, state);
      this.recordSnapshotCaptureResult(terminal, state, snapshotResult, hadCapturedData);
    }

    const snapshotText = normalizeSnapshotText(
      (snapshotResult && snapshotResult.text) ||
        state.sink.textBuffer ||
        (await readTextFileIfExists(state.paths.textLogPath))
    );
    const previousSnapshotPath = state.lastSelectionSnapshotPath || '';

    if (previousSnapshotPath) {
      const previousSnapshotText = await readTextFileIfExists(previousSnapshotPath);
      if (previousSnapshotText === snapshotText) {
        return {
          captured: Boolean(snapshotResult && snapshotResult.captured),
          filePath: previousSnapshotPath,
          reusedExistingSnapshot: true,
          text: snapshotText
        };
      }
    }

    const snapshotPath = buildSelectionSnapshotPath(
      state.paths,
      state.nextSelectionSnapshotNumber,
      'txt'
    );
    state.nextSelectionSnapshotNumber += 1;
    state.selectionSnapshotPaths.add(snapshotPath);
    state.lastSelectionSnapshotPath = snapshotPath;
    await writeTextFile(snapshotPath, snapshotText);

    return {
      captured: Boolean(snapshotResult && snapshotResult.captured),
      filePath: snapshotPath,
      reusedExistingSnapshot: false,
      text: snapshotText
    };
  }

  recordSnapshotCaptureResult(terminal, state, result, hadCapturedData) {
    if (!result || !result.captured || !result.text) {
      return;
    }

    markCapturedChunk(state.captureHealth, 'commandSnapshot', result.text);
    if (!hadCapturedData && hasCapturedData(state.captureHealth)) {
      this.emitCapturedTerminalCountChanged();
    }
    this.logger &&
      this.logger.info('Captured terminal output via terminal snapshot.', {
        terminalName: terminal.name,
        baseName: state.paths.baseName,
        appendedLength: result.text.length,
        mode: result.mode
      });
  }
}

function formatStateCaptureSummary(state) {
  return `${describeCaptureHealth(state.captureHealth)} Log file: ${state.paths.textLogPath}`;
}

function normalizeSnapshotText(value) {
  return String(value || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

module.exports = {
  TerminalLogManager
};
