'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const {
  mutateJsonFileSync,
  readJsonFileSync,
  writeJsonAtomicSync
} = require('../../src/profiles/atomicJsonStore');

function runWorker(modulePath, filePath, workerId, writes) {
  const script = `
    const { mutateJsonFileSync } = require(process.argv[1]);
    const filePath = process.argv[2];
    const workerId = process.argv[3];
    const writes = Number(process.argv[4]);
    for (let index = 0; index < writes; index += 1) {
      mutateJsonFileSync(
        filePath,
        { values: [] },
        (value) => typeof value === 'string' ? JSON.parse(value) : value,
        (value) => ({ values: [...value.values, workerId + ':' + index] })
      );
    }
  `;

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', script, modulePath, filePath, workerId, String(writes)], {
      stdio: ['ignore', 'ignore', 'pipe']
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`Worker ${workerId} exited with ${code}: ${stderr}`));
    });
  });
}

test('atomic JSON store preserves concurrent cross-process mutations', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-active-window-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'active-window-usages.json');
  const modulePath = require.resolve('../../src/profiles/atomicJsonStore');
  const workerCount = 4;
  const writesPerWorker = 25;

  await Promise.all(
    Array.from({ length: workerCount }, (_, index) => {
      return runWorker(modulePath, filePath, `worker-${index}`, writesPerWorker);
    })
  );

  const stored = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.equal(stored.values.length, workerCount * writesPerWorker);
  assert.equal(new Set(stored.values).size, workerCount * writesPerWorker);
  assert.equal(fs.existsSync(`${filePath}.lock`), false);
});

test('atomic JSON write replaces a longer file without leaving trailing bytes', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-atomic-json-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'state.json');
  fs.writeFileSync(filePath, JSON.stringify({ values: Array.from({ length: 100 }, () => 'long') }));

  writeJsonAtomicSync(filePath, { values: ['short'] });

  assert.deepEqual(JSON.parse(fs.readFileSync(filePath, 'utf8')), { values: ['short'] });
});

test('atomic JSON write retries transient Windows rename errors without surfacing them', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-atomic-retry-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'state.json');
  let attempts = 0;
  let recovery = null;

  writeJsonAtomicSync(filePath, { values: ['saved'] }, {
    allowCopyFallback: false,
    renameTimeoutMs: 100,
    renameRetryMs: 1,
    renameSync: (source, destination) => {
      attempts += 1;
      if (attempts < 3) {
        const error = new Error('simulated Windows file contention');
        error.code = 'EPERM';
        throw error;
      }
      fs.renameSync(source, destination);
    },
    onTransientRenameRecovered: (details) => {
      recovery = details;
    }
  });

  assert.equal(attempts, 3);
  assert.equal(recovery.attempts, 3);
  assert.equal(recovery.errorCode, 'EPERM');
  assert.deepEqual(JSON.parse(fs.readFileSync(filePath, 'utf8')), { values: ['saved'] });
});

test('atomic JSON write uses a verified copy when Windows denies rename access', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-atomic-copy-fallback-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'state.json');
  fs.writeFileSync(filePath, JSON.stringify({ values: ['old'] }));
  let recovery = null;

  writeJsonAtomicSync(filePath, { values: ['saved'] }, {
    allowCopyFallback: true,
    renameSync: () => {
      const error = new Error('simulated Windows rename/delete sharing violation');
      error.code = 'EPERM';
      throw error;
    },
    onTransientRenameRecovered: (details) => {
      recovery = details;
    }
  });

  assert.equal(recovery.attempts, 1);
  assert.equal(recovery.errorCode, 'EPERM');
  assert.equal(recovery.strategy, 'verified-copy');
  assert.deepEqual(JSON.parse(fs.readFileSync(filePath, 'utf8')), { values: ['saved'] });
  assert.deepEqual(fs.readdirSync(directory), ['state.json']);
});

test('atomic JSON write never overwrites the destination directly unless opted in', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-atomic-no-copy-default-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'state.json');
  const originalValue = { values: ['preserved'] };
  fs.writeFileSync(filePath, JSON.stringify(originalValue));
  let copyAttempts = 0;

  assert.throws(
    () => {
      writeJsonAtomicSync(filePath, { values: ['not-saved'] }, {
        renameTimeoutMs: 5,
        renameRetryMs: 1,
        renameSync: () => {
          const error = new Error('persistent Windows sharing violation');
          error.code = 'EPERM';
          throw error;
        },
        copyFileSync: () => {
          copyAttempts += 1;
        }
      });
    },
    /Failed to atomically replace JSON file/
  );

  assert.equal(copyAttempts, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(filePath, 'utf8')), originalValue);
});

test('atomic JSON write surfaces a persistent rename error after bounded retries', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-atomic-failure-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'state.json');
  let attempts = 0;

  assert.throws(
    () => {
      writeJsonAtomicSync(filePath, { values: ['not-saved'] }, {
        allowCopyFallback: false,
        renameTimeoutMs: 5,
        renameRetryMs: 1,
        renameSync: () => {
          attempts += 1;
          const error = new Error('persistent Windows file contention');
          error.code = 'EPERM';
          throw error;
        }
      });
    },
    (error) => {
      assert.equal(error.code, 'EPERM');
      assert.match(error.message, /Failed to atomically replace JSON file/);
      assert.match(error.message, /after \d+ attempt\(s\)/);
      return true;
    }
  );

  assert.ok(attempts > 1);
  assert.deepEqual(fs.readdirSync(directory), []);
});

test('atomic JSON write rejects a successful replacement that stores corrupted bytes', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-atomic-verification-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'state.json');

  assert.throws(
    () => writeJsonAtomicSync(filePath, { values: ['saved'] }, {
      renameSync: (source, destination) => {
        fs.writeFileSync(destination, Buffer.alloc(fs.statSync(source).size));
        fs.unlinkSync(source);
      }
    }),
    (error) => {
      assert.equal(error.code, 'EIO');
      assert.match(error.message, /verification failed/);
      return true;
    }
  );

  assert.ok(fs.readFileSync(filePath).every((byte) => byte === 0));
});

test('locked JSON read replaces an invalid disposable value with its default', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-json-read-recovery-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'active-window-usages.json');
  fs.writeFileSync(filePath, Buffer.alloc(472));
  let recovery = null;

  const value = readJsonFileSync(
    filePath,
    { version: 1, windows: [] },
    (rawValue) => typeof rawValue === 'string' ? JSON.parse(rawValue) : rawValue,
    {
      recoverInvalidValue: true,
      onInvalidValueRecovered: (details) => {
        recovery = details;
      }
    }
  );

  assert.deepEqual(value, { version: 1, windows: [] });
  assert.equal(recovery.byteLength, 472);
  assert.match(recovery.error.message, /Unexpected token|JSON/);
  assert.deepEqual(JSON.parse(fs.readFileSync(filePath, 'utf8')), value);
});

test('locked JSON mutation continues after recovering an invalid disposable value', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-json-mutate-recovery-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'active-window-usages.json');
  fs.writeFileSync(filePath, '\0broken');

  const value = mutateJsonFileSync(
    filePath,
    { version: 1, windows: [] },
    (rawValue) => typeof rawValue === 'string' ? JSON.parse(rawValue) : rawValue,
    (current) => ({ ...current, windows: [{ windowId: 'current' }] }),
    { recoverInvalidValue: true }
  );

  assert.deepEqual(value.windows, [{ windowId: 'current' }]);
  assert.deepEqual(JSON.parse(fs.readFileSync(filePath, 'utf8')), value);
});

test('locked JSON read restores a zero-filled primary file from its validated backup', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-json-backup-recovery-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'profiles.json');
  const backupFilePath = `${filePath}.backup`;
  const expected = { version: 2, profiles: [{ id: 'preserved' }] };
  fs.writeFileSync(filePath, Buffer.alloc(12708));
  fs.writeFileSync(backupFilePath, JSON.stringify(expected));
  let recovery = null;

  const value = readJsonFileSync(
    filePath,
    { version: 2, profiles: [] },
    (rawValue) => typeof rawValue === 'string' ? JSON.parse(rawValue) : rawValue,
    {
      backupFilePath,
      recoverInvalidValueFromBackup: true,
      onInvalidValueRecovered: (details) => {
        recovery = details;
      }
    }
  );

  assert.deepEqual(value, expected);
  assert.equal(recovery.recoverySource, backupFilePath);
  assert.equal(recovery.byteLength, 12708);
  assert.deepEqual(JSON.parse(fs.readFileSync(filePath, 'utf8')), expected);
  assert.deepEqual(JSON.parse(fs.readFileSync(backupFilePath, 'utf8')), expected);
});

test('locked JSON mutation keeps its backup current', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-json-backup-sync-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'profiles.json');
  const backupFilePath = `${filePath}.backup`;

  const value = mutateJsonFileSync(
    filePath,
    { version: 2, profiles: [] },
    (rawValue) => typeof rawValue === 'string' ? JSON.parse(rawValue) : rawValue,
    (current) => ({ ...current, profiles: [{ id: 'saved' }] }),
    { backupFilePath }
  );

  assert.deepEqual(JSON.parse(fs.readFileSync(filePath, 'utf8')), value);
  assert.deepEqual(JSON.parse(fs.readFileSync(backupFilePath, 'utf8')), value);
});

test('locked JSON read does not erase profiles when both primary and backup are invalid', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-json-backup-invalid-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'profiles.json');
  const backupFilePath = `${filePath}.backup`;
  fs.writeFileSync(filePath, '\0broken-primary');
  fs.writeFileSync(backupFilePath, '\0broken-backup');

  assert.throws(
    () => readJsonFileSync(
      filePath,
      { version: 2, profiles: [] },
      (rawValue) => typeof rawValue === 'string' ? JSON.parse(rawValue) : rawValue,
      { backupFilePath }
    ),
    /Unexpected token|JSON/
  );

  assert.equal(fs.readFileSync(filePath, 'utf8'), '\0broken-primary');
  assert.equal(fs.readFileSync(backupFilePath, 'utf8'), '\0broken-backup');
});
