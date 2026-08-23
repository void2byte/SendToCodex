'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createMockVscode, installMockVscode } = require('../helpers/mockVscode');

const USAGE_API_SOURCE = 'https://chatgpt.com/backend-api/wham/usage';

function createStateBucket() {
  const values = new Map();
  return {
    values,
    get: (key) => values.get(key),
    update: async (key, value) => {
      if (value === undefined) {
        values.delete(key);
      } else {
        values.set(key, value);
      }
    }
  };
}

function createWorkspaceConfig(initialValues = {}) {
  const values = new Map(Object.entries({
    'codexSwitch.lowUsageProfileSwitchBehavior': 'ask',
    'codexSwitch.lowUsageSwitchThreshold': 5,
    'codexSwitch.lowUsageSwitchFreshnessMinutes': 60,
    ...initialValues
  }));

  return {
    values,
    getConfiguration: (section) => ({
      get: (key, fallback) => {
        const fullKey = `${section}.${key}`;
        return values.has(fullKey) ? values.get(fullKey) : fallback;
      },
      update: async (key, value) => {
        values.set(`${section}.${key}`, value);
      }
    })
  };
}

function createRateLimitProfile(id, primaryRemaining, weeklyRemaining, now) {
  return {
    id,
    name: id,
    planType: 'plus',
    rateLimitState: {
      observedAt: now - 1000,
      sourceFile: USAGE_API_SOURCE,
      primary: {
        usedPercent: 100 - primaryRemaining,
        resetAt: now + 60 * 60 * 1000,
        windowMinutes: 300
      },
      secondary: {
        usedPercent: 100 - weeklyRemaining,
        resetAt: now + 24 * 60 * 60 * 1000,
        windowMinutes: 10080
      }
    }
  };
}

function loadRateLimitMonitor(options = {}) {
  const workspaceConfig = options.workspaceConfig || createWorkspaceConfig();
  const warningCalls = [];
  const mock = createMockVscode({
    overrides: {
      EventEmitter: class EventEmitter {
        constructor() {
          this.event = () => ({ dispose() {} });
        }

        fire() {}

        dispose() {}
      },
      workspace: {
        getConfiguration: workspaceConfig.getConfiguration
      },
      window: {
        showInformationMessage: async () => undefined,
        showWarningMessage: async (...args) => {
          warningCalls.push(args);
          return options.warningSelection
            ? options.warningSelection(...args)
            : undefined;
        },
        showQuickPick: async (items, quickPickOptions) => {
          mock.quickPickCalls.push({ items, options: quickPickOptions });
          return options.quickPickSelection
            ? options.quickPickSelection(items, quickPickOptions)
            : undefined;
        }
      }
    }
  });
  const restore = installMockVscode(mock.vscode);
  delete require.cache[require.resolve('../../src/profiles/paidLimitResetPrompt')];
  delete require.cache[require.resolve('../../src/profiles/rateLimitMonitor')];
  const { RateLimitMonitor } = require('../../src/profiles/rateLimitMonitor');
  restore();
  return { RateLimitMonitor, mock, warningCalls, workspaceConfig };
}

test('Usage API observations can update a stale saved profile plan', () => {
  const { RateLimitMonitor } = loadRateLimitMonitor();
  const monitor = new RateLimitMonitor({}, null);
  const profile = {
    id: 'profile-1',
    planType: 'plus'
  };
  const observation = {
    planType: 'free'
  };

  assert.equal(monitor.shouldAcceptObservationForProfile(profile, observation), false);
  assert.equal(
    monitor.shouldAcceptObservationForProfile(profile, observation, {
      acceptPlanChange: true
    }),
    true
  );
});

test('low-usage switch prompt ignores weekly-only low usage', async () => {
  const now = Date.now();
  const { RateLimitMonitor, mock } = loadRateLimitMonitor();
  const profiles = [
    createRateLimitProfile('active-profile', 80, 0.5, now),
    createRateLimitProfile('candidate-profile', 80, 80, now)
  ];
  const monitor = new RateLimitMonitor({
    context: { globalState: createStateBucket() },
    listProfiles: async () => profiles
  }, null);

  await monitor.maybeSuggestLowUsageSwitch('active-profile');

  assert.equal(mock.quickPickCalls.length, 0);
  assert.deepEqual(mock.commandCalls, []);
});

test('low-usage switch prompt is rate-limited after dismissal', async () => {
  const now = Date.now();
  const { RateLimitMonitor, mock } = loadRateLimitMonitor({
    quickPickSelection: () => []
  });
  const profiles = [
    createRateLimitProfile('active-profile', 4, 80, now),
    createRateLimitProfile('candidate-profile', 80, 80, now)
  ];
  const monitor = new RateLimitMonitor({
    context: { globalState: createStateBucket() },
    listProfiles: async () => profiles
  }, null);

  await monitor.maybeSuggestLowUsageSwitch('active-profile');
  await monitor.maybeSuggestLowUsageSwitch('active-profile');

  assert.equal(mock.quickPickCalls.length, 1);
  assert.deepEqual(mock.commandCalls, []);
});

test('low-usage switch prompt can reappear after an out-of-schedule reset', async () => {
  const now = Date.now();
  const promptState = createStateBucket();
  const { RateLimitMonitor, mock } = loadRateLimitMonitor({
    quickPickSelection: () => []
  });
  const profiles = [
    createRateLimitProfile('active-profile', 4, 80, now),
    createRateLimitProfile('candidate-profile', 80, 80, now)
  ];
  const profileManager = {
    context: { globalState: promptState },
    listProfiles: async () => profiles
  };

  const firstMonitor = new RateLimitMonitor(profileManager, null);
  await firstMonitor.maybeSuggestLowUsageSwitch('active-profile');

  profiles[0].rateLimitState.primary.unexpectedResetCount = 1;
  const secondMonitor = new RateLimitMonitor(profileManager, null);
  await secondMonitor.maybeSuggestLowUsageSwitch('active-profile');

  assert.equal(mock.quickPickCalls.length, 2);
  assert.deepEqual(mock.commandCalls, []);
});

test('out-of-schedule reset dialog can zero all paid profile limits', async () => {
  const { RateLimitMonitor, warningCalls } = loadRateLimitMonitor({
    warningSelection: (...args) => args[2]
  });
  const resetCalls = [];
  const monitor = new RateLimitMonitor({
    resetPaidProfileRateLimits: async (resetDetectedAt) => {
      resetCalls.push(resetDetectedAt);
      return 3;
    }
  }, null);
  const resetDetectedAt = Date.now();

  assert.equal(
    await monitor.maybeOfferPaidProfileLimitReset(
      { id: 'active-profile', name: 'Active profile' },
      {
        unexpectedResetWindows: ['primary', 'secondary'],
        observedAt: resetDetectedAt
      }
    ),
    true
  );

  assert.equal(warningCalls.length, 1);
  assert.equal(warningCalls[0][1].modal, true);
  assert.deepEqual(resetCalls, [resetDetectedAt]);
});

test('account-only early reset leaves every other paid profile counter unchanged', async () => {
  const { RateLimitMonitor, warningCalls } = loadRateLimitMonitor({
    warningSelection: (...args) => args[3]
  });
  const resetCalls = [];
  const monitor = new RateLimitMonitor({
    resetPaidProfileRateLimits: async (resetDetectedAt) => {
      resetCalls.push(resetDetectedAt);
      return 3;
    }
  }, null);

  assert.equal(
    await monitor.maybeOfferPaidProfileLimitReset(
      { id: 'active-profile', name: 'Active profile' },
      {
        unexpectedResetWindows: ['primary'],
        observedAt: Date.now()
      }
    ),
    false
  );

  assert.equal(warningCalls.length, 1);
  assert.match(warningCalls[0][1].detail, /keep every other stored counter unchanged/i);
  assert.deepEqual(resetCalls, []);
});

test('dismissing the early-reset decision leaves every other counter unchanged', async () => {
  const { RateLimitMonitor } = loadRateLimitMonitor();
  const resetCalls = [];
  const monitor = new RateLimitMonitor({
    resetPaidProfileRateLimits: async (resetDetectedAt) => {
      resetCalls.push(resetDetectedAt);
      return 3;
    }
  }, null);

  assert.equal(
    await monitor.maybeOfferPaidProfileLimitReset(
      { id: 'active-profile', name: 'Active profile' },
      {
        unexpectedResetWindows: ['secondary'],
        observedAt: Date.now()
      }
    ),
    false
  );
  assert.deepEqual(resetCalls, []);
});

test('low-usage switch prompt checkbox can disable future prompts', async () => {
  const now = Date.now();
  const workspaceConfig = createWorkspaceConfig();
  const { RateLimitMonitor, mock } = loadRateLimitMonitor({
    workspaceConfig,
    quickPickSelection: (items) => [items.find((item) => item.id === 'disable')]
  });
  const profiles = [
    createRateLimitProfile('active-profile', 4, 80, now),
    createRateLimitProfile('candidate-profile', 80, 80, now)
  ];
  const monitor = new RateLimitMonitor({
    context: { globalState: createStateBucket() },
    listProfiles: async () => profiles
  }, null);

  await monitor.maybeSuggestLowUsageSwitch('active-profile');
  await monitor.maybeSuggestLowUsageSwitch('active-profile');

  assert.equal(mock.quickPickCalls.length, 1);
  assert.equal(
    workspaceConfig.values.get('codexSwitch.lowUsageProfileSwitchBehavior'),
    'off'
  );
  assert.equal(mock.quickPickCalls[0].options.canPickMany, true);
  assert.deepEqual(mock.commandCalls, []);
});
