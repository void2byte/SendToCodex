'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  PortableProfileVaultConflictError,
  PortableProfileVaultStore,
  decryptPortableProfileSnapshot,
  encryptPortableProfileSnapshot
} = require('../../src/profiles/portableProfileVaultStore');

const PASSWORD = 'correct horse battery staple';

function createSnapshot(name = 'Account A') {
  return {
    profilesFile: {
      version: 2,
      profiles: [{ id: 'profile-a', name }]
    },
    activeProfileId: 'profile-a',
    lastProfileId: null,
    secrets: [
      {
        profileId: 'profile-a',
        tokens: { accessToken: 'private-access-token' },
        privateNote: 'private note',
        totp: { secret: 'JBSWY3DPEHPK3PXP' }
      }
    ]
  };
}

test('portable profile vault encryption is password-based and authenticated', () => {
  const snapshot = createSnapshot();
  const envelope = encryptPortableProfileSnapshot(snapshot, PASSWORD);
  const serialized = JSON.stringify(envelope);

  assert.doesNotMatch(serialized, /private-access-token|private note|JBSWY3DPEHPK3PXP/);
  assert.deepEqual(decryptPortableProfileSnapshot(envelope, PASSWORD), snapshot);
  assert.throws(
    () => decryptPortableProfileSnapshot(envelope, 'wrong password value'),
    /Cannot decrypt or verify/
  );
});

test('portable profile vault store detects concurrent external replacement', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-portable-vault-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new PortableProfileVaultStore(path.join(directory, 'profiles.vault.json'));

  const first = store.write(createSnapshot(), PASSWORD, { expectedFingerprint: null });
  const inspection = store.inspect();
  assert.equal(inspection.valid, true);
  assert.equal(inspection.profileCount, 1);
  assert.equal(inspection.fingerprint, first.fingerprint);

  const external = store.write(createSnapshot('External account'), PASSWORD);
  assert.notEqual(external.fingerprint, first.fingerprint);
  assert.throws(
    () =>
      store.write(createSnapshot('Local account'), PASSWORD, {
        expectedFingerprint: first.fingerprint
      }),
    PortableProfileVaultConflictError
  );
  assert.equal(store.inspect().fingerprint, external.fingerprint);
  assert.equal(store.read(PASSWORD).snapshot.profilesFile.profiles[0].name, 'External account');
});
