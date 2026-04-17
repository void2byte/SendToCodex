'use strict';

const fs = require('node:fs');

const SWIFT_EXECUTABLE_PATH = '/usr/bin/swift';

function getSwiftExecutablePath() {
  if (process.platform !== 'darwin') {
    return null;
  }

  return fs.existsSync(SWIFT_EXECUTABLE_PATH) ? SWIFT_EXECUTABLE_PATH : null;
}

module.exports = {
  getSwiftExecutablePath,
  SWIFT_EXECUTABLE_PATH
};
