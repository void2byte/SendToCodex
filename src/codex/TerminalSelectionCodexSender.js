'use strict';
const vscode = require('vscode');
const { TERMINAL_CONTEXT_SEND_MODES } = require('../config');
const { writeTextFile } = require('../files/fileSystem');
const { formatCaptureHealthForEmptyLog } = require('../terminalLogs/captureHealth');
const { getRecentTerminalSelectionText } = require('../terminalSelection/selectionSources');
const { buildSelectionAttachmentPath } = require('../terminalLogs/logPaths');

class TerminalSelectionCodexSender {
  constructor(selectionResolver, codexCommandClient, output, logger, popupSuppression) {
    this.selectionResolver = selectionResolver;
    this.codexCommandClient = codexCommandClient;
    this.output = output;
    this.logger = logger;
    this.popupSuppression = popupSuppression;
  }

  async sendActiveTerminalSelectionToCodexChat() {
    try {
      this.logger && this.logger.info('Attempting to send active terminal selection to Codex.');
      const resolution = await this.selectionResolver.resolveActiveTerminalSelection();
      const { configuration, strategy } = resolution;
      let result = resolution.result;

      if (!result.found) {
        const retriedResult = await this.tryResolveViaLastCommandSnapshot(resolution);
        if (retriedResult) {
          result = retriedResult;
        }
      }

      if (!result.found) {
        if (result.message === 'The plain-text terminal log is empty.') {
          const captureMessage = formatCaptureHealthForEmptyLog(
            resolution && resolution.terminalState && resolution.terminalState.captureHealth
          );
          this.output.appendLine(captureMessage);
          this.logger &&
            this.logger.warn('Terminal text log is empty while resolving selection.', {
              strategy: strategy.strategyDefinition.id,
              message: captureMessage
            });
        }

        if (configuration.terminalContextSendMode === TERMINAL_CONTEXT_SEND_MODES.editorSelection) {
          const fallbackSession = await this.openSelectionFallbackInEditor(
            resolution,
            result,
            result.message
          );
          if (fallbackSession) {
            const usedCommand = await this.codexCommandClient.attachEditorSelection();
            await this.restoreTerminalFocusIfNeeded(resolution.terminal, fallbackSession.focusTransferred);

            this.logger &&
              this.logger.warn('Terminal selection used fallback editor selection.', {
                strategy: strategy.strategyDefinition.id,
                command: usedCommand,
                filePath: fallbackSession.editor.document.uri.fsPath,
                message: result.message
              });
            this.output.appendLine(
              `[${strategy.strategyDefinition.id}] Sent terminal selection fallback to Codex using ${usedCommand}.`
            );
            void vscode.window.showInformationMessage(
              'Sent selected terminal text to Codex Chat using fallback mode.'
            );
            return;
          }
        } else if (
          configuration.terminalContextSendMode === TERMINAL_CONTEXT_SEND_MODES.contextBundle
        ) {
          const usedCommand = await this.sendFallbackViaContextBundle(
            resolution,
            result,
            result.message
          );
          if (usedCommand) {
            this.logger &&
              this.logger.warn('Terminal selection used context bundle fallback.', {
                strategy: strategy.strategyDefinition.id,
                command: usedCommand.command,
                filePaths: usedCommand.filePaths,
                message: result.message
              });
            this.output.appendLine(
              `[${strategy.strategyDefinition.id}] Sent terminal selection fallback to Codex using ${usedCommand.command}.`
            );
            void vscode.window.showInformationMessage(
              'Sent selected terminal text to Codex Chat using fallback mode.'
            );
            return;
          }
        } else {
          const fallbackUri = await this.createSelectionFallbackAttachment(
            resolution,
            result,
            result.message
          );
          if (fallbackUri) {
            const usedCommand = await this.codexCommandClient.attachFileOrFolder(fallbackUri);

            this.logger &&
              this.logger.warn('Terminal selection used fallback attachment.', {
                strategy: strategy.strategyDefinition.id,
                command: usedCommand,
                filePath: fallbackUri.fsPath,
                message: result.message
              });
            this.output.appendLine(
              `[${strategy.strategyDefinition.id}] Sent terminal selection fallback to Codex using ${usedCommand}.`
            );
            void vscode.window.showInformationMessage(
              'Sent selected terminal text to Codex Chat using fallback mode.'
            );
            return;
          }
        }

        this.logger &&
          this.logger.warn('Terminal selection could not be resolved.', {
            strategy: strategy.strategyDefinition.id,
            message: result.message
          });
        this.output.appendLine(`[${strategy.strategyDefinition.id}] ${result.message}`);
        void vscode.window.showWarningMessage(result.message);
        return;
      }

      const usedCommand =
        configuration.terminalContextSendMode === TERMINAL_CONTEXT_SEND_MODES.editorSelection
          ? await this.sendResolvedSelectionViaEditorSelection(
              resolution,
              result,
              configuration.selectionContextLines
            )
          : configuration.terminalContextSendMode === TERMINAL_CONTEXT_SEND_MODES.contextBundle
            ? await this.sendResolvedSelectionViaContextBundle(
                resolution,
                result,
                configuration.selectionContextLines
              )
          : await this.sendResolvedSelectionViaAttachment(
              resolution,
              result,
              configuration.selectionContextLines
            );

      this.logger &&
        this.logger.info('Terminal selection sent to Codex.', {
          strategy: strategy.strategyDefinition.id,
          command: usedCommand.command,
          filePath: usedCommand.filePath
        });
      this.output.appendLine(
        `[${strategy.strategyDefinition.id}] Sent terminal context to Codex using ${usedCommand.command}.`
      );
      void vscode.window.showInformationMessage('Sent terminal context to Codex Chat.');
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      this.logger &&
        this.logger.error('Failed to send active terminal selection to Codex.', {
          error: message
        });
      this.output.appendLine(message);
      void vscode.window.showWarningMessage(message);
    }
  }

  async tryResolveViaLastCommandSnapshot(resolution) {
    const terminalLogManager =
      this.selectionResolver && this.selectionResolver.terminalLogManager;
    if (!terminalLogManager || !resolution || !resolution.terminal) {
      return null;
    }

    const snapshotResult = await terminalLogManager.captureLastCommandSnapshot(resolution.terminal);
    resolution.canReuseCurrentBufferForSelectionSnapshot = Boolean(
      snapshotResult && snapshotResult.reason !== 'snapshot-error'
    );
    if (!snapshotResult || !snapshotResult.captured) {
      return null;
    }

    this.logger &&
      this.logger.info('Retrying terminal selection resolution after terminal snapshot capture.', {
        terminalName: resolution.terminal.name
      });

    return resolution.strategy.resolve({
      configuration: resolution.configuration,
      terminal: resolution.terminal,
      terminalState: resolution.terminalState
    });
  }

  async createSelectionFallbackAttachment(resolution, result, reason) {
    const selectionText = getSelectionText(resolution, result);
    const selectionSnapshot = await this.ensureSelectionSnapshot(resolution);

    if (!selectionText.trim()) {
      return null;
    }

    const fallbackPath = this.allocateSelectionAttachmentPath(resolution);
    await writeTextFile(
      fallbackPath,
      buildFallbackAttachmentText({
        snapshotPath: selectionSnapshot.filePath,
        terminalName: resolution.terminal.name,
        strategyLabel: resolution.strategy.strategyDefinition.label,
        reason,
        selectionText: normalizeSelectionText(selectionText)
      })
    );
    return vscode.Uri.file(fallbackPath);
  }

  async openSelectionFallbackInEditor(resolution, result, reason) {
    const fallbackUri = await this.createSelectionFallbackAttachment(resolution, result, reason);
    if (!fallbackUri) {
      return null;
    }

    return this.showSelectionDocument(
      fallbackUri,
      (editor) => {
        const lastLine = Math.max(0, editor.document.lineCount - 1);
        const start = editor.document.lineAt(0).range.start;
        const end = editor.document.lineAt(lastLine).range.end;
        const range = new vscode.Range(start, end);

        editor.selection = new vscode.Selection(start, end);
        editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
      },
      'terminal-selection-fallback-open'
    );
  }

  async createResolvedSelectionAttachment(resolution, result, contextLines) {
    const selectionSnapshot = await this.ensureSelectionSnapshot(resolution);
    const attachmentPath = this.allocateSelectionAttachmentPath(resolution);
    await writeTextFile(
      attachmentPath,
      buildResolvedAttachmentText({
        contextLines,
        query: result.query,
        range: result.range,
        selectionText: normalizeSelectionText(getSelectionText(resolution, result)),
        snapshotPath: selectionSnapshot.filePath,
        sourceText: selectionSnapshot.text,
        strategyLabel: resolution.strategy.strategyDefinition.label,
        summary: result.summary,
        terminalName: resolution.terminal.name
      })
    );
    return vscode.Uri.file(attachmentPath);
  }

  async sendResolvedSelectionViaAttachment(resolution, result, contextLines) {
    const attachmentUri = await this.createResolvedSelectionAttachment(
      resolution,
      result,
      contextLines
    );
    const command = await this.codexCommandClient.attachFileOrFolder(attachmentUri);
    return {
      command,
      filePath: attachmentUri.fsPath
    };
  }

  async sendResolvedSelectionViaContextBundle(resolution, result, contextLines) {
    return this.sendResolvedSelectionViaAttachment(resolution, result, contextLines);
  }

  async sendFallbackViaContextBundle(resolution, result, reason) {
    const fallbackUri = await this.createSelectionFallbackAttachment(resolution, result, reason);
    if (!fallbackUri) {
      return null;
    }

    const command = await this.codexCommandClient.attachFileOrFolder(fallbackUri);
    return {
      command,
      filePath: fallbackUri.fsPath,
      filePaths: [fallbackUri.fsPath]
    };
  }

  async sendResolvedSelectionViaEditorSelection(resolution, result, contextLines) {
    const session = await this.openContextSelection(result, contextLines);
    const command = await this.codexCommandClient.attachEditorSelection();
    await this.restoreTerminalFocusIfNeeded(resolution.terminal, session.focusTransferred);
    return {
      command,
      filePath: session.editor.document.uri.fsPath
    };
  }

  async openContextSelection(result, contextLines) {
    return this.showSelectionDocument(
      vscode.Uri.file(result.filePath),
      (editor) => {
        const startLine = Math.max(0, result.range.start.line - contextLines);
        const endLine = Math.min(documentLineCount(editor) - 1, result.range.end.line + contextLines);
        const start = editor.document.lineAt(startLine).range.start;
        const end = editor.document.lineAt(endLine).range.end;
        const range = new vscode.Range(start, end);

        editor.selection = new vscode.Selection(start, end);
        editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
      },
      'terminal-context-selection-open'
    );
  }

  async showSelectionDocument(documentUri, applySelection, suppressionReason) {
    this.popupSuppression && this.popupSuppression.suppress(1500, suppressionReason);
    const document = await vscode.workspace.openTextDocument(documentUri);
    let editor = await vscode.window.showTextDocument(document, {
      preview: true,
      preserveFocus: true
    });
    applySelection(editor);

    if (vscode.window.activeTextEditor === editor) {
      return {
        editor,
        focusTransferred: false
      };
    }

    editor = await vscode.window.showTextDocument(document, {
      preview: true,
      preserveFocus: false
    });
    applySelection(editor);
    return {
      editor,
      focusTransferred: true
    };
  }

  async restoreTerminalFocusIfNeeded(terminal, focusTransferred) {
    if (!focusTransferred || !terminal || typeof terminal.show !== 'function') {
      return;
    }

    try {
      terminal.show(false);
    } catch {
      // Best-effort only: terminal focus restoration can fail if VS Code closed the terminal.
    }
  }

  allocateSelectionAttachmentPath(resolution) {
    const terminalState = resolution && resolution.terminalState;
    if (!terminalState || !terminalState.paths) {
      throw new Error('The active terminal state is unavailable for creating a selection attachment.');
    }

    const filePath = buildSelectionAttachmentPath(
      terminalState.paths,
      terminalState.nextSelectionAttachmentNumber,
      'md'
    );
    terminalState.nextSelectionAttachmentNumber += 1;
    terminalState.selectionAttachmentPaths = terminalState.selectionAttachmentPaths || new Set();
    terminalState.selectionAttachmentPaths.add(filePath);
    return filePath;
  }

  async ensureSelectionSnapshot(resolution) {
    if (resolution && resolution.selectionSnapshot) {
      return resolution.selectionSnapshot;
    }

    const terminalLogManager =
      this.selectionResolver && this.selectionResolver.terminalLogManager;
    if (!terminalLogManager || !resolution || !resolution.terminal) {
      return {
        filePath: '',
        text: ''
      };
    }

    const selectionSnapshot = await terminalLogManager.captureSelectionSnapshot(
      resolution.terminal,
      {
        useCurrentBufferOnly: Boolean(resolution.canReuseCurrentBufferForSelectionSnapshot)
      }
    );
    resolution.selectionSnapshot = selectionSnapshot;
    return selectionSnapshot;
  }
}

function documentLineCount(editor) {
  return editor && editor.document ? editor.document.lineCount : 0;
}

function normalizeSelectionText(value) {
  return String(value || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function getSelectionText(resolution, result) {
  const resultSelectionText =
    result && typeof result.selectionText === 'string' ? result.selectionText : '';
  if (resultSelectionText.trim()) {
    return resultSelectionText;
  }

  const liveSelection =
    resolution &&
    resolution.terminal &&
    typeof resolution.terminal.selection === 'string'
      ? resolution.terminal.selection
      : '';
  if (liveSelection.trim()) {
    return liveSelection;
  }

  return resolution && resolution.terminal
    ? getRecentTerminalSelectionText(resolution.terminal)
    : '';
}

function buildResolvedAttachmentText(options) {
  const bundleContext = buildResolvedBundleContext(options);
  const lines = [
    '# Terminal Context',
    '',
    `Snapshot: ${options.snapshotPath || 'Unavailable'}`,
    `Range: ${formatRange(options.range)}`,
    `Command: ${bundleContext.relatedCommand ? `line ${bundleContext.relatedCommand.lineNumber}` : 'Unavailable'}`,
    '',
    '## Selected Text',
    renderTextBlock(options.selectionText || options.query),
    ''
  ];

  if (bundleContext.relatedCommand) {
    lines.push('## Related Command');
    lines.push(renderTextBlock(bundleContext.relatedCommand.commandLine));
    lines.push('');
  }

  if (bundleContext.contextPreview) {
    lines.push('## Numbered Context Preview');
    lines.push(renderTextBlock(bundleContext.contextPreview));
  } else {
    lines.push('## Numbered Context Preview');
    lines.push('No extra context lines.');
  }

  return lines.join('\n');
}

function buildFallbackAttachmentText(options) {
  const lines = [
    '# Terminal Context',
    '',
    `Snapshot: ${options.snapshotPath || 'Unavailable'}`,
    `Reason: ${options.reason}`,
    '',
    '## Selected Text',
    renderTextBlock(options.selectionText)
  ];

  return lines.join('\n');
}

function renderTextBlock(value) {
  const normalized = String(value || '').trimEnd();
  return normalized || '(empty)';
}

function formatRange(range) {
  if (!range || !range.start || !range.end) {
    return 'Unavailable';
  }

  return `${formatPosition(range.start)} -> ${formatPosition(range.end)}`;
}

function formatPosition(position) {
  if (!position) {
    return 'Unavailable';
  }

  return `${position.line + 1}:${position.character + 1}`;
}

function buildResolvedBundleContext(options) {
  const sourceLines = splitTerminalLines(options.sourceText);
  const selectionAnalysis = analyzeSelectionCoverage(options.range, sourceLines);
  const relatedCommand = findRelatedCommand(sourceLines, selectionAnalysis);
  const contextPreviewData = buildContextPreview({
    contextLines: options.contextLines,
    relatedCommandLineIndex: relatedCommand ? relatedCommand.lineIndex : -1,
    selectionAnalysis,
    sourceLines
  });

  return {
    contextPreview: contextPreviewData.preview,
    relatedCommand
  };
}

function splitTerminalLines(value) {
  return String(value || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
}

function analyzeSelectionCoverage(range, sourceLines) {
  if (!range || !range.start || !range.end || !sourceLines.length) {
    return {
      effectiveEndLine: 0,
      effectiveEndCharacter: 0,
      hasPartialSelectedLines: false,
      partialSelectedLineIndexes: [],
      selectedLineIndexes: [],
      startLine: 0
    };
  }

  const startLine = clampLineIndex(range.start.line, sourceLines.length);
  const normalizedEnd = normalizeSelectionEnd(range, sourceLines);
  const selectedLineIndexes = [];
  const partialSelectedLineIndexes = [];

  for (let lineIndex = startLine; lineIndex <= normalizedEnd.line; lineIndex += 1) {
    selectedLineIndexes.push(lineIndex);
    const lineText = sourceLines[lineIndex] || '';
    const startCharacter = lineIndex === startLine ? Math.max(0, range.start.character) : 0;
    const endCharacter =
      lineIndex === normalizedEnd.line ? normalizedEnd.character : lineText.length;

    if (startCharacter > 0 || endCharacter < lineText.length) {
      partialSelectedLineIndexes.push(lineIndex);
    }
  }

  return {
    effectiveEndCharacter: normalizedEnd.character,
    effectiveEndLine: normalizedEnd.line,
    hasPartialSelectedLines: partialSelectedLineIndexes.length > 0,
    partialSelectedLineIndexes,
    selectedLineIndexes,
    startLine
  };
}

function normalizeSelectionEnd(range, sourceLines) {
  const endLine = clampLineIndex(range.end.line, sourceLines.length);
  const endLineText = sourceLines[endLine] || '';
  const endCharacter = Math.max(0, Math.min(range.end.character, endLineText.length));

  if (endCharacter > 0 || endLine === 0) {
    return {
      character: endCharacter,
      line: endLine
    };
  }

  if (endLine > range.start.line) {
    const previousLine = endLine - 1;
    return {
      character: (sourceLines[previousLine] || '').length,
      line: previousLine
    };
  }

  return {
    character: endCharacter,
    line: endLine
  };
}

function clampLineIndex(lineIndex, lineCount) {
  if (!Number.isFinite(lineIndex) || !lineCount) {
    return 0;
  }

  return Math.max(0, Math.min(lineCount - 1, lineIndex));
}

function buildContextPreview(options) {
  const {
    contextLines,
    relatedCommandLineIndex,
    selectionAnalysis,
    sourceLines
  } = options;
  const selectedLineIndexes = new Set(selectionAnalysis.selectedLineIndexes);
  const partialSelectedLineIndexes = new Set(selectionAnalysis.partialSelectedLineIndexes);
  const contextLineIndexes = new Set();

  if (selectionAnalysis.hasPartialSelectedLines) {
    for (const lineIndex of partialSelectedLineIndexes) {
      for (let offset = -contextLines; offset <= contextLines; offset += 1) {
        const candidate = lineIndex + offset;
        if (candidate < 0 || candidate >= sourceLines.length) {
          continue;
        }

        contextLineIndexes.add(candidate);
      }
    }

    for (const lineIndex of selectedLineIndexes) {
      if (!partialSelectedLineIndexes.has(lineIndex)) {
        contextLineIndexes.delete(lineIndex);
      }
    }
  } else {
    for (let offset = 1; offset <= contextLines; offset += 1) {
      const before = selectionAnalysis.startLine - offset;
      const after = selectionAnalysis.effectiveEndLine + offset;

      if (before >= 0) {
        contextLineIndexes.add(before);
      }

      if (after < sourceLines.length) {
        contextLineIndexes.add(after);
      }
    }
  }

  if (relatedCommandLineIndex >= 0) {
    contextLineIndexes.delete(relatedCommandLineIndex);
  }

  const sortedLineIndexes = Array.from(contextLineIndexes).sort((left, right) => left - right);
  return {
    lineLabel: formatLineIndexLabel(sortedLineIndexes),
    modeLabel: selectionAnalysis.hasPartialSelectedLines
      ? 'partial selection lines plus nearby context'
      : 'surrounding lines only',
    preview: renderLinePreview(sourceLines, sortedLineIndexes, partialSelectedLineIndexes)
  };
}

function renderLinePreview(sourceLines, sortedLineIndexes, partialSelectedLineIndexes) {
  if (!sortedLineIndexes.length) {
    return '';
  }

  return sortedLineIndexes
    .map((lineIndex) => {
      const marker = partialSelectedLineIndexes.has(lineIndex) ? '>' : ' ';
      return `${marker} ${String(lineIndex + 1).padStart(4, ' ')} | ${sourceLines[lineIndex] || ''}`;
    })
    .join('\n');
}

function formatLineIndexLabel(sortedLineIndexes) {
  if (!sortedLineIndexes.length) {
    return 'none';
  }

  const ranges = [];
  let rangeStart = sortedLineIndexes[0];
  let previous = sortedLineIndexes[0];

  for (let index = 1; index < sortedLineIndexes.length; index += 1) {
    const current = sortedLineIndexes[index];
    if (current === previous + 1) {
      previous = current;
      continue;
    }

    ranges.push(formatLineRange(rangeStart, previous));
    rangeStart = current;
    previous = current;
  }

  ranges.push(formatLineRange(rangeStart, previous));
  return ranges.length === 1 ? ranges[0] : ranges.join(', ');
}

function formatLineRange(startLineIndex, endLineIndex) {
  if (startLineIndex === endLineIndex) {
    return `line ${startLineIndex + 1}`;
  }

  return `lines ${startLineIndex + 1}-${endLineIndex + 1}`;
}

function findRelatedCommand(sourceLines, selectionAnalysis) {
  for (let lineIndex = selectionAnalysis.startLine; lineIndex >= 0; lineIndex -= 1) {
    const commandLine = extractCommandLine(sourceLines[lineIndex]);
    if (!commandLine) {
      continue;
    }

    return {
      commandLine,
      lineIndex,
      lineNumber: lineIndex + 1
    };
  }

  return null;
}

function extractCommandLine(lineText) {
  const line = String(lineText || '').trimEnd();
  if (!line) {
    return '';
  }

  const promptPatterns = [
    /^\$\s+(.+)$/,
    /^#\s+(.+)$/,
    /^%\s+(.+)$/,
    /^>\s+(.+)$/,
    /^PS\s+.+?>\s*(.+)$/,
    /^[A-Za-z]:\\.+?>\s*(.+)$/
  ];

  for (const pattern of promptPatterns) {
    const match = pattern.exec(line);
    if (match && match[1] && match[1].trim()) {
      return match[1].trim();
    }
  }

  return '';
}

module.exports = {
  TerminalSelectionCodexSender
};
