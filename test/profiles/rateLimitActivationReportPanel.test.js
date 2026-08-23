'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createMockVscode, installMockVscode } = require('../helpers/mockVscode');

function loadPanelModule() {
  const mock = createMockVscode();
  const restore = installMockVscode(mock.vscode);
  delete require.cache[
    require.resolve('../../src/profiles/rateLimitActivationReportPanel')
  ];
  const module = require('../../src/profiles/rateLimitActivationReportPanel');
  restore();
  return module;
}

test('activation report keeps diagnostics and chat snapshots under disclosure sections', () => {
  const { buildActivationReportHtml } = loadPanelModule();
  const now = Date.now();
  const html = buildActivationReportHtml({
    jobId: 'job-report',
    mode: 'vscodeExtension',
    modeLabel: 'Official Codex VS Code extension',
    status: 'failed',
    phase: 'completed',
    createdAt: now - 2500,
    completedAt: now,
    durationMs: 2500,
    attempted: 1,
    succeeded: 0,
    failed: 1,
    unconfirmed: 0,
    originalAccountRestored: true,
    environment: {
      extensionVersion: '0.0.76',
      vscodeVersion: '1.130.0',
      codexExtensionVersion: '26.1',
      platform: 'win32',
      architecture: 'x64',
      workspaceTrusted: true
    },
    events: [
      {
        at: now,
        phase: 'account-failed',
        profileId: 'profile-a',
        profileName: 'account-a',
        detail: 'Archive failed'
      }
    ],
    accounts: [
      {
        profileId: 'profile-a',
        profileName: 'account-a',
        status: 'failed',
        startedAt: now - 2500,
        completedAt: now,
        durationMs: 2500,
        failedPhase: 'waiting-for-answer',
        error: 'Archive failed',
        prompt: 'тест',
        responseText: '<response> & useful',
        responseLength: 19,
        threadId: 'thread-a',
        threadReused: false,
        archived: false,
        archiveError: 'Archive failed',
        limitConfirmed: false,
        diagnostics: 'safe diagnostic line',
        rateLimit: {
          source: 'usage-api',
          observedAt: now,
          planType: 'plus',
          primary: null,
          secondary: {
            usedPercent: 0,
            resetAt: null,
            windowMinutes: 10080
          }
        }
      }
    ]
  });

  assert.match(html, /<details class="account failed" open>/);
  assert.match(html, /Official Codex VS Code extension/);
  assert.match(html, /<summary>Chat snapshot · archived: No<\/summary>/);
  assert.match(html, /<summary>Codex diagnostics<\/summary>/);
  assert.match(html, /<summary>Full run timeline<\/summary>/);
  assert.match(html, /<summary>Machine-readable report JSON<\/summary>/);
  assert.match(html, /safe diagnostic line/);
  assert.match(html, /&lt;response&gt; &amp; useful/);
  assert.doesNotMatch(html, /<response>/);
});
