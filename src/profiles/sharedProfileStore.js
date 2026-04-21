'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const SHARED_STORE_DIRNAME = '.codex-switch';
const SHARED_PROFILES_DIRNAME = 'profiles';
const SHARED_PROFILES_FILENAME = 'profiles.json';
const SHARED_ACTIVE_PROFILE_FILENAME = 'active-profile.json';

function getSharedStoreRoot() {
  return path.join(os.homedir(), SHARED_STORE_DIRNAME);
}

function getSharedProfilesDir() {
  return path.join(getSharedStoreRoot(), SHARED_PROFILES_DIRNAME);
}

function getSharedProfilesPath() {
  return path.join(getSharedStoreRoot(), SHARED_PROFILES_FILENAME);
}

function getSharedActiveProfilePath() {
  return path.join(getSharedStoreRoot(), SHARED_ACTIVE_PROFILE_FILENAME);
}

function getSharedProfileSecretsPath(profileId) {
  return path.join(getSharedProfilesDir(), `${profileId}.json`);
}

function ensureSharedStoreDirs() {
  fs.mkdirSync(getSharedStoreRoot(), { recursive: true, mode: 0o700 });
  fs.mkdirSync(getSharedProfilesDir(), { recursive: true, mode: 0o700 });
}

function readJsonFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) {
      return null;
    }
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function writeJsonFile(filePath, data) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), {
    encoding: 'utf8',
    mode: 0o600
  });
}

function deleteFileIfExists(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch {
    // Ignore cleanup failures.
  }
}

module.exports = {
  SHARED_ACTIVE_PROFILE_FILENAME,
  SHARED_PROFILES_FILENAME,
  deleteFileIfExists,
  ensureSharedStoreDirs,
  getSharedActiveProfilePath,
  getSharedProfileSecretsPath,
  getSharedProfilesDir,
  getSharedProfilesPath,
  getSharedStoreRoot,
  readJsonFile,
  writeJsonFile
};
