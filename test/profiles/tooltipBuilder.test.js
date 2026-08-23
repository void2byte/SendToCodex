'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createMockVscode, installMockVscode } = require('../helpers/mockVscode');

const USAGE_API_SOURCE = 'https://chatgpt.com/backend-api/wham/usage';

test('profile tooltip keeps weekly limit and reset countdown inside the limits table cell', () => {
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
      workspace: {
        getConfiguration: () => ({
          get: (_key, fallback) => fallback
        })
      }
    }
  });
  const restore = installMockVscode(mock.vscode);
  try {
    delete require.cache[require.resolve('../../src/profiles/tooltipBuilder')];
    const { createProfileTooltip } = require('../../src/profiles/tooltipBuilder');
    const now = Date.now();
    const tooltip = createProfileTooltip(
      { id: 'profile-1' },
      [
        {
          id: 'profile-1',
          name: 'Profile 1',
          planType: 'plus',
          rateLimitState: {
            observedAt: now,
            sourceFile: USAGE_API_SOURCE,
            primary: {
              usedPercent: 40,
              resetAt: now + 60 * 60 * 1000,
              windowMinutes: 300
            },
            secondary: {
              usedPercent: 25,
              resetAt: now + 24 * 60 * 60 * 1000,
              windowMinutes: 10_080
            }
          }
        },
        {
          id: 'profile-2',
          name: 'Zero Profile',
          planType: 'plus',
          rateLimitState: {
            observedAt: now,
            sourceFile: USAGE_API_SOURCE,
            primary: {
              usedPercent: 100,
              resetAt: now + 2 * 60 * 60 * 1000,
              windowMinutes: 300
            },
            secondary: {
              usedPercent: 100,
              resetAt: now + 2 * 24 * 60 * 60 * 1000,
              windowMinutes: 10_080
            }
          }
        }
      ],
      new Map([
        [
          'profile-1',
          [
            {
              windowId: 'other-window',
              profileId: 'profile-1',
              workspaceLabel: 'Other Workspace (Workspace)',
              updatedAt: now
            }
          ]
        ]
      ])
    );

    assert.match(
      tooltip.value,
      /5H 60% remaining \\- resets in 1h<br>W 75% remaining \\- resets in 1d/
    );
    assert.doesNotMatch(tooltip.value, /\\\| W/);
    assert.match(tooltip.value, /\| Account \| Plan \| Limits \| Windows \|/);
    assert.match(tooltip.value, /\$\(window\) This window, Other Workspace/);
    assert.match(
      tooltip.value,
      /<a href="command:codex-switch\.profile\.activate\?%5B%22profile-2%22%5D"><font color="#858585">Zero Profile<\/font><\/a>/
    );
    assert.match(
      tooltip.value,
      /<font color="#858585">5H 0% remaining \\- resets in 2d<br>W 0% remaining \\- resets in 2d<\/font>/
    );
    assert.doesNotMatch(tooltip.value, /ACTIVE/);
    assert.doesNotMatch(tooltip.value, /1 other window:/);
    assert.doesNotMatch(tooltip.value, /\(Workspace\)/);
  } finally {
    restore();
  }
});
