'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createMockVscode, installMockVscode } = require('../helpers/mockVscode');

function loadProfileManager(storageDirectory, options = {}) {
  const secrets = new Map();
  const state = new Map();
  const stateBucket = {
    get: (key) => state.get(key),
    update: async (key, value) => {
      if (value === undefined) {
        state.delete(key);
      } else {
        state.set(key, value);
      }
    }
  };
  const mock = createMockVscode({
    overrides: {
      EventEmitter: class EventEmitter {
        constructor() {
          this.event = () => ({ dispose() {} });
        }

        fire() {}

        dispose() {}
      },
      env: { remoteName: undefined },
      workspace: {
        getConfiguration: () => ({
          get: (key, fallback) =>
            key === 'profileActivityLogEnabled'
              ? options.profileActivityLogEnabled === true
              : fallback
        })
      }
    }
  });
  const restore = installMockVscode(mock.vscode);
  delete require.cache[require.resolve('../../src/profiles/profileManager')];
  const { ProfileManager } = require('../../src/profiles/profileManager');
  restore();

  return new ProfileManager(
    {
      globalStorageUri: { fsPath: storageDirectory },
      globalState: stateBucket,
      workspaceState: stateBucket,
      secrets: {
        get: async (key) => secrets.get(key),
        store: async (key, value) => {
          secrets.set(key, value);
        },
        delete: async (key) => {
          secrets.delete(key);
        }
      }
    },
    null
  );
}

test('profile activity file is disabled by default and can be enabled per machine', async (t) => {
  const disabledDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-profile-activity-off-'));
  const enabledDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-profile-activity-on-'));
  t.after(() => fs.rmSync(disabledDirectory, { recursive: true, force: true }));
  t.after(() => fs.rmSync(enabledDirectory, { recursive: true, force: true }));

  const disabledManager = loadProfileManager(disabledDirectory);
  await disabledManager.appendProfileActivity('test-disabled', { profileId: 'profile-a' });
  assert.equal(fs.existsSync(disabledManager.getActivityLogPath()), false);

  const enabledManager = loadProfileManager(enabledDirectory, {
    profileActivityLogEnabled: true
  });
  await enabledManager.appendProfileActivity('test-enabled', { profileId: 'profile-a' });
  const entries = fs.readFileSync(enabledManager.getActivityLogPath(), 'utf8').trim().split('\n');
  assert.equal(entries.length, 1);
  assert.equal(JSON.parse(entries[0]).action, 'test-enabled');
});

function createProfile(id) {
  return {
    id,
    name: id,
    email: `${id}@example.com`,
    planType: 'plus',
    createdAt: '2026-07-11T10:00:00.000Z',
    updatedAt: '2026-07-11T10:00:00.000Z'
  };
}

function createObservation(timestamp, usedPercent) {
  return {
    recordTimestampMs: timestamp,
    filePath: 'https://chatgpt.com/backend-api/wham/usage',
    planType: 'plus',
    primary: {
      usedPercent,
      resetAt: timestamp + 60 * 60 * 1000,
      windowMinutes: 300
    },
    secondary: {
      usedPercent: usedPercent + 1,
      resetAt: timestamp + 24 * 60 * 60 * 1000,
      windowMinutes: 10_080
    }
  };
}

test('private account notes stay in SecretStorage and are deleted with the profile', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-private-note-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const profilesPath = path.join(directory, 'profiles.json');
  fs.writeFileSync(
    profilesPath,
    JSON.stringify({ version: 2, profiles: [createProfile('profile-a')] })
  );
  const manager = loadProfileManager(directory);
  const privateText = 'private note that must not be written to profiles.json';

  await manager.writeProfilePrivateNote('profile-a', privateText);

  assert.equal(await manager.readProfilePrivateNote('profile-a'), privateText);
  assert.doesNotMatch(fs.readFileSync(profilesPath, 'utf8'), /private note that must not/);

  assert.equal(await manager.deleteProfile('profile-a'), true);
  assert.equal(await manager.readProfilePrivateNote('profile-a'), '');
});

test('private account notes enforce the editor size limit', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-private-note-size-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const manager = loadProfileManager(directory);

  await assert.rejects(
    () => manager.writeProfilePrivateNote('profile-a', 'x'.repeat(256 * 1024 + 1)),
    /maximum 256 KiB/
  );
});

test('account TOTP secrets stay in SecretStorage and are deleted with the profile', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-private-totp-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const profilesPath = path.join(directory, 'profiles.json');
  fs.writeFileSync(
    profilesPath,
    JSON.stringify({ version: 2, profiles: [createProfile('profile-a')] })
  );
  const manager = loadProfileManager(directory);
  const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

  await manager.writeProfileTotpConfiguration('profile-a', secret);
  const generated = await manager.getProfileTotpCode('profile-a', 59_000);

  assert.equal(generated.configured, true);
  assert.equal(generated.code, '287082');
  assert.doesNotMatch(fs.readFileSync(profilesPath, 'utf8'), new RegExp(secret));

  assert.equal(await manager.deleteProfile('profile-a'), true);
  assert.deepEqual(
    await manager.getProfileTotpCode('profile-a', 59_000),
    { configured: false }
  );
});

test('rate-limit updates for different profiles preserve each other', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-profile-limits-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const profilesPath = path.join(directory, 'profiles.json');
  fs.writeFileSync(
    profilesPath,
    JSON.stringify({ version: 2, profiles: [createProfile('profile-a'), createProfile('profile-b')] })
  );
  const firstManager = loadProfileManager(directory);
  const secondManager = loadProfileManager(directory);
  const timestamp = Date.now();

  await Promise.all([
    firstManager.recordRateLimitObservation('profile-a', createObservation(timestamp, 10)),
    secondManager.recordRateLimitObservation('profile-b', createObservation(timestamp + 1, 70))
  ]);

  const stored = JSON.parse(fs.readFileSync(profilesPath, 'utf8'));
  const first = stored.profiles.find((profile) => profile.id === 'profile-a');
  const second = stored.profiles.find((profile) => profile.id === 'profile-b');
  assert.equal(first.rateLimitState.primary.usedPercent, 10);
  assert.equal(second.rateLimitState.primary.usedPercent, 70);
  assert.equal(first.cooldownUntil, null);
  assert.equal(second.cooldownUntil, null);
});

test('stored cooldown is created only for an exhausted limit window', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-profile-cooldown-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const profilesPath = path.join(directory, 'profiles.json');
  fs.writeFileSync(
    profilesPath,
    JSON.stringify({ version: 2, profiles: [createProfile('profile-a')] })
  );
  const manager = loadProfileManager(directory);
  const timestamp = Date.now();
  const observation = createObservation(timestamp, 100);
  observation.secondary.usedPercent = 50;

  await manager.recordRateLimitObservation('profile-a', observation);

  const stored = JSON.parse(fs.readFileSync(profilesPath, 'utf8'));
  assert.equal(stored.profiles[0].cooldownUntil, observation.primary.resetAt);
});

test('an older completed request cannot replace a newer rate-limit observation', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-profile-order-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const profilesPath = path.join(directory, 'profiles.json');
  fs.writeFileSync(
    profilesPath,
    JSON.stringify({ version: 2, profiles: [createProfile('profile-a')] })
  );
  const manager = loadProfileManager(directory);
  const timestamp = Date.now();

  assert.equal(
    await manager.recordRateLimitObservation('profile-a', createObservation(timestamp, 20)),
    true
  );
  assert.equal(
    await manager.recordRateLimitObservation('profile-a', createObservation(timestamp - 10_000, 90)),
    false
  );

  const stored = JSON.parse(fs.readFileSync(profilesPath, 'utf8'));
  assert.equal(stored.profiles[0].rateLimitState.observedAt, timestamp);
  assert.equal(stored.profiles[0].rateLimitState.primary.usedPercent, 20);
});

test('an out-of-schedule usage drop starts a new tracked limit cycle', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-profile-reset-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const profilesPath = path.join(directory, 'profiles.json');
  fs.writeFileSync(
    profilesPath,
    JSON.stringify({ version: 2, profiles: [createProfile('profile-a')] })
  );
  const manager = loadProfileManager(directory);
  const timestamp = Date.now();
  const firstObservation = createObservation(timestamp, 90);
  const resetObservation = createObservation(timestamp + 60_000, 2);
  resetObservation.primary.resetAt = firstObservation.primary.resetAt;
  resetObservation.secondary.resetAt = firstObservation.secondary.resetAt;

  await manager.recordRateLimitObservation('profile-a', firstObservation);
  await manager.recordRateLimitObservation('profile-a', resetObservation);

  const stored = JSON.parse(fs.readFileSync(profilesPath, 'utf8'));
  assert.equal(stored.profiles[0].rateLimitState.primary.usedPercent, 2);
  assert.equal(stored.profiles[0].rateLimitState.primary.unexpectedResetCount, 1);
  assert.equal(
    stored.profiles[0].rateLimitState.primary.lastUnexpectedResetAt,
    resetObservation.recordTimestampMs
  );
  assert.equal(stored.profiles[0].rateLimitState.secondary.unexpectedResetCount, 1);
});

test('small usage corrections do not count as out-of-schedule resets', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-profile-correction-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const profilesPath = path.join(directory, 'profiles.json');
  fs.writeFileSync(
    profilesPath,
    JSON.stringify({ version: 2, profiles: [createProfile('profile-a')] })
  );
  const manager = loadProfileManager(directory);
  const timestamp = Date.now();

  await manager.recordRateLimitObservation('profile-a', createObservation(timestamp, 50));
  await manager.recordRateLimitObservation(
    'profile-a',
    createObservation(timestamp + 60_000, 47)
  );

  const stored = JSON.parse(fs.readFileSync(profilesPath, 'utf8'));
  assert.equal(stored.profiles[0].rateLimitState.primary.unexpectedResetCount, 0);
  assert.equal(stored.profiles[0].rateLimitState.primary.lastUnexpectedResetAt, null);
});

test('a usage drop at the scheduled reset time is not marked as unexpected', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-profile-scheduled-reset-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const profilesPath = path.join(directory, 'profiles.json');
  fs.writeFileSync(
    profilesPath,
    JSON.stringify({ version: 2, profiles: [createProfile('profile-a')] })
  );
  const manager = loadProfileManager(directory);
  const timestamp = Date.now();
  const firstObservation = createObservation(timestamp, 90);
  firstObservation.primary.resetAt = timestamp + 2 * 60_000;
  const resetObservation = createObservation(timestamp + 2 * 60_000, 2);

  await manager.recordRateLimitObservation('profile-a', firstObservation);
  await manager.recordRateLimitObservation('profile-a', resetObservation);

  const stored = JSON.parse(fs.readFileSync(profilesPath, 'utf8'));
  assert.equal(stored.profiles[0].rateLimitState.primary.unexpectedResetCount, 0);
  assert.equal(stored.profiles[0].rateLimitState.primary.lastUnexpectedResetAt, null);
});

test('manual paid-account reset zeros paid limits and leaves free profiles unchanged', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-profile-paid-reset-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const profilesPath = path.join(directory, 'profiles.json');
  fs.writeFileSync(
    profilesPath,
    JSON.stringify({
      version: 2,
      profiles: [
        createProfile('profile-plus'),
        { ...createProfile('profile-pro'), planType: 'pro' },
        { ...createProfile('profile-free'), planType: 'free' }
      ]
    })
  );
  const manager = loadProfileManager(directory);
  const timestamp = Date.now();
  const plusObservation = createObservation(timestamp, 70);
  const proObservation = createObservation(timestamp + 1, 60);
  proObservation.planType = 'pro';
  const freeObservation = createObservation(timestamp + 2, 50);
  freeObservation.planType = 'free';

  await manager.recordRateLimitObservation('profile-plus', plusObservation);
  await manager.recordRateLimitObservation('profile-pro', proObservation);
  await manager.recordRateLimitObservation('profile-free', freeObservation);
  assert.equal(await manager.resetPaidProfileRateLimits(timestamp + 60_000), 2);

  const preResetBackup = manager.listProfileBackups().find(
    (backup) => backup.reason === 'before-paid-limit-reset'
  );
  assert.ok(preResetBackup);
  const preResetSnapshot = await manager.getProfileBackupStore().read(preResetBackup.path);
  const backedUpPlus = preResetSnapshot.profilesFile.profiles.find(
    (profile) => profile.id === 'profile-plus'
  );
  const backedUpPro = preResetSnapshot.profilesFile.profiles.find(
    (profile) => profile.id === 'profile-pro'
  );
  assert.equal(backedUpPlus.rateLimitState.primary.usedPercent, 70);
  assert.equal(backedUpPro.rateLimitState.primary.usedPercent, 60);

  const stored = JSON.parse(fs.readFileSync(profilesPath, 'utf8'));
  const plus = stored.profiles.find((profile) => profile.id === 'profile-plus');
  const pro = stored.profiles.find((profile) => profile.id === 'profile-pro');
  const free = stored.profiles.find((profile) => profile.id === 'profile-free');
  assert.equal(plus.rateLimitState.primary.usedPercent, 0);
  assert.equal(plus.rateLimitState.secondary.usedPercent, 0);
  assert.equal(pro.rateLimitState.primary.usedPercent, 0);
  assert.equal(pro.rateLimitState.secondary.usedPercent, 0);
  assert.equal(plus.rateLimitState.primary.resetAt, null);
  assert.equal(plus.rateLimitState.secondary.resetAt, null);
  assert.equal(pro.rateLimitState.primary.resetAt, null);
  assert.equal(pro.rateLimitState.secondary.resetAt, null);
  assert.equal(plus.rateLimitState.assumedResetAt, timestamp + 60_000);
  assert.equal(plus.cooldownUntil, null);
  assert.equal(pro.cooldownUntil, null);
  assert.equal(free.rateLimitState.primary.usedPercent, 50);
  assert.equal(free.rateLimitState.secondary.usedPercent, 51);

  const firstUseObservation = createObservation(timestamp + 120_000, 1);
  await manager.recordRateLimitObservation('profile-plus', firstUseObservation);
  const afterFirstUse = JSON.parse(fs.readFileSync(profilesPath, 'utf8'))
    .profiles.find((profile) => profile.id === 'profile-plus');
  assert.equal(afterFirstUse.rateLimitState.primary.usedPercent, 1);
  assert.equal(
    afterFirstUse.rateLimitState.primary.resetAt,
    firstUseObservation.primary.resetAt
  );
  assert.equal(afterFirstUse.rateLimitState.assumedResetAt, null);
});

test('an expired window becomes unused and waits for first use before a new countdown', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-expired-window-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const profilesPath = path.join(directory, 'profiles.json');
  const expiredAt = Date.now() - 1_000;
  fs.writeFileSync(
    profilesPath,
    JSON.stringify({
      version: 2,
      profiles: [{
        ...createProfile('profile-a'),
        rateLimitState: {
          observedAt: expiredAt - 60_000,
          sourceFile: 'codex-app-server://account/rateLimits/read',
          primary: {
            usedPercent: 100,
            resetAt: expiredAt,
            windowMinutes: 300
          },
          secondary: {
            usedPercent: 40,
            resetAt: Date.now() + 24 * 60 * 60 * 1000,
            windowMinutes: 10_080
          }
        }
      }]
    })
  );
  const manager = loadProfileManager(directory);

  assert.equal(await manager.clearExpiredCooldowns(), true);

  const stored = JSON.parse(fs.readFileSync(profilesPath, 'utf8')).profiles[0];
  assert.equal(stored.rateLimitState.primary.usedPercent, 0);
  assert.equal(stored.rateLimitState.primary.resetAt, null);
  assert.equal(stored.rateLimitState.assumedResetAt, expiredAt);
  assert.equal(stored.rateLimitState.secondary.usedPercent, 40);
  assert.ok(stored.rateLimitState.secondary.resetAt > Date.now());
});

test('auth metadata updates do not overwrite a concurrent rate-limit update', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-profile-auth-race-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const profilesPath = path.join(directory, 'profiles.json');
  fs.writeFileSync(
    profilesPath,
    JSON.stringify({ version: 2, profiles: [createProfile('profile-a'), createProfile('profile-b')] })
  );
  const authManager = loadProfileManager(directory);
  const observationManager = loadProfileManager(directory);
  const timestamp = Date.now();

  await Promise.all([
    authManager.replaceProfileAuth('profile-a', {
      email: 'updated-a@example.com',
      planType: 'plus',
      accountId: 'account-a',
      accessToken: 'access-a',
      refreshToken: 'refresh-a',
      idToken: 'id-a',
      authJson: { tokens: { access_token: 'access-a' } }
    }),
    observationManager.recordRateLimitObservation(
      'profile-b',
      createObservation(timestamp, 55)
    )
  ]);

  const stored = JSON.parse(fs.readFileSync(profilesPath, 'utf8'));
  assert.equal(stored.profiles.find((profile) => profile.id === 'profile-a').email, 'updated-a@example.com');
  assert.equal(
    stored.profiles.find((profile) => profile.id === 'profile-b').rateLimitState.primary.usedPercent,
    55
  );
});
