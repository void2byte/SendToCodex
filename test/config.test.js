'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createMockVscode, installMockVscode } = require('./helpers/mockVscode');

test('terminal recording and diagnostic files are disabled by default', () => {
  const mock = createMockVscode({
    overrides: {
      workspace: {
        getConfiguration: () => ({
          get: (_key, fallback) => fallback
        })
      }
    }
  });
  const restore = installMockVscode(mock.vscode);
  delete require.cache[require.resolve('../src/config')];
  const { loadConfiguration } = require('../src/config');
  restore();

  const configuration = loadConfiguration();
  assert.equal(configuration.enabled, false);
  assert.equal(configuration.diagnosticsLoggingEnabled, false);
  assert.equal(configuration.diagnosticsLogFileEnabled, false);
});
