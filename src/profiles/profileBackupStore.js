'use strict';

const fs = require('fs');
const path = require('path');
const {
  createCipheriv,
  createDecipheriv,
  randomBytes
} = require('crypto');
const { writeJsonAtomicSync } = require('./atomicJsonStore');

const BACKUP_DIRECTORY_NAME = 'profile-backups';
const BACKUP_FILENAME_PATTERN =
  /^profiles-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)-([a-z0-9-]+)-([a-f0-9]{8})\.backup\.json$/;
const BACKUP_FORMAT = 'codex-switch-encrypted-backup';
const BACKUP_VERSION = 1;
const BACKUP_KEY_SECRET = 'codexSwitch.profileBackupEncryptionKey';
const ACTION_BACKUP_LIMIT = 3;
const HOURLY_BACKUP_INTERVALS = 7;
const THREE_HOUR_BACKUP_INTERVALS = 5;
const DAILY_BACKUP_RETENTION_DAYS = 30;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const AUTOMATIC_BACKUP_REASON = 'profile-change';

function getTimestampPart(timestamp) {
  return new Date(timestamp).toISOString().replace(/[:.]/g, '-');
}

function normalizeReasonPart(reason) {
  return String(reason || 'backup')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'backup';
}

function retainOldestBackupPerAgeInterval(
  retainedPaths,
  backups,
  referenceTimestamp,
  startAgeMs,
  intervalMs,
  intervalCount
) {
  const retainedIntervals = new Set();
  for (const backup of backups.slice().reverse()) {
    const ageMs = referenceTimestamp - Date.parse(backup.createdAt);
    const intervalIndex = Math.floor((ageMs - startAgeMs) / intervalMs);
    if (
      ageMs < startAgeMs ||
      intervalIndex < 0 ||
      intervalIndex >= intervalCount ||
      retainedIntervals.has(intervalIndex)
    ) {
      continue;
    }
    retainedIntervals.add(intervalIndex);
    retainedPaths.add(backup.path);
  }
}

function selectRetainedBackupPaths(backups) {
  const retainedPaths = new Set();
  if (!Array.isArray(backups) || backups.length === 0) {
    return retainedPaths;
  }

  for (const backup of backups
    .filter((entry) => entry.reason !== AUTOMATIC_BACKUP_REASON)
    .slice(0, ACTION_BACKUP_LIMIT)) {
    retainedPaths.add(backup.path);
  }

  const referenceTimestamp = Math.max(
    ...backups.map((backup) => Date.parse(backup.createdAt)).filter(Number.isFinite)
  );
  if (!Number.isFinite(referenceTimestamp)) {
    return retainedPaths;
  }

  retainOldestBackupPerAgeInterval(
    retainedPaths,
    backups,
    referenceTimestamp,
    0,
    HOUR_MS,
    HOURLY_BACKUP_INTERVALS
  );
  const threeHourStartAgeMs = HOURLY_BACKUP_INTERVALS * HOUR_MS;
  retainOldestBackupPerAgeInterval(
    retainedPaths,
    backups,
    referenceTimestamp,
    threeHourStartAgeMs,
    3 * HOUR_MS,
    THREE_HOUR_BACKUP_INTERVALS
  );
  const dailyStartAgeMs =
    threeHourStartAgeMs + THREE_HOUR_BACKUP_INTERVALS * 3 * HOUR_MS;
  retainOldestBackupPerAgeInterval(
    retainedPaths,
    backups,
    referenceTimestamp,
    dailyStartAgeMs,
    DAY_MS,
    DAILY_BACKUP_RETENTION_DAYS
  );
  return retainedPaths;
}

function parseEncryptionKey(rawValue) {
  if (!rawValue) {
    return null;
  }
  const key = Buffer.from(String(rawValue), 'base64');
  if (key.length !== 32) {
    throw new Error('The protected profile-backup encryption key is invalid.');
  }
  return key;
}

function encryptSnapshot(snapshot, key, createdAt) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const plaintext = Buffer.from(JSON.stringify(snapshot), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    createdAt,
    algorithm: 'aes-256-gcm',
    iv: iv.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64')
  };
}

function decryptSnapshot(envelope, key) {
  if (
    !envelope ||
    envelope.format !== BACKUP_FORMAT ||
    envelope.version !== BACKUP_VERSION ||
    envelope.algorithm !== 'aes-256-gcm'
  ) {
    throw new Error('Unsupported Codex profile backup format.');
  }

  try {
    const decipher = createDecipheriv(
      'aes-256-gcm',
      key,
      Buffer.from(envelope.iv, 'base64')
    );
    decipher.setAuthTag(Buffer.from(envelope.authTag, 'base64'));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
      decipher.final()
    ]);
    return JSON.parse(plaintext.toString('utf8'));
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    throw new Error(`Cannot decrypt or verify the Codex profile backup: ${message}`);
  }
}

class ProfileBackupStore {
  constructor(storageDirectory, secretStorage) {
    this.storageDirectory = storageDirectory;
    this.secretStorage = secretStorage;
  }

  getDirectory() {
    return path.join(this.storageDirectory, BACKUP_DIRECTORY_NAME);
  }

  async getEncryptionKey(createIfMissing) {
    const stored = await this.secretStorage.get(BACKUP_KEY_SECRET);
    const current = parseEncryptionKey(stored);
    if (current) {
      return current;
    }
    if (!createIfMissing) {
      throw new Error('The protected profile-backup encryption key is missing.');
    }
    const created = randomBytes(32);
    await this.secretStorage.store(BACKUP_KEY_SECRET, created.toString('base64'));
    return created;
  }

  list() {
    const directory = this.getDirectory();
    if (!fs.existsSync(directory)) {
      return [];
    }

    return fs.readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && BACKUP_FILENAME_PATTERN.test(entry.name))
      .map((entry) => {
        const filePath = path.join(directory, entry.name);
        const stats = fs.statSync(filePath);
        const match = BACKUP_FILENAME_PATTERN.exec(entry.name);
        const timestamp = match[1].replace(
          /^(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/,
          '$1:$2:$3.$4Z'
        );
        return {
          name: entry.name,
          path: filePath,
          createdAt: new Date(timestamp).toISOString(),
          reason: match[2],
          size: stats.size
        };
      })
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  prune() {
    const backups = this.list();
    const retainedPaths = selectRetainedBackupPaths(backups);

    for (const backup of backups) {
      if (retainedPaths.has(backup.path)) {
        continue;
      }
      fs.unlinkSync(backup.path);
    }
  }

  async write(snapshot, reason = 'scheduled', timestamp = Date.now()) {
    const directory = this.getDirectory();
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const createdAt = new Date(timestamp).toISOString();
    const filePath = path.join(
      directory,
      `profiles-${getTimestampPart(timestamp)}-${normalizeReasonPart(reason)}-${randomBytes(4).toString('hex')}.backup.json`
    );
    const key = await this.getEncryptionKey(true);
    const envelope = encryptSnapshot(
      {
        ...snapshot,
        backupFormatVersion: BACKUP_VERSION,
        createdAt,
        reason
      },
      key,
      createdAt
    );
    writeJsonAtomicSync(filePath, envelope);
    this.prune();
    return {
      path: filePath,
      createdAt,
      size: fs.statSync(filePath).size
    };
  }

  delete(filePath) {
    const resolved = this.resolveBackupPath(filePath);
    fs.unlinkSync(resolved);
  }

  async read(filePath) {
    const resolved = this.resolveBackupPath(filePath);
    const envelope = JSON.parse(fs.readFileSync(resolved, 'utf8'));
    return decryptSnapshot(envelope, await this.getEncryptionKey(false));
  }

  resolveBackupPath(filePath) {
    const resolved = path.resolve(filePath);
    const directory = path.resolve(this.getDirectory());
    if (path.dirname(resolved) !== directory || !BACKUP_FILENAME_PATTERN.test(path.basename(resolved))) {
      throw new Error('The selected profile backup is outside the backup directory.');
    }
    return resolved;
  }
}

module.exports = {
  ACTION_BACKUP_LIMIT,
  BACKUP_KEY_SECRET,
  DAILY_BACKUP_RETENTION_DAYS,
  HOURLY_BACKUP_INTERVALS,
  ProfileBackupStore,
  THREE_HOUR_BACKUP_INTERVALS,
  decryptSnapshot,
  encryptSnapshot,
  selectRetainedBackupPaths
};
