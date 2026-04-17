'use strict';

const { execFileSync } = require('node:child_process');
const { getClipboardSequenceNumber: getWindowsClipboardSequenceNumber } = require('./windows/clipboardSequence');
const { getSwiftExecutablePath } = require('./darwin/swiftRuntime');

function getDarwinClipboardSequenceNumber() {
  const swiftExecutablePath = getSwiftExecutablePath();
  if (!swiftExecutablePath) {
    return null;
  }

  try {
    const stdout = execFileSync(
      swiftExecutablePath,
      ['-e', 'import AppKit; print(NSPasteboard.general.changeCount)'],
      {
        encoding: 'utf8',
        timeout: 2000
      }
    );

    const value = Number(stdout.trim());
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

function getClipboardSequenceNumber() {
  if (process.platform === 'win32') {
    return getWindowsClipboardSequenceNumber();
  }

  if (process.platform === 'darwin') {
    return getDarwinClipboardSequenceNumber();
  }

  return null;
}

module.exports = {
  getClipboardSequenceNumber
};
