'use strict';

const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { createMockVscode, installMockVscode } = require('../helpers/mockVscode');

test('profile export defaults to the user home instead of the open workspace', () => {
  const mock = createMockVscode({
    overrides: {
      workspace: {
        workspaceFolders: [
          { uri: { scheme: 'file', fsPath: path.join('unrelated-project') } }
        ],
        getConfiguration: () => ({
          get: (_key, fallback) => fallback
        })
      }
    }
  });
  const restore = installMockVscode(mock.vscode);
  delete require.cache[require.resolve('../../src/profiles/commands')];

  try {
    const { getDefaultSettingsExportUri } = require('../../src/profiles/commands');
    const homeDirectory = path.resolve('user-home');
    const exportUri = getDefaultSettingsExportUri(homeDirectory);

    assert.equal(
      exportUri.fsPath,
      path.join(homeDirectory, 'codex-switch-profiles.json')
    );
  } finally {
    restore();
  }
});
