'use strict';

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
const DEFAULT_STALE_LOCK_MS = 30_000;
const LOCK_RETRY_MS = 10;
const DEFAULT_RENAME_TIMEOUT_MS = 2_500;
const DEFAULT_RENAME_RETRY_MS = 25;

function sleepSync(durationMs) {
  const signal = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(signal, 0, 0, durationMs);
}

function acquireFileLockSync(filePath, options = {}) {
  const lockPath = `${filePath}.lock`;
  const timeoutMs = options.lockTimeoutMs || DEFAULT_LOCK_TIMEOUT_MS;
  const staleLockMs = options.staleLockMs || DEFAULT_STALE_LOCK_MS;
  const deadline = Date.now() + timeoutMs;

  while (true) {
    try {
      fs.mkdirSync(lockPath);
      return () => {
        try {
          fs.rmdirSync(lockPath);
        } catch (error) {
          const message = error && error.message ? error.message : String(error);
          throw new Error(`Failed to release JSON file lock at ${lockPath}: ${message}`);
        }
      };
    } catch (error) {
      const isWindowsLockContention =
        process.platform === 'win32' && error && (error.code === 'EPERM' || error.code === 'EACCES');
      if (!error || (error.code !== 'EEXIST' && !isWindowsLockContention)) {
        const message = error && error.message ? error.message : String(error);
        throw new Error(`Failed to acquire JSON file lock at ${lockPath}: ${message}`);
      }

      try {
        if (!fs.existsSync(lockPath)) {
          if (Date.now() >= deadline) {
            throw new Error(`Timed out after ${timeoutMs} ms waiting for JSON file lock at ${lockPath}`);
          }
          sleepSync(LOCK_RETRY_MS);
          continue;
        }
        const lockAgeMs = Date.now() - fs.statSync(lockPath).mtimeMs;
        if (lockAgeMs > staleLockMs) {
          fs.rmdirSync(lockPath);
          if (typeof options.onStaleLockRemoved === 'function') {
            options.onStaleLockRemoved({ lockPath, lockAgeMs });
          }
          continue;
        }
      } catch (statError) {
        if (statError && (statError.code === 'ENOENT' || statError.code === 'ENOTEMPTY')) {
          continue;
        }
        const message = statError && statError.message ? statError.message : String(statError);
        throw new Error(`Failed to inspect JSON file lock at ${lockPath}: ${message}`);
      }

      if (Date.now() >= deadline) {
        throw new Error(`Timed out after ${timeoutMs} ms waiting for JSON file lock at ${lockPath}`);
      }
      sleepSync(LOCK_RETRY_MS);
    }
  }
}

function isTransientRenameError(error) {
  return Boolean(
    error && (error.code === 'EPERM' || error.code === 'EACCES' || error.code === 'EBUSY')
  );
}

function copyFileAndVerifySync(temporaryPath, filePath, options = {}) {
  const copyFileSync =
    typeof options.copyFileSync === 'function' ? options.copyFileSync : fs.copyFileSync;
  const readFileSync =
    typeof options.readFileSync === 'function' ? options.readFileSync : fs.readFileSync;

  copyFileSync(temporaryPath, filePath);

  const temporaryContents = readFileSync(temporaryPath);
  const storedContents = readFileSync(filePath);
  if (!temporaryContents.equals(storedContents)) {
    const error = new Error(`Fallback JSON replacement verification failed at ${filePath}`);
    error.code = 'EIO';
    throw error;
  }
}

function replaceFileWithRetrySync(temporaryPath, filePath, options = {}) {
  const renameSync = typeof options.renameSync === 'function' ? options.renameSync : fs.renameSync;
  const timeoutMs = Number.isFinite(options.renameTimeoutMs)
    ? Math.max(0, options.renameTimeoutMs)
    : DEFAULT_RENAME_TIMEOUT_MS;
  const retryMs = Number.isFinite(options.renameRetryMs)
    ? Math.max(1, options.renameRetryMs)
    : DEFAULT_RENAME_RETRY_MS;
  const allowCopyFallback =
    options.allowCopyFallback === true;
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  let attempts = 0;
  let lastError = null;

  while (true) {
    attempts += 1;
    try {
      renameSync(temporaryPath, filePath);
      if (attempts > 1 && typeof options.onTransientRenameRecovered === 'function') {
        options.onTransientRenameRecovered({
          filePath,
          attempts,
          elapsedMs: Date.now() - startedAt,
          errorCode: lastError && lastError.code ? lastError.code : null
        });
      }
      return;
    } catch (error) {
      lastError = error;
      if (!isTransientRenameError(error)) {
        const message = error && error.message ? error.message : String(error);
        const wrapped = new Error(
          `Failed to atomically replace JSON file at ${filePath} after ${attempts} attempt(s): ${message}`
        );
        wrapped.code = error && error.code ? error.code : undefined;
        wrapped.cause = error;
        throw wrapped;
      }

      // Windows can allow an existing file to be read and written while temporarily denying
      // rename/delete access. The caller holds the cross-process JSON lock here, so an
      // overwrite followed by byte-for-byte verification is a safe fallback for that case.
      if (allowCopyFallback) {
        try {
          copyFileAndVerifySync(temporaryPath, filePath, options);
          if (typeof options.onTransientRenameRecovered === 'function') {
            options.onTransientRenameRecovered({
              filePath,
              attempts,
              elapsedMs: Date.now() - startedAt,
              errorCode: error.code || null,
              strategy: 'verified-copy'
            });
          }
          return;
        } catch (copyError) {
          lastError = copyError;
          if (!isTransientRenameError(copyError)) {
            const message = copyError && copyError.message
              ? copyError.message
              : String(copyError);
            const wrapped = new Error(
              `Failed to replace JSON file at ${filePath} after rename and copy fallback: ${message}`
            );
            wrapped.code = copyError && copyError.code ? copyError.code : undefined;
            wrapped.cause = copyError;
            throw wrapped;
          }
        }
      }

      if (Date.now() >= deadline) {
        const message = lastError && lastError.message ? lastError.message : String(lastError);
        const wrapped = new Error(
          `Failed to atomically replace JSON file at ${filePath} after ${attempts} attempt(s): ${message}`
        );
        wrapped.code = lastError && lastError.code ? lastError.code : undefined;
        wrapped.cause = lastError;
        throw wrapped;
      }

      sleepSync(Math.min(retryMs, Math.max(1, deadline - Date.now())));
    }
  }
}

function writeJsonAtomicSync(filePath, data, options = {}) {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  const serializedValue = JSON.stringify(data, null, 2);
  let temporaryDescriptor = null;

  try {
    temporaryDescriptor = fs.openSync(temporaryPath, 'wx', 0o600);
    fs.writeFileSync(temporaryDescriptor, serializedValue, 'utf8');
    fs.fsyncSync(temporaryDescriptor);
    fs.closeSync(temporaryDescriptor);
    temporaryDescriptor = null;
    replaceFileWithRetrySync(temporaryPath, filePath, options);
    const storedValue = fs.readFileSync(filePath, 'utf8');
    if (storedValue !== serializedValue) {
      const error = new Error(`Atomic JSON write verification failed at ${filePath}`);
      error.code = 'EIO';
      throw error;
    }
  } finally {
    if (temporaryDescriptor !== null) {
      try {
        fs.closeSync(temporaryDescriptor);
      } catch {
        // Preserve the original write error. The temporary file cleanup below is best effort.
      }
    }
    try {
      fs.unlinkSync(temporaryPath);
    } catch (error) {
      if (!error || error.code !== 'ENOENT') {
        throw error;
      }
    }
  }
}

function readNormalizedFileSync(filePath, normalize) {
  if (!filePath || !fs.existsSync(filePath)) {
    return null;
  }

  return normalize(fs.readFileSync(filePath, 'utf8'));
}

function syncBackupFileSync(backupFilePath, value, normalize, options) {
  if (!backupFilePath) {
    return;
  }

  let backupValue = null;
  try {
    backupValue = readNormalizedFileSync(backupFilePath, normalize);
  } catch {
    // An invalid backup must be replaced by the validated primary value.
  }

  if (backupValue !== null && JSON.stringify(backupValue) === JSON.stringify(value)) {
    return;
  }

  writeJsonAtomicSync(backupFilePath, value, options);
}

function mutateJsonFileSync(filePath, createValue, normalize, mutate, options = {}) {
  const release = acquireFileLockSync(filePath, options);
  let operationError;
  try {
    const rawValue = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : createValue;
    const current = normalizeStoredValueSync(filePath, rawValue, createValue, normalize, options);
    syncBackupFileSync(options.backupFilePath, current, normalize, options);
    const currentSerialized = options.skipWriteIfUnchanged ? JSON.stringify(current) : null;
    const next = normalize(mutate(current));
    if (options.skipWriteIfUnchanged && currentSerialized === JSON.stringify(next)) {
      return next;
    }
    writeJsonAtomicSync(filePath, next, options);
    syncBackupFileSync(options.backupFilePath, next, normalize, options);
    return next;
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    try {
      release();
    } catch (releaseError) {
      if (!operationError) {
        throw releaseError;
      }
    }
  }
}

function normalizeStoredValueSync(filePath, rawValue, createValue, normalize, options) {
  try {
    return normalize(rawValue);
  } catch (error) {
    let recoveredValue = null;
    let recoverySource = null;

    if (options.recoverInvalidValueFromBackup === true && options.backupFilePath) {
      try {
        recoveredValue = readNormalizedFileSync(options.backupFilePath, normalize);
        recoverySource = recoveredValue === null ? null : options.backupFilePath;
      } catch {
        recoveredValue = null;
      }
    }

    if (recoveredValue === null && options.recoverInvalidValue === true) {
      recoveredValue = normalize(createValue);
      recoverySource = 'default';
    }

    if (recoveredValue === null) {
      throw error;
    }

    writeJsonAtomicSync(filePath, recoveredValue, options);
    if (typeof options.onInvalidValueRecovered === 'function') {
      options.onInvalidValueRecovered({
        filePath,
        error,
        recoverySource,
        byteLength:
          typeof rawValue === 'string' ? Buffer.byteLength(rawValue, 'utf8') : null
      });
    }
    return recoveredValue;
  }
}

function readJsonFileSync(filePath, createValue, normalize, options = {}) {
  const release = acquireFileLockSync(filePath, options);
  let operationError;
  try {
    const rawValue = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : createValue;
    const value = normalizeStoredValueSync(filePath, rawValue, createValue, normalize, options);
    syncBackupFileSync(options.backupFilePath, value, normalize, options);
    return value;
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    try {
      release();
    } catch (releaseError) {
      if (!operationError) {
        throw releaseError;
      }
    }
  }
}

module.exports = {
  acquireFileLockSync,
  mutateJsonFileSync,
  readJsonFileSync,
  writeJsonAtomicSync
};
