'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const vscode = require('vscode');
const { randomUUID } = require('crypto');
const { getDefaultCodexAuthPath, loadAuthDataFromFile } = require('./authManager');
const { syncCodexAuthFile } = require('./codexAuthSync');
const {
  SHARED_ACTIVE_PROFILE_FILENAME,
  deleteFileIfExists,
  ensureSharedStoreDirs,
  getSharedActiveProfilePath,
  getSharedProfileSecretsPath,
  getSharedProfilesDir,
  getSharedProfilesPath,
  getSharedStoreRoot,
  readJsonFile,
  writeJsonFile
} = require('./sharedProfileStore');

const CURRENT_PROFILES_VERSION = 2;
const PROFILES_FILENAME = 'profiles.json';
const ACTIVE_PROFILE_KEY = 'codexSwitch.activeProfileId';
const ACTIVE_PROFILE_SET_AT_KEY = 'codexSwitch.activeProfileSetAt';
const LAST_PROFILE_KEY = 'codexSwitch.lastProfileId';

const OLD_ACTIVE_PROFILE_KEY = 'codexUsage.activeProfileId';
const OLD_LAST_PROFILE_KEY = 'codexUsage.lastProfileId';
const OLD_SECRET_PREFIX = 'codexUsage.profile.';
const NEW_SECRET_PREFIX = 'codexSwitch.profile.';

function asObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value;
}

function asOptionalString(value) {
  if (typeof value !== 'string') {
    return undefined;
  }

  const normalized = value.trim();
  return normalized ? normalized : undefined;
}

function asTimestamp(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return null;
  }
  return Math.round(numeric);
}

function clampPercent(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return 0;
  }
  return Math.max(0, Math.min(100, numeric));
}

function toIsoString(value, fallback) {
  if (!value) {
    return fallback;
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? fallback : date.toISOString();
}

function cloneJson(value) {
  if (value == null) {
    return undefined;
  }

  return JSON.parse(JSON.stringify(value));
}

function createComparableAuthSnapshot(authData) {
  if (!authData || typeof authData !== 'object') {
    return null;
  }

  return {
    idToken: asOptionalString(authData.idToken),
    accessToken: asOptionalString(authData.accessToken),
    refreshToken: asOptionalString(authData.refreshToken),
    accountId: asOptionalString(authData.accountId),
    defaultOrganizationId: asOptionalString(authData.defaultOrganizationId),
    defaultOrganizationTitle: asOptionalString(authData.defaultOrganizationTitle),
    chatgptUserId: asOptionalString(authData.chatgptUserId),
    userId: asOptionalString(authData.userId),
    subject: asOptionalString(authData.subject),
    email: asOptionalString(authData.email) || 'Unknown',
    planType: asOptionalString(authData.planType) || 'Unknown',
    authJson: cloneJson(authData.authJson)
  };
}

function normalizeRateLimitWindowState(value) {
  const state = asObject(value);
  if (!state) {
    return null;
  }

  return {
    usedPercent: clampPercent(state.usedPercent),
    resetAt: asTimestamp(state.resetAt),
    windowMinutes: Math.max(0, Math.round(Number(state.windowMinutes) || 0))
  };
}

function normalizeRateLimitState(value) {
  const state = asObject(value);
  if (!state) {
    return null;
  }

  const observedAt = asTimestamp(state.observedAt);
  const totalTokens = Number(state.totalTokens);
  const lastTokens = Number(state.lastTokens);

  return {
    observedAt,
    sourceFile: asOptionalString(state.sourceFile) || null,
    planType: asOptionalString(state.planType) || null,
    totalTokens: Number.isFinite(totalTokens) ? Math.round(totalTokens) : null,
    lastTokens: Number.isFinite(lastTokens) ? Math.round(lastTokens) : null,
    primary: normalizeRateLimitWindowState(state.primary),
    secondary: normalizeRateLimitWindowState(state.secondary)
  };
}

function normalizeProfileSummary(profile) {
  const source = asObject(profile) || {};
  const nowIso = new Date().toISOString();
  const createdAt = toIsoString(source.createdAt, nowIso);
  const updatedAt = toIsoString(source.updatedAt, createdAt);

  return {
    id: asOptionalString(source.id) || randomUUID(),
    name: asOptionalString(source.name) || 'profile',
    email: asOptionalString(source.email) || 'Unknown',
    planType: asOptionalString(source.planType) || 'Unknown',
    accountId: asOptionalString(source.accountId),
    defaultOrganizationId: asOptionalString(source.defaultOrganizationId),
    defaultOrganizationTitle: asOptionalString(source.defaultOrganizationTitle),
    chatgptUserId: asOptionalString(source.chatgptUserId),
    userId: asOptionalString(source.userId),
    subject: asOptionalString(source.subject),
    cooldownUntil: asTimestamp(source.cooldownUntil),
    rateLimitState: normalizeRateLimitState(source.rateLimitState),
    createdAt,
    updatedAt
  };
}

function normalizeProfilesFile(rawValue) {
  let parsed = rawValue;
  if (typeof rawValue === 'string') {
    parsed = JSON.parse(rawValue);
  }

  if (Array.isArray(parsed)) {
    return {
      version: CURRENT_PROFILES_VERSION,
      profiles: parsed.map((profile) => normalizeProfileSummary(profile))
    };
  }

  if (parsed && typeof parsed === 'object' && Array.isArray(parsed.profiles)) {
    return {
      version: CURRENT_PROFILES_VERSION,
      profiles: parsed.profiles.map((profile) => normalizeProfileSummary(profile))
    };
  }

  return {
    version: CURRENT_PROFILES_VERSION,
    profiles: []
  };
}

function serializeComparable(value) {
  return JSON.stringify(value == null ? null : value);
}

function getNowIso() {
  return new Date().toISOString();
}

class ProfileManager {
  constructor(context, logger) {
    this.context = context;
    this.logger = logger;
    this.lastSyncedProfileId = undefined;
    this.windowActiveProfileInitialized = false;
    this.windowActiveHasAuth = false;
    this.windowActiveProfileId = undefined;
    this.windowActiveProfileActivatedAt = undefined;
    this.onDidChangeEmitter = new vscode.EventEmitter();
    this.onDidChange = this.onDidChangeEmitter.event;
  }

  dispose() {
    this.onDidChangeEmitter.dispose();
  }

  emitChanged() {
    this.onDidChangeEmitter.fire();
  }

  log(level, message, data) {
    if (!this.logger || typeof this.logger[level] !== 'function') {
      return;
    }
    this.logger[level](message, data);
  }

  getConfiguredStorageMode() {
    const raw = vscode.workspace.getConfiguration('codexSwitch').get('storageMode', 'auto');
    if (raw === 'secretStorage' || raw === 'remoteFiles' || raw === 'auto') {
      return raw;
    }
    return 'auto';
  }

  getResolvedStorageMode() {
    const configured = this.getConfiguredStorageMode();
    if (configured === 'auto') {
      return vscode.env.remoteName === 'ssh-remote' ? 'remoteFiles' : 'secretStorage';
    }
    return configured;
  }

  isRemoteFilesMode() {
    return this.getResolvedStorageMode() === 'remoteFiles';
  }

  normalizeEmail(email) {
    return String(email || '').trim().toLowerCase();
  }

  normalizeIdentity(value) {
    return String(value || '').trim();
  }

  compareIdentityField(profileValue, authValue) {
    const normalizedProfile = this.normalizeIdentity(profileValue);
    const normalizedAuth = this.normalizeIdentity(authValue);
    if (!normalizedProfile || !normalizedAuth) {
      return undefined;
    }
    return normalizedProfile === normalizedAuth;
  }

  matchesAuth(profile, authData) {
    const hasProfileOrganizationId = Boolean(this.normalizeIdentity(profile.defaultOrganizationId));
    const hasAuthOrganizationId = Boolean(this.normalizeIdentity(authData.defaultOrganizationId));
    const organizationIdMatch = this.compareIdentityField(
      profile.defaultOrganizationId,
      authData.defaultOrganizationId
    );

    const identityMatches = [
      this.compareIdentityField(profile.chatgptUserId, authData.chatgptUserId),
      this.compareIdentityField(profile.userId, authData.userId),
      this.compareIdentityField(profile.subject, authData.subject)
    ].filter((value) => value !== undefined);

    if (identityMatches.length > 0) {
      if (identityMatches.some((value) => !value)) {
        return false;
      }
      if (hasProfileOrganizationId || hasAuthOrganizationId) {
        if (organizationIdMatch === undefined) {
          return false;
        }
        return organizationIdMatch;
      }
      return true;
    }

    const normalizedProfileEmail = this.normalizeEmail(profile.email);
    const normalizedAuthEmail = this.normalizeEmail(authData.email);
    const hasComparableEmail =
      Boolean(normalizedProfileEmail) &&
      Boolean(normalizedAuthEmail) &&
      normalizedProfileEmail !== 'unknown' &&
      normalizedAuthEmail !== 'unknown';
    const hasComparableAccountId = Boolean(authData.accountId) && Boolean(profile.accountId);
    const accountIdMatch = hasComparableAccountId
      ? authData.accountId === profile.accountId
      : false;
    const hasComparableOrganizationId = organizationIdMatch !== undefined;

    if ((hasProfileOrganizationId || hasAuthOrganizationId) && !hasComparableOrganizationId) {
      return false;
    }

    if (hasComparableEmail && hasComparableAccountId && hasComparableOrganizationId) {
      return normalizedProfileEmail === normalizedAuthEmail &&
        accountIdMatch &&
        organizationIdMatch === true;
    }

    if (hasComparableEmail && hasComparableOrganizationId) {
      return normalizedProfileEmail === normalizedAuthEmail && organizationIdMatch === true;
    }

    if (hasComparableEmail && hasComparableAccountId) {
      return normalizedProfileEmail === normalizedAuthEmail && accountIdMatch;
    }

    if (hasComparableAccountId && hasComparableOrganizationId) {
      return accountIdMatch && organizationIdMatch === true;
    }

    if (hasComparableEmail) {
      return normalizedProfileEmail === normalizedAuthEmail;
    }

    return false;
  }

  getStorageDir() {
    if (this.isRemoteFilesMode()) {
      return getSharedStoreRoot();
    }
    return this.context.globalStorageUri.fsPath;
  }

  getProfilesPath() {
    if (this.isRemoteFilesMode()) {
      return getSharedProfilesPath();
    }
    return path.join(this.getStorageDir(), PROFILES_FILENAME);
  }

  ensureStorageDir() {
    if (this.isRemoteFilesMode()) {
      ensureSharedStoreDirs();
      return;
    }

    const directory = this.getStorageDir();
    if (!fs.existsSync(directory)) {
      fs.mkdirSync(directory, { recursive: true });
    }
  }

  async readProfilesFile() {
    this.ensureStorageDir();
    const filePath = this.getProfilesPath();
    if (!fs.existsSync(filePath)) {
      return { version: CURRENT_PROFILES_VERSION, profiles: [] };
    }

    try {
      if (this.isRemoteFilesMode()) {
        const parsed = readJsonFile(filePath);
        if (parsed == null) {
          return { version: CURRENT_PROFILES_VERSION, profiles: [] };
        }
        return normalizeProfilesFile(parsed);
      }

      const raw = fs.readFileSync(filePath, 'utf8');
      return normalizeProfilesFile(raw);
    } catch (error) {
      this.log('warn', 'Failed to read profiles.json, falling back to an empty list.', {
        error: error && error.message ? error.message : String(error),
        filePath
      });
      return { version: CURRENT_PROFILES_VERSION, profiles: [] };
    }
  }

  writeProfilesFile(data) {
    this.ensureStorageDir();
    const normalized = normalizeProfilesFile(data);
    if (this.isRemoteFilesMode()) {
      writeJsonFile(this.getProfilesPath(), normalized);
      return;
    }

    fs.writeFileSync(this.getProfilesPath(), JSON.stringify(normalized, null, 2), {
      encoding: 'utf8'
    });
  }

  secretKey(profileId) {
    return `${NEW_SECRET_PREFIX}${profileId}`;
  }

  legacySecretKey(profileId) {
    return `${OLD_SECRET_PREFIX}${profileId}`;
  }

  readSharedActiveProfile() {
    if (!this.isRemoteFilesMode()) {
      return null;
    }
    return readJsonFile(getSharedActiveProfilePath());
  }

  writeSharedActiveProfile(profileId, updatedAt) {
    if (!this.isRemoteFilesMode()) {
      return;
    }

    writeJsonFile(getSharedActiveProfilePath(), {
      profileId,
      updatedAt: updatedAt || getNowIso()
    });
  }

  deleteSharedActiveProfile() {
    if (!this.isRemoteFilesMode()) {
      return;
    }
    deleteFileIfExists(getSharedActiveProfilePath());
  }

  readRemoteProfileTokens(profileId) {
    return readJsonFile(getSharedProfileSecretsPath(profileId));
  }

  async readStoredTokens(profileId) {
    if (this.isRemoteFilesMode()) {
      return this.readRemoteProfileTokens(profileId);
    }

    const raw =
      (await this.context.secrets.get(this.secretKey(profileId))) ||
      (await this.context.secrets.get(this.legacySecretKey(profileId)));
    if (!raw) {
      return null;
    }

    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  async writeStoredTokens(profileId, tokens) {
    if (this.isRemoteFilesMode()) {
      ensureSharedStoreDirs();
      writeJsonFile(getSharedProfileSecretsPath(profileId), tokens);
      return;
    }

    await this.context.secrets.store(this.secretKey(profileId), JSON.stringify(tokens));
  }

  async deleteStoredTokens(profileId) {
    if (this.isRemoteFilesMode()) {
      deleteFileIfExists(getSharedProfileSecretsPath(profileId));
      return;
    }

    await this.context.secrets.delete(this.secretKey(profileId));
    await this.context.secrets.delete(this.legacySecretKey(profileId));
  }

  getAuthFileModifiedAt() {
    const authPath = getDefaultCodexAuthPath(this.logger);
    try {
      const stats = fs.statSync(authPath);
      return Math.round(stats.mtimeMs);
    } catch {
      return undefined;
    }
  }

  async listProfiles() {
    await this.clearExpiredCooldowns();
    const file = await this.readProfilesFile();
    return [...file.profiles].sort((left, right) => left.name.localeCompare(right.name));
  }

  async getProfile(profileId) {
    const file = await this.readProfilesFile();
    return file.profiles.find((profile) => profile.id === profileId);
  }

  async exportProfilesForTransfer() {
    const profiles = await this.listProfiles();
    const activeProfileId = await this.getActiveProfileId();
    const lastProfileId = await this.getLastProfileId();
    const exportedProfiles = [];
    let skipped = 0;

    for (const profile of profiles) {
      const tokens = await this.readStoredTokens(profile.id);
      if (!tokens) {
        skipped += 1;
        continue;
      }
      exportedProfiles.push({ profile, tokens });
    }

    return {
      data: {
        format: 'codex-switch-profile-export',
        version: CURRENT_PROFILES_VERSION,
        exportedAt: getNowIso(),
        activeProfileId,
        lastProfileId,
        profiles: exportedProfiles
      },
      skipped
    };
  }

  parseImportEntry(value) {
    const entry = asObject(value);
    if (!entry) {
      return null;
    }

    const profile = asObject(entry.profile);
    const tokens = asObject(entry.tokens);
    if (!profile || !tokens) {
      return null;
    }

    const idToken = asOptionalString(tokens.idToken);
    const accessToken = asOptionalString(tokens.accessToken);
    const refreshToken = asOptionalString(tokens.refreshToken);
    if (!idToken || !accessToken || !refreshToken) {
      return null;
    }

    const email = asOptionalString(profile.email) || 'Unknown';
    const planType = asOptionalString(profile.planType) || 'Unknown';
    const name =
      asOptionalString(profile.name) ||
      (email !== 'Unknown' ? email.split('@')[0] : undefined) ||
      'profile';

    return {
      sourceProfileId: asOptionalString(profile.id),
      name,
      authData: {
        idToken,
        accessToken,
        refreshToken,
        accountId: asOptionalString(tokens.accountId) || asOptionalString(profile.accountId),
        defaultOrganizationId: asOptionalString(profile.defaultOrganizationId),
        defaultOrganizationTitle: asOptionalString(profile.defaultOrganizationTitle),
        chatgptUserId: asOptionalString(profile.chatgptUserId),
        userId: asOptionalString(profile.userId),
        subject: asOptionalString(profile.subject),
        email,
        planType,
        authJson: cloneJson(tokens.authJson)
      },
      importedMetadata: {
        cooldownUntil: asTimestamp(profile.cooldownUntil),
        rateLimitState: normalizeRateLimitState(profile.rateLimitState)
      }
    };
  }

  async importProfilesFromTransfer(value) {
    const payload = asObject(value);
    if (!payload) {
      throw new Error('Invalid settings file format.');
    }

    const format = asOptionalString(payload.format);
    if (format !== 'codex-switch-profile-export') {
      throw new Error('Unsupported settings file format.');
    }

    if (typeof payload.version !== 'number') {
      throw new Error('Unsupported settings export version.');
    }

    if (!Array.isArray(payload.profiles)) {
      throw new Error('Invalid settings file: profiles must be an array.');
    }

    const sourceToTargetId = new Map();
    let created = 0;
    let updated = 0;
    let skipped = 0;

    for (const rawEntry of payload.profiles) {
      const parsed = this.parseImportEntry(rawEntry);
      if (!parsed) {
        skipped += 1;
        continue;
      }

      const duplicate = await this.findDuplicateProfile(parsed.authData);
      if (duplicate) {
        await this.replaceProfileAuth(duplicate.id, parsed.authData);
        await this.applyImportedMetadata(duplicate.id, parsed.importedMetadata);
        if (parsed.sourceProfileId) {
          sourceToTargetId.set(parsed.sourceProfileId, duplicate.id);
        }
        updated += 1;
        continue;
      }

      const createdProfile = await this.createProfile(parsed.name, parsed.authData);
      await this.applyImportedMetadata(createdProfile.id, parsed.importedMetadata);
      if (parsed.sourceProfileId) {
        sourceToTargetId.set(parsed.sourceProfileId, createdProfile.id);
      }
      created += 1;
    }

    const importedActiveProfileId = asOptionalString(payload.activeProfileId);
    if (importedActiveProfileId) {
      const targetId = sourceToTargetId.get(importedActiveProfileId);
      if (targetId) {
        await this.setActiveProfileId(targetId);
      }
    }

    const importedLastProfileId = asOptionalString(payload.lastProfileId);
    if (importedLastProfileId) {
      const targetId = sourceToTargetId.get(importedLastProfileId);
      if (targetId) {
        await this.setLastProfileId(targetId);
      }
    }

    return { created, updated, skipped };
  }

  async applyImportedMetadata(profileId, metadata) {
    const file = await this.readProfilesFile();
    const index = file.profiles.findIndex((profile) => profile.id === profileId);
    if (index === -1) {
      return false;
    }

    const current = file.profiles[index];
    const next = normalizeProfileSummary({
      ...current,
      cooldownUntil:
        metadata && metadata.cooldownUntil != null ? metadata.cooldownUntil : current.cooldownUntil,
      rateLimitState:
        metadata && metadata.rateLimitState != null ? metadata.rateLimitState : current.rateLimitState,
      updatedAt: getNowIso()
    });

    if (serializeComparable(current) === serializeComparable(next)) {
      return false;
    }

    file.profiles[index] = next;
    this.writeProfilesFile(file);
    this.emitChanged();
    return true;
  }

  async findProfileMatchingAuthData(authData) {
    if (!authData) {
      return undefined;
    }

    const file = await this.readProfilesFile();
    return file.profiles.find((profile) => this.matchesAuth(profile, authData));
  }

  async getCurrentAuthProfileMatch() {
    const authData = await this.loadCurrentAuthData();
    if (!authData) {
      return {
        hasAuth: false,
        profileId: undefined
      };
    }

    const match = await this.findProfileMatchingAuthData(authData);
    return {
      hasAuth: true,
      profileId: match ? match.id : undefined
    };
  }

  async initializeWindowActiveProfileFromCurrentAuth(force = false) {
    if (this.windowActiveProfileInitialized && !force) {
      return {
        hasAuth: this.windowActiveHasAuth,
        profileId: this.windowActiveProfileId
      };
    }

    const authData = await this.loadCurrentAuthData();
    this.windowActiveProfileInitialized = true;

    if (!authData) {
      this.windowActiveHasAuth = false;
      this.windowActiveProfileId = undefined;
      this.windowActiveProfileActivatedAt = undefined;
      return {
        hasAuth: false,
        profileId: undefined
      };
    }

    const match = await this.findProfileMatchingAuthData(authData);
    this.windowActiveHasAuth = true;
    this.windowActiveProfileId = match ? match.id : undefined;
    this.windowActiveProfileActivatedAt = match
      ? this.getAuthFileModifiedAt() || Date.now()
      : undefined;
    if (match) {
      this.lastSyncedProfileId = match.id;
    }

    return {
      hasAuth: true,
      profileId: this.windowActiveProfileId
    };
  }

  async getWindowActiveProfileMatch() {
    return this.initializeWindowActiveProfileFromCurrentAuth();
  }

  async findDuplicateProfile(authData) {
    return this.findProfileMatchingAuthData(authData);
  }

  async loadCurrentAuthData() {
    return loadAuthDataFromFile(getDefaultCodexAuthPath(this.logger), this.logger);
  }

  async promptForMatchingAuthFile(profile) {
    const selection = await vscode.window.showOpenDialog({
      canSelectMany: false,
      openLabel: 'Select auth.json',
      filters: { JSON: ['json'] }
    });

    if (!selection || !selection.length) {
      return null;
    }

    const authData = await loadAuthDataFromFile(selection[0].fsPath, this.logger);
    if (!authData) {
      void vscode.window.showErrorMessage('Selected file is not a valid auth.json.');
      return null;
    }

    if (profile && !this.matchesAuth(profile, authData)) {
      void vscode.window.showErrorMessage(
        `Selected auth.json belongs to a different account and cannot restore profile "${profile.name}".`
      );
      return null;
    }

    return authData;
  }

  async recoverMissingTokens(profileId) {
    const profile = await this.getProfile(profileId);
    const recoverLabel = 'Recover from remote store';
    const importCurrentLabel = 'Restore from current ~/.codex/auth.json';
    const importFileLabel = 'Import matching auth.json file...';
    const deleteLabel = 'Delete broken profile';

    const canRecoverFromRemote =
      !this.isRemoteFilesMode() && this.readRemoteProfileTokens(profileId) != null;
    const currentAuthData = await this.loadCurrentAuthData();
    const canRestoreFromCurrentAuth = Boolean(
      profile && currentAuthData && this.matchesAuth(profile, currentAuthData)
    );

    const selection = await vscode.window.showWarningMessage(
      `Profile "${(profile && profile.name) || profileId}" is missing tokens. Restoring requires the matching auth.json for that same account.`,
      { modal: true },
      ...(canRecoverFromRemote ? [recoverLabel] : []),
      ...(canRestoreFromCurrentAuth ? [importCurrentLabel] : []),
      importFileLabel,
      deleteLabel
    );

    if (selection === recoverLabel) {
      const tokens = this.readRemoteProfileTokens(profileId);
      if (tokens) {
        await this.writeStoredTokens(profileId, tokens);
        return this.loadAuthData(profileId);
      }
    }

    if (selection === importCurrentLabel) {
      if (!currentAuthData) {
        void vscode.window.showErrorMessage(
          'Could not read the current ~/.codex/auth.json. Run "codex login" first.'
        );
        return null;
      }
      await this.replaceProfileAuth(profileId, currentAuthData);
      return currentAuthData;
    }

    if (selection === importFileLabel) {
      const authData = await this.promptForMatchingAuthFile(profile);
      if (!authData) {
        return null;
      }
      await this.replaceProfileAuth(profileId, authData);
      return authData;
    }

    if (selection === deleteLabel) {
      await this.deleteProfile(profileId);
    }

    return null;
  }

  async replaceProfileAuth(profileId, authData) {
    const file = await this.readProfilesFile();
    const index = file.profiles.findIndex((profile) => profile.id === profileId);
    if (index === -1) {
      return false;
    }

    const updatedProfile = normalizeProfileSummary({
      ...file.profiles[index],
      email: authData.email,
      planType: authData.planType,
      accountId: authData.accountId,
      defaultOrganizationId: authData.defaultOrganizationId,
      defaultOrganizationTitle: authData.defaultOrganizationTitle,
      chatgptUserId: authData.chatgptUserId,
      userId: authData.userId,
      subject: authData.subject,
      updatedAt: getNowIso()
    });

    file.profiles[index] = updatedProfile;
    this.writeProfilesFile(file);

    await this.writeStoredTokens(profileId, {
      idToken: authData.idToken,
      accessToken: authData.accessToken,
      refreshToken: authData.refreshToken,
      accountId: authData.accountId,
      authJson: cloneJson(authData.authJson)
    });

    this.emitChanged();
    return true;
  }

  async syncStoredProfileAuth(profileId, authData) {
    if (!profileId || !authData) {
      return false;
    }

    const storedAuthData = await this.loadAuthData(profileId);
    if (
      serializeComparable(createComparableAuthSnapshot(storedAuthData)) ===
      serializeComparable(createComparableAuthSnapshot(authData))
    ) {
      return false;
    }

    await this.replaceProfileAuth(profileId, authData);
    return true;
  }

  async syncCurrentAuthToMatchingProfile() {
    const authData = await this.loadCurrentAuthData();
    if (!authData) {
      return {
        hasAuth: false,
        profileId: undefined,
        updated: false
      };
    }

    const profile = await this.findProfileMatchingAuthData(authData);
    if (!profile) {
      return {
        hasAuth: true,
        profileId: undefined,
        updated: false
      };
    }

    const updated = await this.syncStoredProfileAuth(profile.id, authData);
    this.lastSyncedProfileId = profile.id;
    return {
      hasAuth: true,
      profileId: profile.id,
      updated
    };
  }

  async maybeSyncToCodexAuthFile(profileId) {
    if (!profileId) {
      return;
    }

    const profile = await this.getProfile(profileId);
    const currentAuthData = await this.loadCurrentAuthData();
    if (profile && currentAuthData && this.matchesAuth(profile, currentAuthData)) {
      await this.syncStoredProfileAuth(profileId, currentAuthData);
      this.lastSyncedProfileId = profileId;
      return;
    }

    if (this.lastSyncedProfileId === profileId) {
      return;
    }

    const authData = await this.loadAuthData(profileId);
    if (!authData) {
      return;
    }

    syncCodexAuthFile(getDefaultCodexAuthPath(this.logger), authData);
    this.lastSyncedProfileId = profileId;
  }

  async createProfile(name, authData) {
    const nowIso = getNowIso();
    const id = randomUUID();
    const profile = normalizeProfileSummary({
      id,
      name,
      email: authData.email,
      planType: authData.planType,
      accountId: authData.accountId,
      defaultOrganizationId: authData.defaultOrganizationId,
      defaultOrganizationTitle: authData.defaultOrganizationTitle,
      chatgptUserId: authData.chatgptUserId,
      userId: authData.userId,
      subject: authData.subject,
      cooldownUntil: null,
      rateLimitState: null,
      createdAt: nowIso,
      updatedAt: nowIso
    });

    const file = await this.readProfilesFile();
    file.profiles.push(profile);
    this.writeProfilesFile(file);

    await this.writeStoredTokens(id, {
      idToken: authData.idToken,
      accessToken: authData.accessToken,
      refreshToken: authData.refreshToken,
      accountId: authData.accountId,
      authJson: cloneJson(authData.authJson)
    });

    this.emitChanged();
    return profile;
  }

  async renameProfile(profileId, newName) {
    const file = await this.readProfilesFile();
    const index = file.profiles.findIndex((profile) => profile.id === profileId);
    if (index === -1) {
      return false;
    }

    file.profiles[index] = normalizeProfileSummary({
      ...file.profiles[index],
      name: newName,
      updatedAt: getNowIso()
    });
    this.writeProfilesFile(file);
    this.emitChanged();
    return true;
  }

  async deleteProfile(profileId) {
    const file = await this.readProfilesFile();
    const beforeCount = file.profiles.length;
    file.profiles = file.profiles.filter((profile) => profile.id !== profileId);
    if (file.profiles.length === beforeCount) {
      return false;
    }

    this.writeProfilesFile(file);
    await this.deleteStoredTokens(profileId);

    if (this.isRemoteFilesMode()) {
      const shared = this.readSharedActiveProfile();
      if (shared && shared.profileId === profileId) {
        this.deleteSharedActiveProfile();
      }
    } else {
      const bucket = this.getStateBucket();
      const activeProfileId = bucket.get(ACTIVE_PROFILE_KEY) || bucket.get(OLD_ACTIVE_PROFILE_KEY);
      if (activeProfileId === profileId) {
        await bucket.update(ACTIVE_PROFILE_KEY, undefined);
        await bucket.update(OLD_ACTIVE_PROFILE_KEY, undefined);
        await bucket.update(ACTIVE_PROFILE_SET_AT_KEY, undefined);
      }
    }

    const lastProfileId = await this.getLastProfileId();
    if (lastProfileId === profileId) {
      await this.setLastProfileId(undefined);
    }

    this.emitChanged();
    return true;
  }

  async loadAuthData(profileId) {
    const profile = await this.getProfile(profileId);
    if (!profile) {
      return null;
    }

    const tokens = await this.readStoredTokens(profileId);
    if (!tokens) {
      return null;
    }

    return {
      idToken: tokens.idToken,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      accountId: tokens.accountId || profile.accountId,
      defaultOrganizationId: profile.defaultOrganizationId,
      defaultOrganizationTitle: profile.defaultOrganizationTitle,
      chatgptUserId: profile.chatgptUserId,
      userId: profile.userId,
      subject: profile.subject,
      email: profile.email,
      planType: profile.planType,
      authJson: cloneJson(tokens.authJson)
    };
  }

  async hasStoredTokens(profileId) {
    const tokens = await this.readStoredTokens(profileId);
    return Boolean(tokens);
  }

  getStateBucket() {
    const scope = vscode.workspace
      .getConfiguration('codexSwitch')
      .get('activeProfileScope', 'global');
    return scope === 'workspace' ? this.context.workspaceState : this.context.globalState;
  }

  getLegacyStateBucket() {
    const scope = vscode.workspace
      .getConfiguration('codexUsage')
      .get('activeProfileScope', 'global');
    return scope === 'workspace' ? this.context.workspaceState : this.context.globalState;
  }

  async getActiveProfileId() {
    const windowActive = await this.getWindowActiveProfileMatch();
    return windowActive.profileId;
  }

  async getActiveProfileActivatedAt() {
    await this.getWindowActiveProfileMatch();
    return this.windowActiveProfileActivatedAt;
  }

  async setActiveProfileId(profileId) {
    const bucket = this.getStateBucket();
    const previous = await this.getActiveProfileId();

    let authData = null;
    let targetProfile = null;
    let currentAuthMatchesTarget = false;
    let activationTimestampMs = undefined;
    if (profileId) {
      targetProfile = await this.getProfile(profileId);
      if (!targetProfile) {
        return false;
      }

      authData = await this.loadAuthData(profileId);
      if (!authData) {
        authData = await this.recoverMissingTokens(profileId);
        if (!authData) {
          return false;
        }
      }

      if (previous === profileId) {
        activationTimestampMs = await this.getActiveProfileActivatedAt();
      }

      const currentAuthData = await loadAuthDataFromFile(
        getDefaultCodexAuthPath(this.logger),
        this.logger
      );
      currentAuthMatchesTarget = Boolean(
        currentAuthData && this.matchesAuth(targetProfile, currentAuthData)
      );

      if (!activationTimestampMs && currentAuthMatchesTarget) {
        activationTimestampMs = this.getAuthFileModifiedAt();
      }
    }

    if (previous && profileId && previous !== profileId) {
      await this.setLastProfileId(previous);
    }

    const switchedAtIso = getNowIso();
    const effectiveActivatedAt =
      profileId ? activationTimestampMs || Date.parse(switchedAtIso) : undefined;
    if (this.isRemoteFilesMode()) {
      if (profileId) {
        this.writeSharedActiveProfile(profileId, new Date(effectiveActivatedAt).toISOString());
      } else {
        this.deleteSharedActiveProfile();
      }
    } else {
      await bucket.update(ACTIVE_PROFILE_KEY, profileId);
      await bucket.update(OLD_ACTIVE_PROFILE_KEY, undefined);
      await bucket.update(ACTIVE_PROFILE_SET_AT_KEY, effectiveActivatedAt);
    }

    if (profileId && authData && !currentAuthMatchesTarget) {
      syncCodexAuthFile(getDefaultCodexAuthPath(this.logger), authData);
      this.lastSyncedProfileId = profileId;
    } else if (profileId) {
      this.lastSyncedProfileId = profileId;
    }

    this.windowActiveProfileInitialized = true;
    this.windowActiveHasAuth = Boolean(profileId);
    this.windowActiveProfileId = profileId || undefined;
    this.windowActiveProfileActivatedAt = effectiveActivatedAt;

    this.emitChanged();
    return true;
  }

  async getLastProfileId() {
    const bucket = this.getStateBucket();
    const current = bucket.get(LAST_PROFILE_KEY);
    if (current) {
      return current;
    }

    const legacyBucket = this.getLegacyStateBucket();
    const old = bucket.get(OLD_LAST_PROFILE_KEY) || legacyBucket.get(OLD_LAST_PROFILE_KEY);
    if (old) {
      await bucket.update(LAST_PROFILE_KEY, old);
      await bucket.update(OLD_LAST_PROFILE_KEY, undefined);
      await legacyBucket.update(OLD_LAST_PROFILE_KEY, undefined);
      return old;
    }

    return undefined;
  }

  async setLastProfileId(profileId) {
    const bucket = this.getStateBucket();
    await bucket.update(LAST_PROFILE_KEY, profileId);
    await bucket.update(OLD_LAST_PROFILE_KEY, undefined);
  }

  async toggleLastProfileId() {
    const activeProfileId = await this.getActiveProfileId();
    const lastProfileId = await this.getLastProfileId();
    if (!lastProfileId) {
      return undefined;
    }

    const switched = await this.setActiveProfileId(lastProfileId);
    if (switched && activeProfileId) {
      await this.setLastProfileId(activeProfileId);
    }
    return switched ? lastProfileId : undefined;
  }

  async syncActiveProfileToCodexAuthFile() {
    const activeProfileId = await this.getActiveProfileId();
    if (!activeProfileId) {
      return;
    }
    await this.maybeSyncToCodexAuthFile(activeProfileId);
  }

  async clearExpiredCooldowns() {
    const file = await this.readProfilesFile();
    const now = Date.now();
    let changed = false;

    const nextProfiles = file.profiles.map((profile) => {
      const currentRateLimitState = profile.rateLimitState || null;
      const nextRateLimitState = currentRateLimitState
        ? {
            ...currentRateLimitState,
            primary: currentRateLimitState.primary
              ? {
                  ...currentRateLimitState.primary,
                  resetAt:
                    currentRateLimitState.primary.resetAt &&
                    currentRateLimitState.primary.resetAt > now
                      ? currentRateLimitState.primary.resetAt
                      : null
                }
              : null,
            secondary: currentRateLimitState.secondary
              ? {
                  ...currentRateLimitState.secondary,
                  resetAt:
                    currentRateLimitState.secondary.resetAt &&
                    currentRateLimitState.secondary.resetAt > now
                      ? currentRateLimitState.secondary.resetAt
                      : null
                }
              : null
          }
        : null;

      const activeResetTimes = [nextRateLimitState && nextRateLimitState.primary, nextRateLimitState && nextRateLimitState.secondary]
        .filter((windowState) => Boolean(windowState && windowState.resetAt))
        .map((windowState) => windowState.resetAt);
      const nextCooldownUntil =
        activeResetTimes.length > 0 ? Math.max(...activeResetTimes) : null;

      if (
        profile.cooldownUntil !== nextCooldownUntil ||
        serializeComparable(profile.rateLimitState) !== serializeComparable(nextRateLimitState)
      ) {
        changed = true;
        return normalizeProfileSummary({
          ...profile,
          cooldownUntil: nextCooldownUntil,
          rateLimitState: nextRateLimitState,
          updatedAt: getNowIso()
        });
      }

      return profile;
    });

    if (!changed) {
      return false;
    }

    this.writeProfilesFile({
      version: CURRENT_PROFILES_VERSION,
      profiles: nextProfiles
    });
    this.emitChanged();
    return true;
  }

  async recordRateLimitObservation(profileId, observation) {
    const file = await this.readProfilesFile();
    const index = file.profiles.findIndex((profile) => profile.id === profileId);
    if (index === -1) {
      return false;
    }

    const profile = file.profiles[index];
    const now = Date.now();
    const primaryResetAt =
      observation &&
      observation.primary &&
      !observation.primary.outdated &&
      asTimestamp(observation.primary.resetAt);
    const secondaryResetAt =
      observation &&
      observation.secondary &&
      !observation.secondary.outdated &&
      asTimestamp(observation.secondary.resetAt);
    const cooldownUntil =
      [primaryResetAt, secondaryResetAt].filter((value) => Boolean(value && value > now)).sort((a, b) => b - a)[0] ||
      null;

    const rateLimitState = normalizeRateLimitState({
      observedAt: observation && observation.recordTimestampMs,
      sourceFile: observation && observation.filePath,
      planType: observation && observation.planType,
      totalTokens:
        observation && observation.totalUsage ? observation.totalUsage.total_tokens : null,
      lastTokens: observation && observation.lastUsage ? observation.lastUsage.total_tokens : null,
      primary: observation && observation.primary
        ? {
            usedPercent: observation.primary.usedPercent,
            resetAt: primaryResetAt,
            windowMinutes: observation.primary.windowMinutes
          }
        : null,
      secondary: observation && observation.secondary
        ? {
            usedPercent: observation.secondary.usedPercent,
            resetAt: secondaryResetAt,
            windowMinutes: observation.secondary.windowMinutes
          }
        : null
    });

    const nextProfile = normalizeProfileSummary({
      ...profile,
      planType: asOptionalString(observation && observation.planType) || profile.planType,
      cooldownUntil,
      rateLimitState,
      updatedAt: getNowIso()
    });

    if (serializeComparable(profile) === serializeComparable(nextProfile)) {
      return false;
    }

    file.profiles[index] = nextProfile;
    this.writeProfilesFile(file);
    this.emitChanged();
    return true;
  }

  createWatchers(onChanged) {
    const disposables = [];
    const fire = (source) => {
      try {
        onChanged({ source });
      } catch {
        // Ignore watcher refresh errors.
      }
    };

    const authDirectory = path.dirname(getDefaultCodexAuthPath(this.logger));
    if (fs.existsSync(authDirectory)) {
      const authWatcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(vscode.Uri.file(authDirectory), 'auth.json')
      );
      authWatcher.onDidCreate(() => fire('auth'));
      authWatcher.onDidChange(() => fire('auth'));
      authWatcher.onDidDelete(() => fire('auth'));
      disposables.push(authWatcher);
    }

    if (this.isRemoteFilesMode()) {
      const profilesWatcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(vscode.Uri.file(getSharedStoreRoot()), PROFILES_FILENAME)
      );
      profilesWatcher.onDidCreate(() => fire('profiles'));
      profilesWatcher.onDidChange(() => fire('profiles'));
      profilesWatcher.onDidDelete(() => fire('profiles'));
      disposables.push(profilesWatcher);

      const activeWatcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(
          vscode.Uri.file(getSharedStoreRoot()),
          SHARED_ACTIVE_PROFILE_FILENAME
        )
      );
      activeWatcher.onDidCreate(() => fire('active'));
      activeWatcher.onDidChange(() => fire('active'));
      activeWatcher.onDidDelete(() => fire('active'));
      disposables.push(activeWatcher);

      const tokenWatcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(vscode.Uri.file(getSharedProfilesDir()), '*.json')
      );
      tokenWatcher.onDidCreate(() => fire('tokens'));
      tokenWatcher.onDidChange(() => fire('tokens'));
      tokenWatcher.onDidDelete(() => fire('tokens'));
      disposables.push(tokenWatcher);
    }

    return disposables;
  }
}

module.exports = {
  ProfileManager
};
