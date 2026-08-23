'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createMockVscode, installMockVscode } = require('../helpers/mockVscode');

function loadCommands(values = {}, vscodeOverrides = {}) {
  const mock = createMockVscode({
    overrides: {
      QuickPickItemKind: {
        Separator: -1
      },
      workspace: {
        getConfiguration: () => ({
          get: (key, fallback) => Object.prototype.hasOwnProperty.call(values, key)
            ? values[key]
            : fallback,
          update: async (key, value) => {
            values[key] = value;
          }
        })
      },
      ...vscodeOverrides
    }
  });
  const restore = installMockVscode(mock.vscode);
  try {
    delete require.cache[require.resolve('../../src/profiles/quickPickSettings')];
    delete require.cache[require.resolve('../../src/profiles/commands')];
    return require('../../src/profiles/commands');
  } finally {
    restore();
  }
}

function createProfileItem(id, name, quickPickSection, overrides = {}) {
  return {
    label: name,
    profileId: id,
    profileDisplayName: name,
    planText: overrides.planText || 'PLUS',
    profileGroup: overrides.profileGroup || 'Work',
    quickPickSortIndex: overrides.quickPickSortIndex || 0,
    primaryResetAt: overrides.primaryResetAt || null,
    weeklyResetAt: overrides.weeklyResetAt || null,
    nextResetAt: overrides.nextResetAt || null,
    observedAt: overrides.observedAt || null,
    primaryRemainingPercent: overrides.primaryRemainingPercent ?? 50,
    weeklyRemainingPercent: overrides.weeklyRemainingPercent ?? 50,
    lowestRemainingPercent: overrides.lowestRemainingPercent ?? 50,
    quickPickSection,
    isActive: overrides.isActive === true
  };
}

test('non-availability popup sort is global across status sections', () => {
  const { buildSwitchQuickPickItems } = loadCommands({
    'profileQuickPick.profileSort': 'name',
    'profileQuickPick.secondaryProfileSort': 'none'
  });
  const profileItems = [
    createProfileItem('active', 'Current', 'ready', { isActive: true }),
    createProfileItem('zulu', 'Zulu', 'ready'),
    createProfileItem('alpha', 'Alpha', 'staleEstimate'),
    createProfileItem('mike', 'Mike', 'coolingDown')
  ];

  const items = buildSwitchQuickPickItems(
    profileItems,
    null,
    false,
    'default',
    true
  );
  const displayedProfileIds = items
    .filter((item) => item.profileId)
    .map((item) => item.profileId);

  assert.deepEqual(displayedProfileIds, ['active', 'alpha', 'mike', 'zulu']);
  assert.equal(
    items.filter((item) => item.kind === -1 && item.label.startsWith('Accounts')).length,
    1
  );
});

test('selected popup sort keeps the active account in the first position', () => {
  const { buildSwitchQuickPickItems } = loadCommands({
    'profileQuickPick.profileSort': 'name',
    'profileQuickPick.secondaryProfileSort': 'none'
  });
  const items = buildSwitchQuickPickItems(
    [
      createProfileItem('zulu-active', 'Zulu', 'ready', { isActive: true }),
      createProfileItem('alpha', 'Alpha', 'ready')
    ],
    null,
    false,
    'default',
    true
  );

  assert.deepEqual(
    items.filter((item) => item.profileId).map((item) => item.profileId),
    ['zulu-active', 'alpha']
  );
});

test('availability popup sort keeps configured status section order', () => {
  const { buildSwitchQuickPickItems } = loadCommands({
    'profileQuickPick.profileSort': 'availability',
    'profileQuickPick.sectionOrder': [
      'staleEstimate',
      'ready',
      'coolingDown',
      'weeklyLow',
      'needsAuth',
      'otherProfiles'
    ]
  });
  const profileItems = [
    createProfileItem('ready', 'Ready', 'ready'),
    createProfileItem('stale', 'Stale', 'staleEstimate'),
    createProfileItem('cooling', 'Cooling', 'coolingDown')
  ];

  const items = buildSwitchQuickPickItems(
    profileItems,
    null,
    false,
    'default',
    true
  );
  const displayedProfileIds = items
    .filter((item) => item.profileId)
    .map((item) => item.profileId);

  assert.deepEqual(displayedProfileIds, ['stale', 'ready', 'cooling']);
});

test('availability popup puts the active account before configured status sections', () => {
  const { buildSwitchQuickPickItems } = loadCommands({
    'profileQuickPick.profileSort': 'availability',
    'profileQuickPick.sectionOrder': [
      'staleEstimate',
      'ready',
      'coolingDown',
      'weeklyLow',
      'needsAuth',
      'otherProfiles'
    ]
  });
  const items = buildSwitchQuickPickItems(
    [
      createProfileItem('stale', 'Stale', 'staleEstimate'),
      createProfileItem('active', 'Current', 'coolingDown', { isActive: true }),
      createProfileItem('ready', 'Ready', 'ready')
    ],
    null,
    false,
    'default',
    true
  );

  assert.deepEqual(
    items.filter((item) => item.profileId).map((item) => item.profileId),
    ['active', 'stale', 'ready']
  );
  assert.equal(
    items.find((item) => item.kind === -1 && item.label.startsWith('Active account')).label,
    'Active account (1)'
  );
});

test('popup exposes sorting controls with the current modes', () => {
  const { buildSwitchQuickPickItems } = loadCommands({
    'profileQuickPick.profileSort': 'name',
    'profileQuickPick.secondaryProfileSort': 'plan'
  });
  const items = buildSwitchQuickPickItems(
    [
      createProfileItem('one', 'One', 'ready'),
      createProfileItem('two', 'Two', 'ready')
    ],
    null,
    false,
    'default',
    true
  );

  assert.equal(items.find((item) => item.profileSortPicker).description, 'Name');
  assert.equal(items.find((item) => item.secondaryProfileSortPicker).description, 'Plan');
  assert.equal(
    items.find((item) => item.command === 'codex-switch.profile.manageBackups').label,
    '$(history) Manage backups...'
  );
});

test('changing popup sort rebuilds account order without closing it', async () => {
  const values = {
    'profileQuickPick.profileSort': 'availability',
    'profileQuickPick.secondaryProfileSort': 'none'
  };
  const quickPick = {
    activeItems: [],
    items: [],
    selectedItems: [],
    onDidAccept(callback) {
      this.accept = callback;
      return { dispose() {} };
    },
    onDidHide(callback) {
      this.didHide = callback;
      return { dispose() {} };
    },
    onDidTriggerItemButton(callback) {
      this.triggerItemButton = callback;
      return { dispose() {} };
    },
    show() {},
    hide() {
      this.didHide();
    },
    dispose() {}
  };
  const { showProfileSwitchQuickPick } = loadCommands(values, {
    window: {
      createQuickPick: () => quickPick
    }
  });
  const selectionPromise = showProfileSwitchQuickPick(
    [
      createProfileItem('zulu', 'Zulu', 'ready', { quickPickSortIndex: 0 }),
      createProfileItem('alpha', 'Alpha', 'staleEstimate', { quickPickSortIndex: 1 })
    ],
    null,
    () => false,
    async () => {},
    () => 'default',
    () => true,
    async () => {}
  );

  quickPick.selectedItems = [quickPick.items.find((item) => item.profileSortPicker)];
  await quickPick.accept();
  quickPick.selectedItems = [
    quickPick.items.find((item) => item.profileSortMode === 'name')
  ];
  await quickPick.accept();

  assert.equal(values['profileQuickPick.profileSort'], 'name');
  assert.deepEqual(
    quickPick.items.filter((item) => item.profileId).map((item) => item.profileId),
    ['alpha', 'zulu']
  );

  quickPick.selectedItems = [quickPick.items.find((item) => item.profileId === 'alpha')];
  await quickPick.accept();
  assert.equal((await selectionPromise).profileId, 'alpha');
});

test('profile notebook button opens the selected private note without switching accounts', async () => {
  const values = {};
  const quickPick = {
    activeItems: [],
    items: [],
    selectedItems: [],
    onDidAccept() {
      return { dispose() {} };
    },
    onDidHide(callback) {
      this.didHide = callback;
      return { dispose() {} };
    },
    onDidTriggerItemButton(callback) {
      this.triggerItemButton = callback;
      return { dispose() {} };
    },
    show() {},
    hide() {
      this.didHide();
    },
    dispose() {}
  };
  const { showProfileSwitchQuickPick } = loadCommands(values, {
    window: {
      createQuickPick: () => quickPick
    }
  });
  const selectionPromise = showProfileSwitchQuickPick(
    [createProfileItem('account-a', 'Account A', 'ready')],
    null,
    () => false,
    async () => {},
    () => 'default',
    () => true,
    async () => {}
  );

  quickPick.triggerItemButton({
    item: quickPick.items.find((item) => item.profileId === 'account-a')
  });

  assert.deepEqual(await selectionPromise, {
    openPrivateNoteProfileId: 'account-a'
  });
});
