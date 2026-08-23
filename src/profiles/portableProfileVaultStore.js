'use strict';

const fs = require('fs');
const path = require('path');
const {
  createCipheriv,
  createDecipheriv,
  createHash,
  pbkdf2Sync,
  randomBytes
} = require('crypto');
const { acquireFileLockSync, writeJsonAtomicSync } = require('./atomicJsonStore');

const PORTABLE_PROFILE_VAULT_FILENAME = 'portable-profiles.vault.json';
const PORTABLE_PROFILE_VAULT_FORMAT = 'codex-switch-portable-profile-vault';
const PORTABLE_PROFILE_VAULT_VERSION = 1;
const PORTABLE_PROFILE_VAULT_ITERATIONS = 210_000;
const MIN_PORTABLE_PROFILE_VAULT_PASSWORD_LENGTH = 12;

class PortableProfileVaultConflictError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PortableProfileVaultConflictError';
    this.code = 'PORTABLE_PROFILE_VAULT_CONFLICT';
  }
}

function fingerprintText(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function normalizePassword(value) {
  const password = typeof value === 'string' ? value : '';
  if (password.length < MIN_PORTABLE_PROFILE_VAULT_PASSWORD_LENGTH) {
    throw new Error(
      `Portable profile vault password must contain at least ${MIN_PORTABLE_PROFILE_VAULT_PASSWORD_LENGTH} characters.`
    );
  }
  return password;
}

function getProfileCount(snapshot) {
  const profiles = snapshot && snapshot.profilesFile && snapshot.profilesFile.profiles;
  return Array.isArray(profiles) ? profiles.length : 0;
}

function decodeRequiredBuffer(value, name, expectedLength) {
  if (typeof value !== 'string' || !value) {
    throw new Error(`Portable profile vault ${name} is missing.`);
  }
  const decoded = Buffer.from(value, 'base64');
  if (decoded.length !== expectedLength) {
    throw new Error(`Portable profile vault ${name} is invalid.`);
  }
  return decoded;
}

function parseEnvelopeText(text) {
  let envelope;
  try {
    envelope = JSON.parse(String(text));
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    throw new Error(`Portable profile vault is not valid JSON: ${message}`);
  }

  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
    throw new Error('Portable profile vault envelope is invalid.');
  }
  if (
    envelope.format !== PORTABLE_PROFILE_VAULT_FORMAT ||
    envelope.version !== PORTABLE_PROFILE_VAULT_VERSION
  ) {
    throw new Error('Unsupported portable profile vault format.');
  }
  if (
    envelope.cipher !== 'aes-256-gcm' ||
    envelope.kdf !== 'pbkdf2-sha256' ||
    envelope.iterations !== PORTABLE_PROFILE_VAULT_ITERATIONS
  ) {
    throw new Error('Unsupported portable profile vault encryption settings.');
  }
  if (typeof envelope.updatedAt !== 'string' || Number.isNaN(Date.parse(envelope.updatedAt))) {
    throw new Error('Portable profile vault timestamp is invalid.');
  }
  if (!Number.isInteger(envelope.profileCount) || envelope.profileCount < 0) {
    throw new Error('Portable profile vault profile count is invalid.');
  }

  decodeRequiredBuffer(envelope.salt, 'salt', 16);
  decodeRequiredBuffer(envelope.iv, 'IV', 12);
  decodeRequiredBuffer(envelope.authTag, 'authentication tag', 16);
  if (typeof envelope.ciphertext !== 'string' || !envelope.ciphertext) {
    throw new Error('Portable profile vault ciphertext is missing.');
  }

  return envelope;
}

function encryptPortableProfileSnapshot(snapshot, password, timestamp = Date.now()) {
  const normalizedPassword = normalizePassword(password);
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    throw new Error('Portable profile snapshot is invalid.');
  }

  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = pbkdf2Sync(
    normalizedPassword,
    salt,
    PORTABLE_PROFILE_VAULT_ITERATIONS,
    32,
    'sha256'
  );
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const plaintext = Buffer.from(JSON.stringify(snapshot), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);

  return {
    format: PORTABLE_PROFILE_VAULT_FORMAT,
    version: PORTABLE_PROFILE_VAULT_VERSION,
    updatedAt: new Date(timestamp).toISOString(),
    profileCount: getProfileCount(snapshot),
    cipher: 'aes-256-gcm',
    kdf: 'pbkdf2-sha256',
    iterations: PORTABLE_PROFILE_VAULT_ITERATIONS,
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64')
  };
}

function decryptPortableProfileSnapshot(envelope, password) {
  const normalizedPassword = normalizePassword(password);
  const normalizedEnvelope = parseEnvelopeText(JSON.stringify(envelope));
  const salt = decodeRequiredBuffer(normalizedEnvelope.salt, 'salt', 16);
  const iv = decodeRequiredBuffer(normalizedEnvelope.iv, 'IV', 12);
  const authTag = decodeRequiredBuffer(
    normalizedEnvelope.authTag,
    'authentication tag',
    16
  );
  const key = pbkdf2Sync(
    normalizedPassword,
    salt,
    PORTABLE_PROFILE_VAULT_ITERATIONS,
    32,
    'sha256'
  );

  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(normalizedEnvelope.ciphertext, 'base64')),
      decipher.final()
    ]);
    const snapshot = JSON.parse(plaintext.toString('utf8'));
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
      throw new Error('decrypted snapshot is invalid');
    }
    return snapshot;
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    throw new Error(`Cannot decrypt or verify the portable profile vault: ${message}`);
  }
}

class PortableProfileVaultStore {
  constructor(filePath) {
    this.filePath = path.resolve(filePath);
  }

  exists() {
    return fs.existsSync(this.filePath);
  }

  inspect() {
    if (!this.exists()) {
      return {
        exists: false,
        valid: false,
        path: this.filePath,
        fingerprint: null,
        updatedAt: null,
        profileCount: 0,
        error: null
      };
    }

    const text = fs.readFileSync(this.filePath, 'utf8');
    const fingerprint = fingerprintText(text);
    try {
      const envelope = parseEnvelopeText(text);
      return {
        exists: true,
        valid: true,
        path: this.filePath,
        fingerprint,
        updatedAt: envelope.updatedAt,
        profileCount: envelope.profileCount,
        error: null
      };
    } catch (error) {
      return {
        exists: true,
        valid: false,
        path: this.filePath,
        fingerprint,
        updatedAt: null,
        profileCount: 0,
        error: error && error.message ? error.message : String(error)
      };
    }
  }

  read(password) {
    const text = fs.readFileSync(this.filePath, 'utf8');
    const envelope = parseEnvelopeText(text);
    return {
      envelope,
      fingerprint: fingerprintText(text),
      snapshot: decryptPortableProfileSnapshot(envelope, password)
    };
  }

  write(snapshot, password, options = {}) {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const releaseLock = acquireFileLockSync(this.filePath);
    try {
      const currentText = this.exists() ? fs.readFileSync(this.filePath, 'utf8') : null;
      const currentFingerprint = currentText === null ? null : fingerprintText(currentText);
      if (Object.prototype.hasOwnProperty.call(options, 'expectedFingerprint')) {
        const expectedFingerprint = options.expectedFingerprint;
        if (expectedFingerprint !== currentFingerprint) {
          throw new PortableProfileVaultConflictError(
            'Portable profile vault changed outside this VS Code window.'
          );
        }
      }

      const envelope = encryptPortableProfileSnapshot(snapshot, password, options.timestamp);
      writeJsonAtomicSync(this.filePath, envelope, { allowCopyFallback: true });
      const storedText = fs.readFileSync(this.filePath, 'utf8');
      return {
        path: this.filePath,
        fingerprint: fingerprintText(storedText),
        updatedAt: envelope.updatedAt,
        profileCount: envelope.profileCount
      };
    } finally {
      releaseLock();
    }
  }
}

module.exports = {
  MIN_PORTABLE_PROFILE_VAULT_PASSWORD_LENGTH,
  PORTABLE_PROFILE_VAULT_FILENAME,
  PORTABLE_PROFILE_VAULT_FORMAT,
  PORTABLE_PROFILE_VAULT_ITERATIONS,
  PORTABLE_PROFILE_VAULT_VERSION,
  PortableProfileVaultConflictError,
  PortableProfileVaultStore,
  decryptPortableProfileSnapshot,
  encryptPortableProfileSnapshot,
  fingerprintText,
  parseEnvelopeText
};
