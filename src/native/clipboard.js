'use strict';

const { execSync } = require('child_process');
const { getClipboardSequenceNumber: getWindowsClipboardSequenceNumber } = require('./windows/clipboardSequence');

let getClipboardSequenceNumber = () => null;

if (process.platform === 'win32') {
  getClipboardSequenceNumber = getWindowsClipboardSequenceNumber;
} else if (process.platform === 'darwin') {
  getClipboardSequenceNumber = () => {
    try {
      // Use Swift one-liner for a robust and crash-free implementation
      // Calling another process is acceptable here as it's not in a tight loop.
      const stdout = execSync("swift -e 'import AppKit; print(NSPasteboard.general.changeCount)'", {
        encoding: 'utf8',
        timeout: 2000 // Increase timeout for swift interpreter startup
      });
      return Number(stdout.trim());
    } catch {
      return null;
    }
  };
}

module.exports = {
  getClipboardSequenceNumber
};
