'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const SHARED_STORE_DIRNAME = '.codex-switch';
const SHARED_PROFILES_DIRNAME = 'profiles';
const SHARED_PROFILES_FILENAME = 'profiles.json';

function getSharedStoreRoot() {
  return path.join(os.homedir(), SHARED_STORE_DIRNAME);
}

function getSharedProfilesDir() {
  return path.join(getSharedStoreRoot(), SHARED_PROFILES_DIRNAME);
}

function getSharedProfilesPath() {
  return path.join(getSharedStoreRoot(), SHARED_PROFILES_FILENAME);
}

function getSharedProfileSecretsPath(profileId) {
  return path.join(getSharedProfilesDir(), `${profileId}.json`);
}

function ensureSharedStoreDirs() {
  fs.mkdirSync(getSharedStoreRoot(), { recursive: true, mode: 0o700 });
  fs.mkdirSync(getSharedProfilesDir(), { recursive: true, mode: 0o700 });
}

function readJsonFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }

  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
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
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

module.exports = {
  SHARED_PROFILES_FILENAME,
  deleteFileIfExists,
  ensureSharedStoreDirs,
  getSharedProfileSecretsPath,
  getSharedProfilesDir,
  getSharedProfilesPath,
  getSharedStoreRoot,
  readJsonFile,
  writeJsonFile
};
