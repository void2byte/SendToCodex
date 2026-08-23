'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createMockVscode, installMockVscode } = require('../helpers/mockVscode');

function createStateBucket(values) {
  return {
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

function loadManager(directory, dialogChoice = 'Restore latest') {
  const secrets = new Map();
  const state = new Map();
  const stateBucket = createStateBucket(state);
  const prompts = [];
  const informationMessages = [];
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
        getConfiguration: () => ({ get: (_key, fallback) => fallback })
      },
      window: {
        showErrorMessage: async (message) => {
          prompts.push(message);
          return dialogChoice;
        },
        showInformationMessage: async (message) => {
          informationMessages.push(message);
        },
        showQuickPick: async () => undefined
      }
    }
  });
  const restoreVscode = installMockVscode(mock.vscode);
  delete require.cache[require.resolve('../../src/profiles/profileManager')];
  const { ProfileManager } = require('../../src/profiles/profileManager');
  restoreVscode();

  const context = {
    globalStorageUri: { fsPath: directory },
    globalState: stateBucket,
    workspaceState: stateBucket,
    secrets: {
      get: async (key) => secrets.get(key),
      store: async (key, value) => secrets.set(key, value),
      delete: async (key) => secrets.delete(key)
    }
  };
  return {
    manager: new ProfileManager(context, null),
    secrets,
    state,
    prompts,
    informationMessages
  };
}

function createProfile() {
  return {
    id: 'profile-a',
    name: 'Account A',
    email: 'account-a@example.test',
    planType: 'plus',
    group: 'Primary',
    createdAt: '2026-08-12T08:00:00.000Z',
    updatedAt: '2026-08-12T08:00:00.000Z'
  };
}

test('profile mutations keep both the pre-change state and the changed state', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-manager-change-backup-'));
  const { manager } = loadManager(directory, null);
  t.after(() => {
    manager.dispose();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    manager.getProfilesPath(),
    JSON.stringify({ version: 2, profiles: [createProfile()] }),
    'utf8'
  );

  await manager.renameProfile('profile-a', 'Renamed account');
  if (manager.profileBackupPromise) {
    await manager.profileBackupPromise;
  }

  const snapshots = await Promise.all(
    manager.listProfileBackups().map(async (backup) => ({
      backup,
      snapshot: await manager.getProfileBackupStore().read(backup.path)
    }))
  );
  const before = snapshots.find(
    ({ snapshot }) => snapshot.reason === 'before-profile-rename'
  );
  const after = snapshots.find(({ snapshot }) => snapshot.reason === 'profile-renamed');

  assert.equal(before.snapshot.profilesFile.profiles[0].name, 'Account A');
  assert.equal(after.snapshot.profilesFile.profiles[0].name, 'Renamed account');
});

test('damaged profiles can be restored with tokens, notes, TOTP, and active state', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-manager-backup-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const fixture = loadManager(directory);
  const { manager, secrets, state } = fixture;
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    manager.getProfilesPath(),
    JSON.stringify({ version: 2, profiles: [createProfile()] }),
    'utf8'
  );
  const tokens = {
    idToken: 'id-token',
    accessToken: 'access-token',
    refreshToken: 'refresh-token'
  };
  await secrets.set(manager.secretKey('profile-a'), JSON.stringify(tokens));
  await secrets.set(manager.privateNoteSecretKey('profile-a'), 'important private note');
  await secrets.set(
    manager.privateTotpSecretKey('profile-a'),
    JSON.stringify({ secret: 'JBSWY3DPEHPK3PXP', algorithm: 'SHA1', digits: 6, period: 30 })
  );
  state.set('codexSwitch.activeProfileId', 'profile-a');
  state.set('codexSwitch.lastProfileId', 'profile-a');

  const backup = await manager.createProfileBackup('test');
  const encryptedText = fs.readFileSync(backup.path, 'utf8');
  assert.doesNotMatch(encryptedText, /access-token|important private note|JBSWY3DPEHPK3PXP/);

  fs.writeFileSync(manager.getProfilesPath(), Buffer.alloc(512));
  secrets.delete(manager.secretKey('profile-a'));
  secrets.delete(manager.privateNoteSecretKey('profile-a'));
  secrets.delete(manager.privateTotpSecretKey('profile-a'));
  state.clear();

  const restored = await manager.readProfilesFile();
  assert.equal(restored.profiles.length, 1);
  assert.equal(restored.profiles[0].id, 'profile-a');
  assert.deepEqual(await manager.readStoredTokens('profile-a'), tokens);
  assert.equal(await manager.readProfilePrivateNote('profile-a'), 'important private note');
  assert.equal((await manager.readProfileTotpConfiguration('profile-a')).secret, 'JBSWY3DPEHPK3PXP');
  assert.equal(state.get('codexSwitch.activeProfileId'), 'profile-a');
  assert.equal(state.get('codexSwitch.lastProfileId'), 'profile-a');
  assert.equal(fixture.prompts.length, 1);
  assert.match(fixture.informationMessages[0], /Restored 1 Codex profile/);
});

test('cancelling the restore dialog leaves a damaged profiles file untouched', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-manager-cancel-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const { manager } = loadManager(directory, null);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    manager.getProfilesPath(),
    JSON.stringify({ version: 2, profiles: [createProfile()] }),
    'utf8'
  );
  await manager.createProfileBackup('test');
  const damaged = Buffer.alloc(128);
  fs.writeFileSync(manager.getProfilesPath(), damaged);

  await assert.rejects(() => manager.readProfilesFile(), /Failed to read Codex profiles/);
  assert.deepEqual(fs.readFileSync(manager.getProfilesPath()), damaged);
});

test('the recovery dialog can use the immediate metadata mirror before a daily backup exists', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-manager-mirror-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const { manager } = loadManager(directory);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    manager.getProfilesPath(),
    JSON.stringify({ version: 2, profiles: [createProfile()] }),
    'utf8'
  );
  await manager.readProfilesFile({ offerRestore: false });
  assert.equal(fs.existsSync(manager.getProfilesBackupPath()), true);
  assert.equal(manager.listProfileBackups().length, 0);
  fs.writeFileSync(manager.getProfilesPath(), Buffer.alloc(256));

  const restored = await manager.readProfilesFile();
  assert.equal(restored.profiles[0].id, 'profile-a');
  assert.equal(manager.listProfileBackups().length, 1);
});

test('auth backup retention keeps at most two snapshots per day and fourteen total', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-auth-retention-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const { manager } = loadManager(directory, null);
  const backupsDirectory = manager.ensureAuthBackupsDir();
  const start = Date.UTC(2026, 7, 1, 12);

  for (let day = 0; day < 10; day += 1) {
    for (let index = 0; index < 3; index += 1) {
      const timestamp = new Date(start + day * 24 * 60 * 60 * 1000 + index * 1000);
      const backupPath = path.join(
        backupsDirectory,
        `auth-${day}-${index}.json`
      );
      fs.writeFileSync(backupPath, '{}', 'utf8');
      fs.writeFileSync(
        `${backupPath}.meta.json`,
        JSON.stringify({ createdAt: timestamp.toISOString(), reason: 'test' }),
        'utf8'
      );
    }
  }

  const removed = await manager.pruneAuthBackups(start + 9 * 24 * 60 * 60 * 1000);
  const retained = await manager.listAuthBackups();
  assert.ok(removed > 0);
  assert.equal(retained.length, 14);
  const perDay = new Map();
  for (const backup of retained) {
    const day = backup.createdAt.slice(0, 10);
    perDay.set(day, (perDay.get(day) || 0) + 1);
    assert.equal(fs.existsSync(`${backup.path}.meta.json`), true);
  }
  assert.ok([...perDay.values()].every((count) => count <= 2));
});

test('portable vault stays current and imports tokens, notes, TOTP, and limit records', async (t) => {
  const sourceDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-vault-source-'));
  const targetDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-vault-target-'));
  const sourceFixture = loadManager(sourceDirectory, null);
  const targetFixture = loadManager(targetDirectory, null);
  const password = 'portable vault test password';
  t.after(() => {
    sourceFixture.manager.dispose();
    targetFixture.manager.dispose();
    fs.rmSync(sourceDirectory, { recursive: true, force: true });
    fs.rmSync(targetDirectory, { recursive: true, force: true });
  });

  const profile = {
    ...createProfile(),
    rateLimitState: {
      observedAt: Date.UTC(2026, 7, 20, 12),
      sourceFile: 'usage-api',
      planType: 'plus',
      totalTokens: 100,
      lastTokens: 20,
      primary: {
        usedPercent: 35,
        resetAt: Date.UTC(2030, 7, 20, 17),
        windowMinutes: 300
      },
      secondary: null
    }
  };
  fs.mkdirSync(sourceDirectory, { recursive: true });
  fs.writeFileSync(
    sourceFixture.manager.getProfilesPath(),
    JSON.stringify({ version: 2, profiles: [profile] }),
    'utf8'
  );
  const tokens = {
    idToken: 'portable-id-token',
    accessToken: 'portable-access-token',
    refreshToken: 'portable-refresh-token',
    accountId: 'portable-account-id'
  };
  sourceFixture.secrets.set(
    sourceFixture.manager.secretKey('profile-a'),
    JSON.stringify(tokens)
  );
  sourceFixture.secrets.set(
    sourceFixture.manager.privateNoteSecretKey('profile-a'),
    'portable private note'
  );
  sourceFixture.secrets.set(
    sourceFixture.manager.privateTotpSecretKey('profile-a'),
    JSON.stringify({
      secret: 'JBSWY3DPEHPK3PXP',
      algorithm: 'SHA1',
      digits: 6,
      period: 30
    })
  );
  sourceFixture.state.set('codexSwitch.activeProfileId', 'profile-a');

  const enabled = await sourceFixture.manager.enablePortableProfileVault(password);
  const encryptedText = fs.readFileSync(enabled.path, 'utf8');
  assert.doesNotMatch(
    encryptedText,
    /portable-access-token|portable private note|JBSWY3DPEHPK3PXP/
  );

  await sourceFixture.manager.renameProfile('profile-a', 'Renamed portable account');
  if (sourceFixture.manager.profileBackupPromise) {
    await sourceFixture.manager.profileBackupPromise;
  }
  const sourceVault = sourceFixture.manager.getPortableProfileVaultStore().read(password);
  assert.equal(
    sourceVault.snapshot.profilesFile.profiles[0].name,
    'Renamed portable account'
  );

  fs.mkdirSync(targetDirectory, { recursive: true });
  fs.copyFileSync(
    sourceFixture.manager.getPortableProfileVaultPath(),
    targetFixture.manager.getPortableProfileVaultPath()
  );
  const detected = await targetFixture.manager.getPortableProfileVaultStatus();
  assert.equal(detected.state, 'available');
  assert.equal(detected.profileCount, 1);

  const imported = await targetFixture.manager.importPortableProfileVault(password, {
    keepSynchronized: true
  });
  assert.deepEqual(imported, {
    created: 1,
    updated: 0,
    skipped: 0,
    importedProfileCount: 1
  });
  const importedProfiles = await targetFixture.manager.listProfiles();
  assert.equal(importedProfiles[0].name, 'Renamed portable account');
  assert.equal(importedProfiles[0].rateLimitState.primary.usedPercent, 35);
  assert.deepEqual(await targetFixture.manager.readStoredTokens('profile-a'), tokens);
  assert.equal(
    await targetFixture.manager.readProfilePrivateNote('profile-a'),
    'portable private note'
  );
  assert.equal(
    (await targetFixture.manager.readProfileTotpConfiguration('profile-a')).secret,
    'JBSWY3DPEHPK3PXP'
  );
  assert.equal(targetFixture.state.get('codexSwitch.activeProfileId'), 'profile-a');
  assert.equal((await targetFixture.manager.getPortableProfileVaultStatus()).state, 'synced');
});

test('automatic vault sync refuses to overwrite an externally changed file', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-vault-conflict-'));
  const fixture = loadManager(directory, null);
  const { manager, secrets } = fixture;
  const password = 'portable conflict password';
  t.after(() => {
    manager.dispose();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    manager.getProfilesPath(),
    JSON.stringify({ version: 2, profiles: [createProfile()] }),
    'utf8'
  );
  secrets.set(
    manager.secretKey('profile-a'),
    JSON.stringify({
      idToken: 'id-token',
      accessToken: 'access-token',
      refreshToken: 'refresh-token'
    })
  );

  const initial = await manager.enablePortableProfileVault(password);
  const externalSnapshot = await manager.captureFullProfileSnapshot();
  externalSnapshot.profilesFile.profiles[0].name = 'External vault name';
  const external = manager
    .getPortableProfileVaultStore()
    .write(externalSnapshot, password);
  assert.notEqual(external.fingerprint, initial.fingerprint);

  const result = await manager.syncPortableProfileVault('test-conflict');
  assert.equal(result.synced, false);
  assert.equal(result.state, 'conflict');
  assert.equal(manager.getPortableProfileVaultStore().inspect().fingerprint, external.fingerprint);
  assert.equal((await manager.getPortableProfileVaultStatus()).state, 'conflict');
});
