'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createMockVscode, installMockVscode } = require('../helpers/mockVscode');

test('selection status bar controllers mutate visibility only on state transitions', async () => {
  const settings = {
    sendToCodexEnabled: true,
    showCodexSelectionButton: false,
    showCodexEditorSelectionButton: false
  };
  const items = [];
  const createStatusBarItem = () => {
    const calls = { show: 0, hide: 0 };
    const item = {
      calls,
      show() {
        calls.show += 1;
      },
      hide() {
        calls.hide += 1;
      },
      dispose() {}
    };
    items.push(item);
    return item;
  };
  const activeTerminal = { selection: '' };
  const activeTextEditor = {
    document: { uri: { scheme: 'file' } },
    selection: { isEmpty: true }
  };
  const mock = createMockVscode({
    overrides: {
      StatusBarAlignment: { Right: 2 },
      workspace: {
        getConfiguration: () => ({
          get(key, fallback) {
            return Object.prototype.hasOwnProperty.call(settings, key)
              ? settings[key]
              : fallback;
          }
        })
      },
      window: {
        activeTerminal,
        activeTextEditor,
        createStatusBarItem
      }
    }
  });
  const restore = installMockVscode(mock.vscode);

  try {
    for (const modulePath of [
      '../../src/config',
      '../../src/terminalSelection/selectionSources',
      '../../src/ui/TerminalSelectionStatusBarController',
      '../../src/ui/EditorSelectionStatusBarController'
    ]) {
      delete require.cache[require.resolve(modulePath)];
    }
    const {
      TerminalSelectionStatusBarController
    } = require('../../src/ui/TerminalSelectionStatusBarController');
    const {
      EditorSelectionStatusBarController
    } = require('../../src/ui/EditorSelectionStatusBarController');
    const availability = {
      isAvailable: () => true,
      isTerminalSelectionSendAvailable: () => true
    };
    const terminalController = new TerminalSelectionStatusBarController(availability);
    const editorController = new EditorSelectionStatusBarController(availability);
    const terminalItem = items[0];
    const editorItem = items[1];

    await terminalController.refresh();
    await terminalController.refresh();
    await editorController.refresh();
    await editorController.refresh();
    assert.deepEqual(terminalItem.calls, { show: 0, hide: 0 });
    assert.deepEqual(editorItem.calls, { show: 0, hide: 0 });

    settings.showCodexSelectionButton = true;
    settings.showCodexEditorSelectionButton = true;
    activeTerminal.selection = 'selected terminal text';
    activeTextEditor.selection.isEmpty = false;
    await terminalController.refresh();
    await terminalController.refresh();
    await editorController.refresh();
    await editorController.refresh();
    assert.deepEqual(terminalItem.calls, { show: 1, hide: 0 });
    assert.deepEqual(editorItem.calls, { show: 1, hide: 0 });

    activeTerminal.selection = '';
    activeTextEditor.selection.isEmpty = true;
    await terminalController.refresh();
    await terminalController.refresh();
    await editorController.refresh();
    await editorController.refresh();
    assert.deepEqual(terminalItem.calls, { show: 1, hide: 1 });
    assert.deepEqual(editorItem.calls, { show: 1, hide: 1 });
  } finally {
    restore();
  }
});
