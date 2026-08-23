'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createMockVscode, installMockVscode } = require('../helpers/mockVscode');

test('notification policy keeps actionable prompts, suppresses passive toasts, and makes errors transient', async () => {
  const calls = [];
  const progressCalls = [];
  const mock = createMockVscode({
    overrides: {
      ProgressLocation: { Notification: 15 },
      window: {
        showInformationMessage: async (...args) => {
          calls.push(['info', args]);
          return 'unexpected';
        },
        showWarningMessage: async (...args) => {
          calls.push(['warning', args]);
          return 'confirmed';
        },
        showErrorMessage: async (...args) => {
          calls.push(['error', args]);
          return 'unexpected';
        },
        withProgress: async (options) => {
          progressCalls.push(options);
          return undefined;
        }
      }
    }
  });
  const restore = installMockVscode(mock.vscode);
  delete require.cache[require.resolve('../../src/ui/notificationPolicy')];
  const { installNotificationPolicy } = require('../../src/ui/notificationPolicy');
  const logger = { debug() {}, error() {}, warn() {} };

  try {
    installNotificationPolicy(logger);
    assert.equal(await mock.vscode.window.showInformationMessage('saved'), undefined);
    assert.equal(await mock.vscode.window.showInformationMessage('saved', 'Open'), 'unexpected');
    assert.equal(
      await mock.vscode.window.showInformationMessage('saved', { title: 'Open' }),
      'unexpected'
    );
    assert.equal(await mock.vscode.window.showWarningMessage('background warning'), undefined);
    assert.equal(
      await mock.vscode.window.showWarningMessage('Confirm action', { modal: true }, 'Yes'),
      'confirmed'
    );
    await mock.vscode.window.showErrorMessage('important failure');
  } finally {
    restore();
  }

  assert.equal(calls.length, 3);
  assert.equal(calls[0][0], 'info');
  assert.deepEqual(calls[0][1], ['saved', 'Open']);
  assert.equal(calls[1][0], 'info');
  assert.deepEqual(calls[1][1], ['saved', { title: 'Open' }]);
  assert.equal(calls[2][0], 'warning');
  assert.equal(progressCalls.length, 1);
  assert.equal(progressCalls[0].location, 15);
  assert.match(progressCalls[0].title, /important failure/);
});
