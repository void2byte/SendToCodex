'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  ACTION_BACKUP_LIMIT,
  DAILY_BACKUP_RETENTION_DAYS,
  HOURLY_BACKUP_INTERVALS,
  ProfileBackupStore,
  THREE_HOUR_BACKUP_INTERVALS,
  selectRetainedBackupPaths
} = require('../../src/profiles/profileBackupStore');

function createSecretStorage() {
  const values = new Map();
  return {
    values,
    get: async (key) => values.get(key),
    store: async (key, value) => values.set(key, value)
  };
}

test('profile backups are encrypted, authenticated, and restorable', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-profile-backup-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new ProfileBackupStore(directory, createSecretStorage());
  const snapshot = {
    profilesFile: { version: 2, profiles: [{ id: 'profile-a' }] },
    secrets: [{ profileId: 'profile-a', tokens: { accessToken: 'private-token' } }]
  };

  const written = await store.write(snapshot, 'test', Date.UTC(2026, 7, 12, 10));
  const storedText = fs.readFileSync(written.path, 'utf8');
  assert.doesNotMatch(storedText, /private-token|profile-a/);
  const restored = await store.read(written.path);
  assert.deepEqual(restored.profilesFile, snapshot.profilesFile);
  assert.deepEqual(restored.secrets, snapshot.secrets);
  assert.equal(restored.reason, 'test');
});

test('profile backup retention uses action, hourly, three-hour, and daily tiers', () => {
  const referenceTimestamp = Date.UTC(2026, 7, 31, 12);
  const hourMs = 60 * 60 * 1000;
  const dayMs = 24 * hourMs;
  const backups = [];
  const addBackup = (pathSuffix, ageMs, reason = 'profile-change') => {
    backups.push({
      path: path.join('backups', pathSuffix),
      createdAt: new Date(referenceTimestamp - ageMs).toISOString(),
      reason
    });
  };

  addBackup('reference', 0);
  for (let index = 0; index < ACTION_BACKUP_LIMIT + 2; index += 1) {
    addBackup(`action-${index}`, (40 + index) * dayMs, 'before-paid-limit-reset');
  }
  for (let interval = 0; interval < HOURLY_BACKUP_INTERVALS; interval += 1) {
    addBackup(`hour-${interval}-new`, interval * hourMs + 0.1 * hourMs);
    addBackup(`hour-${interval}-old`, interval * hourMs + 0.9 * hourMs);
  }
  const threeHourStart = HOURLY_BACKUP_INTERVALS * hourMs;
  for (let interval = 0; interval < THREE_HOUR_BACKUP_INTERVALS; interval += 1) {
    addBackup(`three-hour-${interval}-new`, threeHourStart + interval * 3 * hourMs + 0.1 * hourMs);
    addBackup(`three-hour-${interval}-old`, threeHourStart + interval * 3 * hourMs + 2.9 * hourMs);
  }
  const dailyStart =
    threeHourStart + THREE_HOUR_BACKUP_INTERVALS * 3 * hourMs;
  for (let interval = 0; interval < DAILY_BACKUP_RETENTION_DAYS + 2; interval += 1) {
    addBackup(`day-${interval}-new`, dailyStart + interval * dayMs + 0.1 * dayMs);
    addBackup(`day-${interval}-old`, dailyStart + interval * dayMs + 0.9 * dayMs);
  }
  backups.sort((left, right) => right.createdAt.localeCompare(left.createdAt));

  const retained = selectRetainedBackupPaths(backups);
  assert.equal(
    retained.size,
    ACTION_BACKUP_LIMIT +
      HOURLY_BACKUP_INTERVALS +
      THREE_HOUR_BACKUP_INTERVALS +
      DAILY_BACKUP_RETENTION_DAYS
  );
  for (let index = 0; index < ACTION_BACKUP_LIMIT; index += 1) {
    assert.equal(retained.has(path.join('backups', `action-${index}`)), true);
  }
  assert.equal(retained.has(path.join('backups', `action-${ACTION_BACKUP_LIMIT}`)), false);
  for (let interval = 0; interval < HOURLY_BACKUP_INTERVALS; interval += 1) {
    assert.equal(retained.has(path.join('backups', `hour-${interval}-old`)), true);
    assert.equal(retained.has(path.join('backups', `hour-${interval}-new`)), false);
  }
  for (let interval = 0; interval < THREE_HOUR_BACKUP_INTERVALS; interval += 1) {
    assert.equal(retained.has(path.join('backups', `three-hour-${interval}-old`)), true);
    assert.equal(retained.has(path.join('backups', `three-hour-${interval}-new`)), false);
  }
  assert.equal(retained.has(path.join('backups', 'day-0-old')), true);
  assert.equal(
    retained.has(path.join('backups', `day-${DAILY_BACKUP_RETENTION_DAYS}-old`)),
    false
  );
});

test('profile backups can be deleted only through a validated backup path', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-profile-delete-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new ProfileBackupStore(directory, createSecretStorage());
  const written = await store.write({ value: 'temporary' }, 'manual');

  store.delete(written.path);
  assert.equal(fs.existsSync(written.path), false);
  assert.throws(
    () => store.delete(path.join(directory, 'outside.backup.json')),
    /outside the backup directory/
  );
});

test('profile backup authentication rejects modified ciphertext', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-profile-tamper-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new ProfileBackupStore(directory, createSecretStorage());
  const written = await store.write({ value: 'preserved' }, 'test');
  const envelope = JSON.parse(fs.readFileSync(written.path, 'utf8'));
  envelope.ciphertext = `${envelope.ciphertext.slice(0, -2)}AA`;
  fs.writeFileSync(written.path, JSON.stringify(envelope), 'utf8');

  await assert.rejects(() => store.read(written.path), /Cannot decrypt or verify/);
});
