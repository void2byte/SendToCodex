'use strict';

const path = require('path');
const vscode = require('vscode');

function resolveLogDirectory(context, configuredPath) {
  if (configuredPath && path.isAbsolute(configuredPath)) {
    return configuredPath;
  }

  const workspaceFolder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
  if (configuredPath && workspaceFolder && workspaceFolder.uri.scheme === 'file') {
    return path.join(workspaceFolder.uri.fsPath, configuredPath);
  }

  return path.join(context.globalStorageUri.fsPath, configuredPath || 'terminal-logs');
}

function buildTerminalLogPaths(logDirectory, number, terminalName) {
  const paddedNumber = String(number).padStart(3, '0');
  const safeName = sanitizeFileName(terminalName || 'terminal');
  const baseName = `terminal-${paddedNumber}-${safeName}`;
  const legacyRawLogPath = path.join(logDirectory, `${baseName}.log`);
  const textLogPath = path.join(logDirectory, `${baseName}.txt`);
  const lineIndexPath = path.join(logDirectory, `${baseName}.lines.json`);
  const selectionFilePrefix = path.join(logDirectory, `${baseName}.selection-`);
  const snapshotFilePrefix = path.join(logDirectory, `${baseName}.snapshot-`);

  return {
    baseName,
    legacyRawLogPath,
    textLogPath,
    lineIndexPath,
    selectionFilePrefix,
    snapshotFilePrefix,
    allFilePaths: [
      textLogPath,
      lineIndexPath
    ]
  };
}

function buildSelectionAttachmentPath(paths, sequenceNumber, extension = 'md') {
  const safeExtension = String(extension || 'md').replace(/^\./, '') || 'md';
  const paddedNumber = String(Math.max(1, Number(sequenceNumber) || 1)).padStart(3, '0');
  return `${paths.selectionFilePrefix}${paddedNumber}.${safeExtension}`;
}

function buildSelectionSnapshotPath(paths, sequenceNumber, extension = 'txt') {
  const safeExtension = String(extension || 'txt').replace(/^\./, '') || 'txt';
  const paddedNumber = String(Math.max(1, Number(sequenceNumber) || 1)).padStart(3, '0');
  return `${paths.snapshotFilePrefix}${paddedNumber}.${safeExtension}`;
}

function sanitizeFileName(value) {
  return (
    value
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .toLowerCase() || 'terminal'
  );
}

module.exports = {
  buildSelectionAttachmentPath,
  buildSelectionSnapshotPath,
  resolveLogDirectory,
  buildTerminalLogPaths
};
