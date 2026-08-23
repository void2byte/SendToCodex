'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createMockVscode, installMockVscode } = require('../helpers/mockVscode');

function loadWebview() {
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
  try {
    delete require.cache[require.resolve('../../src/profiles/webview')];
    return require('../../src/profiles/webview');
  } finally {
    restore();
  }
}

test('accounts webview includes persistent clickable column sorting', () => {
  const { RateLimitDetailsPanel } = loadWebview();
  const view = Object.create(RateLimitDetailsPanel.prototype);
  const html = view.renderHtml({
    activeProfile: null,
    activeStatus: null,
    activeWindowsHtml: '',
    currentAuthData: null,
    currentMatch: null,
    groupChoices: ['Ungrouped'],
    lastError: null,
    lastObservation: null,
    lastRefreshResult: null,
    paidRateLimitProfileCount: 0,
    windowNotStartedCount: 2,
    profileViews: [],
    profilesById: new Map(),
    portableProfileVaultStatus: {
      state: 'available',
      enabled: false,
      exists: true,
      valid: true,
      profileCount: 3,
      updatedAt: '2026-08-22T18:00:00.000Z',
      path: 'C:\\vault\\portable-profiles.vault.json',
      error: null
    },
    quickPickSettings: {
      hiddenSections: [],
      sectionOrder: [
        'needsAuth',
        'weeklyLow',
        'coolingDown',
        'ready',
        'staleEstimate',
        'otherProfiles'
      ],
      profileSort: 'availability',
      secondaryProfileSort: 'weeklyResetSoon',
      roundLowWeeklyRemainingToZero: false,
      lowWeeklyRemainingZeroThreshold: 1
    }
  });

  const scriptMatch = html.match(/<script>([\s\S]*)<\/script>/);
  assert.ok(scriptMatch);
  assert.doesNotThrow(() => new Function(scriptMatch[1]));
  assert.match(html, /dataset\.action = 'sort-profile'/);
  assert.match(html, /profileSortDirection/);
  assert.match(html, /'fiveHourRemaining'/);
  assert.match(html, /Primary remaining/);
  assert.match(html, /Weekly remaining/);
  assert.match(html, /descendingDefaultSortKeys/);
  assert.match(html, /elements\.groupBySelect\.value = 'all'/);
  assert.match(html, /Number\(left\.planRank \|\| 0\)/);
  assert.match(html, /dataset\.action = 'private-note'/);
  assert.match(html, /post\('openPrivateNote', \{ profileId \}\)/);
  assert.match(html, /requestPrivateNotePreview/);
  assert.match(html, /const privateNoteHoverDelayMs = 650/);
  assert.match(html, /trigger\.contains\(event\.relatedTarget\)/);
  assert.match(html, /@media \(max-width: 1150px\)/);
  assert.match(html, /'profile-card'/);
  assert.match(html, /className = 'profile-cards'/);
  assert.match(html, /className = 'profile-card-main'/);
  assert.match(html, /className = 'profile-card-details'/);
  assert.match(html, /profile-details-toggle/);
  assert.match(html, /dataset\.action = 'toggle-profile-details'/);
  assert.match(html, /identity\.appendChild\(createProfileCheckbox\(account\)\)/);
  assert.match(html, /identity\.appendChild\(createProfileLimits\(account\)\)/);
  assert.match(html, /main\.appendChild\(createProfileActions\(account\)\)/);
  assert.match(html, /card\.appendChild\(createProfileDetails\(account\)\)/);
  assert.match(html, /details\.hidden = !expandedProfileIds\.has\(account\.id\)/);
  assert.match(html, /expandedProfileIds: \[\.\.\.expandedProfileIds\]/);
  assert.match(html, /action === 'toggle-profile-details'/);
  assert.match(html, /expandedProfileIds\.delete\(profileId\)/);
  assert.match(html, /expandedProfileIds\.add\(profileId\)/);
  assert.match(html, /details\.setAttribute\('aria-expanded', expanded \? 'true' : 'false'\)/);
  assert.match(html, /grid-template-columns: minmax\(0, 1fr\) max-content/);
  assert.match(html, /grid-template-columns: repeat\(6, 22px\)/);
  assert.match(html, /@media \(max-width: 520px\)/);
  assert.match(html, /grid-template-columns: repeat\(3, 22px\)/);
  assert.match(html, /@media \(max-width: 390px\)/);
  assert.match(
    html,
    /\.profile-card-main\s*\{[^}]*display: grid;[^}]*grid-template-columns: minmax\(0, 1fr\) max-content;[^}]*min-width: 0;/s
  );
  assert.match(
    html,
    /\.profile-card-identity\s*\{[^}]*display: grid;[^}]*grid-template-columns: 16px minmax\(0, 1fr\) minmax\(0, max-content\);/s
  );
  assert.match(
    html,
    /\.profile-card-limits\s*\{[^}]*display: grid;[^}]*grid-template-columns: repeat\(2, minmax\(0, max-content\)\);/s
  );
  assert.match(
    html,
    /\.profile-card-actions\s*\{[^}]*display: grid;[^}]*grid-template-columns: repeat\(6, 22px\);[^}]*min-width: 0;/s
  );
  assert.match(
    html,
    /@media \(max-width: 520px\)[\s\S]*?\.profile-card-actions\s*\{[^}]*grid-template-columns: repeat\(3, 22px\);/s
  );
  assert.match(
    html,
    /@media \(max-width: 390px\)[\s\S]*?\.profile-card-main\s*\{[^}]*grid-template-columns: minmax\(0, 1fr\);/s
  );
  assert.doesNotMatch(
    html,
    /\.profile-(?:card|card-main|card-identity|card-limits|card-actions)[^{]*\{[^}]*overflow-x:\s*(?:auto|scroll)/s
  );
  assert.match(
    html,
    /button\.compact-action\s*\{[^}]*box-sizing: border-box;[^}]*width: 22px;[^}]*min-width: 22px;/s
  );
  assert.match(html, /min-height: 32px/);
  assert.match(html, /fiveHourCompactText/);
  assert.doesNotMatch(html, /className = 'profile-card-state'/);
  assert.doesNotMatch(html, /card\.appendChild\(createProfileCheckbox\(account\)\)/);
  assert.doesNotMatch(html, /card\.appendChild\(createGroupSelect\(account\)\)/);
  assert.doesNotMatch(html, /min-width: 1040px/);
  assert.doesNotMatch(html, /content: attr\(data-label\)/);
  assert.doesNotMatch(html, /createTable\(/);
  assert.match(html, /private-note-copy-line/);
  assert.match(html, /private-note-copy-detected-totp/);
  assert.match(html, /savePrivateNoteTotp/);
  assert.match(html, /requestPrivateNoteDetectedTotp/);
  assert.match(html, /Activate unused counters/);
  assert.match(html, /activate-unstarted-counters/);
  assert.match(html, /post\('activateUnstartedCounters'\)/);
  assert.match(html, /data-command-action="manageBackups"/);
  assert.equal(
    (html.match(/data-command-action="manageBackups"/g) || []).length,
    1
  );
  assert.match(html, /left\.active !== right\.active/);
  assert.match(html, /activeFirst\(left, right\)/);
  assert.match(html, /account\.windowNotStarted \? 'not-started-profile'/);
  assert.match(html, /message\.command === 'updateData'/);
  assert.match(html, /hasActiveControlInteraction/);
  assert.match(html, /requestAnimationFrame\(\(\) => window\.scrollTo\(scrollX, scrollY\)\)/);
  assert.match(html, /Portable encrypted profile vault/);
  assert.match(html, /Vault found/);
  assert.match(html, /Add profiles/);
  assert.match(html, /portable-vault-import-sync/);
  assert.match(html, /post\('importPortableProfileVault', \{ keepSynchronized: true \}\)/);
  assert.match(html, /portableProfileVaultRoot/);
  assert.match(html, /overflow-wrap: anywhere/);
});

test('accounts webview replaces HTML only for its initial render', async () => {
  const { RateLimitDetailsPanel } = loadWebview();
  const messages = [];
  const webview = {
    html: '',
    htmlWrites: 0,
    async postMessage(message) {
      messages.push(message);
      return true;
    }
  };
  Object.defineProperty(webview, 'html', {
    get() {
      return this.currentHtml || '';
    },
    set(value) {
      this.currentHtml = value;
      this.htmlWrites += 1;
    }
  });

  const view = Object.create(RateLimitDetailsPanel.prototype);
  view.panel = { webview };
  view.profileManager = {
    listProfiles: async () => [],
    getActiveProfileId: async () => null,
    loadCurrentAuthData: async () => null,
    getCurrentAuthProfileMatch: async () => null
  };
  view.rateLimitMonitor = {
    getLastObservation: () => null,
    getLastError: () => null,
    getLastRefreshResult: () => null
  };
  view.hasRendered = false;
  view.updateRequested = false;
  view.updateInFlight = null;
  view.buildProfileViewModels = async () => [];
  view.renderHtml = () => '<html><body>initial</body></html>';
  view.buildClientUpdateData = (data) => ({
    accounts: data.profileViews
  });
  view.reportOperationError = (_operation, error) => {
    throw error;
  };

  await view.update();
  await view.update();

  assert.equal(webview.htmlWrites, 1);
  assert.equal(webview.html, '<html><body>initial</body></html>');
  assert.deepEqual(messages, [
    {
      command: 'updateData',
      data: {
        accounts: []
      }
    }
  ]);
});
