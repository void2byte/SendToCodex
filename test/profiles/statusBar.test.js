'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createMockVscode, installMockVscode } = require('../helpers/mockVscode');

const USAGE_API_SOURCE = 'https://chatgpt.com/backend-api/wham/usage';

test('profile status bar does not rerender its hovered item during equivalent refreshes', () => {
  const writes = {
    text: 0,
    command: 0,
    color: 0,
    tooltip: 0,
    show: 0,
    hide: 0
  };
  const values = {};
  const statusBarItem = {
    show() {
      writes.show += 1;
    },
    hide() {
      writes.hide += 1;
    },
    dispose() {}
  };
  for (const property of ['text', 'command', 'color', 'tooltip']) {
    Object.defineProperty(statusBarItem, property, {
      configurable: true,
      enumerable: true,
      get() {
        return values[property];
      },
      set(value) {
        values[property] = value;
        writes[property] += 1;
      }
    });
  }

  class ThemeColor {
    constructor(id) {
      this.id = id;
    }
  }

  class MarkdownString {
    constructor() {
      this.value = '';
    }

    appendMarkdown(text) {
      this.value += text;
      return this;
    }
  }

  const mock = createMockVscode({
    overrides: {
      MarkdownString,
      ThemeColor,
      StatusBarAlignment: {
        Right: 2
      },
      workspace: {
        name: 'Status Bar Test',
        workspaceFolders: [],
        getConfiguration: () => ({
          get: (_key, fallback) => fallback
        })
      },
      window: {
        createStatusBarItem: () => statusBarItem
      }
    }
  });
  const restore = installMockVscode(mock.vscode);
  const originalDateNow = Date.now;

  try {
    delete require.cache[require.resolve('../../src/profiles/statusBar')];
    delete require.cache[require.resolve('../../src/profiles/tooltipBuilder')];
    const { ProfileStatusBarController } = require('../../src/profiles/statusBar');
    const now = 1_800_000_000_000;
    Date.now = () => now;
    const profile = {
      id: 'profile-1',
      name: 'Profile 1',
      planType: 'plus',
      rateLimitState: {
        observedAt: now,
        sourceFile: USAGE_API_SOURCE,
        primary: {
          usedPercent: 20,
          resetAt: now + 2 * 60 * 60 * 1000,
          windowMinutes: 300
        },
        secondary: {
          usedPercent: 30,
          resetAt: now + 2 * 24 * 60 * 60 * 1000,
          windowMinutes: 10_080
        }
      }
    };

    const controller = new ProfileStatusBarController();
    controller.update(profile, [profile], new Map());
    const writesAfterFirstActiveRender = { ...writes };

    Date.now = () => now + 61 * 60 * 1000;
    controller.update(profile, [profile], new Map());

    assert.equal(writes.show, 1);
    assert.equal(writes.text, writesAfterFirstActiveRender.text);
    assert.equal(writes.command, writesAfterFirstActiveRender.command);
    assert.equal(writes.color, writesAfterFirstActiveRender.color);
    assert.equal(writes.tooltip, writesAfterFirstActiveRender.tooltip);
    assert.match(statusBarItem.text, /5H 80% \| W 70%/);
    assert.doesNotMatch(statusBarItem.text, /\b\d+[dhms]\b/);

    const changedProfile = {
      ...profile,
      rateLimitState: {
        ...profile.rateLimitState,
        primary: {
          ...profile.rateLimitState.primary,
          usedPercent: 25
        }
      }
    };
    controller.update(changedProfile, [changedProfile], new Map());

    assert.equal(writes.text, writesAfterFirstActiveRender.text + 1);
    assert.equal(writes.tooltip, writesAfterFirstActiveRender.tooltip + 1);
    assert.equal(writes.show, 1);
  } finally {
    Date.now = originalDateNow;
    restore();
    delete require.cache[require.resolve('../../src/profiles/statusBar')];
    delete require.cache[require.resolve('../../src/profiles/tooltipBuilder')];
  }
});
