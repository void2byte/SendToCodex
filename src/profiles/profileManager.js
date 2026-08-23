'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const vscode = require('vscode');
const { randomUUID } = require('crypto');
const { getDefaultCodexAuthPath, loadAuthDataFromFile } = require('./authManager');
const {
  mutateJsonFileSync,
  readJsonFileSync,
  writeJsonAtomicSync
} = require('./atomicJsonStore');
const { syncCodexAuthFile } = require('./codexAuthSync');
const { displayProfileName } = require('./privacy');
const { ProfileBackupStore } = require('./profileBackupStore');
const {
  PORTABLE_PROFILE_VAULT_FILENAME,
  PortableProfileVaultConflictError,
  PortableProfileVaultStore
} = require('./portableProfileVaultStore');
const { RateLimitRefreshCoordinator } = require('./rateLimitRefreshCoordinator');
const { generateTotpCode, normalizeTotpConfiguration } = require('./totp');
const { compareDisplayText } = require('../ui/userFormatting');
const {
  deleteFileIfExists,
  ensureSharedStoreDirs,
  getSharedProfileSecretsPath,
  getSharedProfilesDir,
  getSharedProfilesPath,
  getSharedStoreRoot,
  readJsonFile,
  writeJsonFile
} = require('./sharedProfileStore');

const CURRENT_PROFILES_VERSION = 2;
const PROFILES_FILENAME = 'profiles.json';
const PROFILES_BACKUP_FILENAME = 'profiles.json.backup';
const ACTIVE_WINDOW_USAGES_FILENAME = 'active-window-usages.json';
const AUTH_BACKUPS_DIRNAME = 'auth-backups';
const ACTIVITY_LOG_FILENAME = 'profile-activity.jsonl';
const ACTIVE_PROFILE_KEY = 'codexSwitch.activeProfileId';
const ACTIVE_PROFILE_SET_AT_KEY = 'codexSwitch.activeProfileSetAt';
const LAST_PROFILE_KEY = 'codexSwitch.lastProfileId';
const PORTABLE_PROFILE_VAULT_ENABLED_KEY = 'codexSwitch.portableProfileVault.enabled';
const PORTABLE_PROFILE_VAULT_FINGERPRINT_KEY =
  'codexSwitch.portableProfileVault.fingerprint';
const PORTABLE_PROFILE_VAULT_PASSWORD_SECRET =
  'codexSwitch.portableProfileVault.password';

const OLD_SECRET_PREFIX = 'codexUsage.profile.';
const NEW_SECRET_PREFIX = 'codexSwitch.profile.';
const PRIVATE_NOTE_SECRET_PREFIX = 'codexSwitch.profileNote.';
const PRIVATE_TOTP_SECRET_PREFIX = 'codexSwitch.profileTotp.';
const MAX_PRIVATE_NOTE_LENGTH = 256 * 1024;
const AUTH_BACKUP_RETENTION_DAYS = 7;
const AUTH_BACKUPS_PER_DAY = 2;
const MAX_AUTH_BACKUPS = AUTH_BACKUP_RETENTION_DAYS * AUTH_BACKUPS_PER_DAY;
const ACTIVE_WINDOW_USAGE_STALE_MS = 2 * 60 * 1000;
const UNEXPECTED_RESET_MIN_USAGE_DROP_PERCENT = 5;
const UNEXPECTED_RESET_SCHEDULE_GRACE_MS = 60 * 1000;
const EXACT_RATE_LIMIT_SOURCE_PREFIXES = [
  'https://chatgpt.com/backend-api/wham/usage',
  'codex-app-server://account/rateLimits/read'
];
const CHANGE_BACKUP_MIN_INTERVAL_MS = 5 * 1000;

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

function normalizeProfileGroup(value) {
  return asOptionalString(value) || 'Ungrouped';
}

function isPaidPlanType(value) {
  const planType = String(value || '').trim().toLowerCase();
  return Boolean(planType && planType !== 'unknown' && !planType.includes('free'));
}

function normalizeWindowUsageWorkspaceLabel(value) {
  return String(value || '')
    .trim()
    .replace(/\s*\(Workspace\)\s*$/i, '')
    .trim() || 'VS Code window';
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

  const unexpectedResetCount = Number(state.unexpectedResetCount);

  return {
    usedPercent: clampPercent(state.usedPercent),
    resetAt: asTimestamp(state.resetAt),
    windowMinutes: Math.max(0, Math.round(Number(state.windowMinutes) || 0)),
    unexpectedResetCount:
      Number.isFinite(unexpectedResetCount) && unexpectedResetCount > 0
        ? Math.round(unexpectedResetCount)
        : 0,
    lastUnexpectedResetAt: asTimestamp(state.lastUnexpectedResetAt)
  };
}

function getExhaustedCooldownUntil(windows, now = Date.now()) {
  const resetTimes = (windows || [])
    .filter((windowState) => {
      return Boolean(
        windowState &&
        clampPercent(windowState.usedPercent) >= 100 &&
        asTimestamp(windowState.resetAt) > now
      );
    })
    .map((windowState) => asTimestamp(windowState.resetAt));
  return resetTimes.length > 0 ? Math.max(...resetTimes) : null;
}

function isExactRateLimitSource(value) {
  const source = String(value || '');
  return EXACT_RATE_LIMIT_SOURCE_PREFIXES.some((prefix) => source.startsWith(prefix));
}

function isSameRateLimitWindow(previousWindow, nextWindow) {
  if (!previousWindow || !nextWindow) {
    return false;
  }

  const previousMinutes = Number(previousWindow.windowMinutes);
  const nextMinutes = Number(nextWindow.windowMinutes);
  if (previousMinutes > 0 && nextMinutes > 0) {
    return Math.abs(previousMinutes - nextMinutes) <= 1;
  }

  return previousMinutes === nextMinutes;
}

function isUnexpectedRateLimitReset(
  previousState,
  nextState,
  windowName,
  observationTimestamp
) {
  if (
    !previousState ||
    !nextState ||
    !isExactRateLimitSource(previousState.sourceFile) ||
    !isExactRateLimitSource(nextState.sourceFile)
  ) {
    return false;
  }

  const previousWindow = previousState[windowName];
  const nextWindow = nextState[windowName];
  if (!isSameRateLimitWindow(previousWindow, nextWindow)) {
    return false;
  }

  const previousResetAt = asTimestamp(previousWindow.resetAt);
  const detectedAt = asTimestamp(observationTimestamp);
  if (
    !previousResetAt ||
    !detectedAt ||
    detectedAt + UNEXPECTED_RESET_SCHEDULE_GRACE_MS >= previousResetAt
  ) {
    return false;
  }

  const usageDrop =
    clampPercent(previousWindow.usedPercent) - clampPercent(nextWindow.usedPercent);
  return usageDrop >= UNEXPECTED_RESET_MIN_USAGE_DROP_PERCENT;
}

function preserveUnexpectedResetMetadata(
  previousState,
  nextState,
  windowName,
  observationTimestamp
) {
  const nextWindow = nextState && nextState[windowName];
  if (!nextWindow) {
    return {
      windowState: null,
      unexpectedResetDetected: false
    };
  }

  const previousWindow = previousState && previousState[windowName];
  const unexpectedResetDetected = isUnexpectedRateLimitReset(
    previousState,
    nextState,
    windowName,
    observationTimestamp
  );
  const previousResetCount = Math.max(
    0,
    Math.round(Number(previousWindow && previousWindow.unexpectedResetCount) || 0)
  );

  return {
    windowState: {
      ...nextWindow,
      unexpectedResetCount: previousResetCount + (unexpectedResetDetected ? 1 : 0),
      lastUnexpectedResetAt: unexpectedResetDetected
        ? observationTimestamp
        : asTimestamp(previousWindow && previousWindow.lastUnexpectedResetAt)
    },
    unexpectedResetDetected
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
    assumedResetAt: asTimestamp(state.assumedResetAt),
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
    group: normalizeProfileGroup(source.group),
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

  if (
    !parsed ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    parsed.version !== CURRENT_PROFILES_VERSION ||
    !Array.isArray(parsed.profiles)
  ) {
    throw new Error(`profiles.json must use version ${CURRENT_PROFILES_VERSION} with a profiles array.`);
  }

  const profileIds = new Set();
  const profiles = parsed.profiles.map((profile, index) => {
    const source = asObject(profile);
    const profileId = source && asOptionalString(source.id);
    if (!profileId) {
      throw new Error(`profiles.json profile at index ${index} has no id.`);
    }
    if (profileIds.has(profileId)) {
      throw new Error(`profiles.json contains duplicate profile id ${profileId}.`);
    }
    profileIds.add(profileId);
    return normalizeProfileSummary(source);
  });
  return {
    version: CURRENT_PROFILES_VERSION,
    profiles
  };
}

function normalizeActiveWindowUsageFile(rawValue, now = Date.now()) {
  let parsed = rawValue;
  if (typeof rawValue === 'string') {
    parsed = JSON.parse(rawValue);
  }

  const sourceWindows =
    parsed && typeof parsed === 'object' && Array.isArray(parsed.windows)
      ? parsed.windows
      : [];
  const windows = sourceWindows
    .map((entry) => {
      const source = asObject(entry) || {};
      const updatedAt = asTimestamp(source.updatedAt);
      return {
        windowId: asOptionalString(source.windowId),
        profileId: asOptionalString(source.profileId),
        workspaceLabel: normalizeWindowUsageWorkspaceLabel(source.workspaceLabel),
        pid: Number.isFinite(Number(source.pid)) ? Number(source.pid) : null,
        updatedAt
      };
    })
    .filter((entry) => {
      return Boolean(
        entry.windowId &&
          entry.profileId &&
          entry.updatedAt &&
          now - entry.updatedAt <= ACTIVE_WINDOW_USAGE_STALE_MS
      );
    });

  return {
    version: 1,
    windows
  };
}

function serializeComparable(value) {
  return JSON.stringify(value == null ? null : value);
}

function getNowIso() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sanitizePathPart(value) {
  return String(value || 'item')
    .trim()
    .replace(/[^a-zA-Z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'item';
}

function getTimestampFilePart() {
  return new Date().toISOString().replace(/[:.]/g, '-');
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
    this.notifiedProfilesReadError = false;
    this.profileRestorePromptPromise = null;
    this.profileBackupPromise = null;
    this.profileBackupTimer = null;
    this.pendingProfileBackupReason = null;
    this.lastScheduledProfileBackupAt = 0;
    this.portableProfileVaultWatcher = null;
    this.portableProfileVaultWatchTimer = null;
    this.portableProfileVaultLastError = null;
    this.windowUsageId = randomUUID();
    this.rateLimitRefreshCoordinator = new RateLimitRefreshCoordinator(
      () => this.getStorageDir(),
      this.windowUsageId,
      logger
    );
    this.onDidChangeEmitter = new vscode.EventEmitter();
    this.onDidChange = this.onDidChangeEmitter.event;
  }

  dispose() {
    if (this.profileBackupTimer) {
      clearTimeout(this.profileBackupTimer);
      this.profileBackupTimer = null;
    }
    if (this.portableProfileVaultWatchTimer) {
      clearTimeout(this.portableProfileVaultWatchTimer);
      this.portableProfileVaultWatchTimer = null;
    }
    if (this.portableProfileVaultWatcher) {
      this.portableProfileVaultWatcher.close();
      this.portableProfileVaultWatcher = null;
    }
    this.clearActiveWindowProfileUsage();
    this.onDidChangeEmitter.dispose();
  }

  emitChanged(backupReason = 'profile-change') {
    this.onDidChangeEmitter.fire();
    if (backupReason) {
      this.queueProfileBackup(backupReason);
    }
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

  getProfilesBackupPath() {
    return path.join(this.getStorageDir(), PROFILES_BACKUP_FILENAME);
  }

  getProfileBackupStore() {
    return new ProfileBackupStore(this.getStorageDir(), this.context.secrets);
  }

  getProfileBackupsDir() {
    return this.getProfileBackupStore().getDirectory();
  }

  getPortableProfileVaultPath() {
    return path.join(this.context.globalStorageUri.fsPath, PORTABLE_PROFILE_VAULT_FILENAME);
  }

  getPortableProfileVaultStore() {
    return new PortableProfileVaultStore(this.getPortableProfileVaultPath());
  }

  isPortableProfileVaultEnabled() {
    return this.context.globalState.get(PORTABLE_PROFILE_VAULT_ENABLED_KEY) === true;
  }

  notifyPortableProfileVaultChanged() {
    this.onDidChangeEmitter.fire();
  }

  async initializePortableProfileVault() {
    const storageDirectory = this.context.globalStorageUri.fsPath;
    fs.mkdirSync(storageDirectory, { recursive: true, mode: 0o700 });
    if (!this.portableProfileVaultWatcher) {
      this.portableProfileVaultWatcher = fs.watch(
        storageDirectory,
        { persistent: false },
        (_eventType, filename) => {
          if (String(filename || '') !== PORTABLE_PROFILE_VAULT_FILENAME) {
            return;
          }
          if (this.portableProfileVaultWatchTimer) {
            clearTimeout(this.portableProfileVaultWatchTimer);
          }
          this.portableProfileVaultWatchTimer = setTimeout(() => {
            this.portableProfileVaultWatchTimer = null;
            this.notifyPortableProfileVaultChanged();
          }, 100);
          if (typeof this.portableProfileVaultWatchTimer.unref === 'function') {
            this.portableProfileVaultWatchTimer.unref();
          }
        }
      );
    }

    const store = this.getPortableProfileVaultStore();
    if (this.isPortableProfileVaultEnabled() && !store.exists()) {
      await this.syncPortableProfileVault('startup-missing-file');
    }
    return this.getPortableProfileVaultStatus();
  }

  async getPortableProfileVaultStatus() {
    const store = this.getPortableProfileVaultStore();
    const inspection = store.inspect();
    const enabled = this.isPortableProfileVaultEnabled();
    const password = enabled
      ? await this.context.secrets.get(PORTABLE_PROFILE_VAULT_PASSWORD_SECRET)
      : undefined;
    const recordedFingerprint = this.context.globalState.get(
      PORTABLE_PROFILE_VAULT_FINGERPRINT_KEY
    );

    let state = 'missing';
    if (inspection.exists && !inspection.valid) {
      state = 'invalid';
    } else if (!inspection.exists) {
      state = enabled ? (password ? 'missing' : 'locked') : 'missing';
    } else if (!enabled) {
      state = 'available';
    } else if (!password) {
      state = 'locked';
    } else if (!recordedFingerprint || recordedFingerprint !== inspection.fingerprint) {
      state = 'conflict';
    } else if (this.portableProfileVaultLastError) {
      state = 'error';
    } else {
      state = 'synced';
    }

    return {
      path: inspection.path,
      exists: inspection.exists,
      valid: inspection.valid,
      enabled,
      unlocked: Boolean(password),
      state,
      updatedAt: inspection.updatedAt,
      profileCount: inspection.profileCount,
      error: inspection.error || this.portableProfileVaultLastError
    };
  }

  async captureFullProfileSnapshot() {
    const profilesFile = await this.readProfilesFile({ offerRestore: false });
    const secrets = [];
    for (const profile of profilesFile.profiles) {
      const [tokens, privateNote, totp] = await Promise.all([
        this.readStoredTokens(profile.id),
        this.readProfilePrivateNote(profile.id),
        this.readProfileTotpConfiguration(profile.id)
      ]);
      secrets.push({
        profileId: profile.id,
        tokens: tokens || null,
        privateNote: privateNote || null,
        totp: totp || null
      });
    }

    const bucket = this.getStateBucket();
    return {
      profilesFile,
      activeProfileId: asOptionalString(bucket.get(ACTIVE_PROFILE_KEY)) || null,
      lastProfileId: asOptionalString(bucket.get(LAST_PROFILE_KEY)) || null,
      secrets
    };
  }

  async rememberPortableProfileVaultWrite(result) {
    await this.context.globalState.update(
      PORTABLE_PROFILE_VAULT_FINGERPRINT_KEY,
      result.fingerprint
    );
    this.portableProfileVaultLastError = null;
    this.notifyPortableProfileVaultChanged();
    return result;
  }

  async writePortableProfileVault(snapshot, password, expectedFingerprint) {
    const result = this.getPortableProfileVaultStore().write(snapshot, password, {
      expectedFingerprint
    });
    return this.rememberPortableProfileVaultWrite(result);
  }

  async syncPortableProfileVault(reason = 'manual', options = {}) {
    if (!this.isPortableProfileVaultEnabled()) {
      return { synced: false, state: 'disabled' };
    }

    const password = await this.context.secrets.get(
      PORTABLE_PROFILE_VAULT_PASSWORD_SECRET
    );
    if (!password) {
      this.portableProfileVaultLastError =
        'Automatic profile vault sync is locked until its password is entered.';
      this.notifyPortableProfileVaultChanged();
      return { synced: false, state: 'locked' };
    }

    const store = this.getPortableProfileVaultStore();
    const inspection = store.inspect();
    const recordedFingerprint = this.context.globalState.get(
      PORTABLE_PROFILE_VAULT_FINGERPRINT_KEY
    );
    try {
      let expectedFingerprint = null;
      if (inspection.exists) {
        if (!inspection.valid) {
          throw new Error(inspection.error || 'Portable profile vault is invalid.');
        }
        if (!recordedFingerprint || recordedFingerprint !== inspection.fingerprint) {
          throw new PortableProfileVaultConflictError(
            'Portable profile vault changed outside this VS Code window. Import it before resuming automatic sync.'
          );
        }
        store.read(password);
        expectedFingerprint = inspection.fingerprint;
      }

      const snapshot = options.snapshot || (await this.captureFullProfileSnapshot());
      const result = await this.writePortableProfileVault(
        snapshot,
        password,
        expectedFingerprint
      );
      this.log('info', 'Synchronized the portable Codex profile vault.', {
        reason,
        vaultPath: result.path,
        profileCount: result.profileCount
      });
      return { ...result, synced: true, state: 'synced' };
    } catch (error) {
      this.portableProfileVaultLastError =
        error && error.message ? error.message : String(error);
      this.log('warn', 'Could not synchronize the portable Codex profile vault.', {
        reason,
        error: this.portableProfileVaultLastError
      });
      this.notifyPortableProfileVaultChanged();
      return {
        synced: false,
        state:
          error instanceof PortableProfileVaultConflictError ? 'conflict' : 'error',
        error: this.portableProfileVaultLastError
      };
    }
  }

  async enablePortableProfileVault(password) {
    const store = this.getPortableProfileVaultStore();
    if (store.exists()) {
      throw new Error(
        'A portable profile vault already exists. Import it before enabling automatic sync.'
      );
    }
    const snapshot = await this.captureFullProfileSnapshot();
    const result = store.write(snapshot, password, { expectedFingerprint: null });
    await this.context.secrets.store(PORTABLE_PROFILE_VAULT_PASSWORD_SECRET, password);
    await this.context.globalState.update(PORTABLE_PROFILE_VAULT_ENABLED_KEY, true);
    await this.rememberPortableProfileVaultWrite(result);
    return result;
  }

  async disablePortableProfileVault() {
    await this.context.globalState.update(PORTABLE_PROFILE_VAULT_ENABLED_KEY, false);
    await this.context.globalState.update(PORTABLE_PROFILE_VAULT_FINGERPRINT_KEY, undefined);
    await this.context.secrets.delete(PORTABLE_PROFILE_VAULT_PASSWORD_SECRET);
    this.portableProfileVaultLastError = null;
    this.notifyPortableProfileVaultChanged();
  }

  async changePortableProfileVaultPassword(password) {
    const currentPassword = await this.context.secrets.get(
      PORTABLE_PROFILE_VAULT_PASSWORD_SECRET
    );
    if (!currentPassword) {
      throw new Error('The current portable profile vault password is not available.');
    }
    const store = this.getPortableProfileVaultStore();
    const opened = store.read(currentPassword);
    const recordedFingerprint = this.context.globalState.get(
      PORTABLE_PROFILE_VAULT_FINGERPRINT_KEY
    );
    if (!recordedFingerprint || recordedFingerprint !== opened.fingerprint) {
      throw new PortableProfileVaultConflictError(
        'Portable profile vault changed outside this VS Code window. Import it before changing the password.'
      );
    }
    const snapshot = await this.captureFullProfileSnapshot();
    const result = store.write(snapshot, password, {
      expectedFingerprint: opened.fingerprint
    });
    await this.context.secrets.store(PORTABLE_PROFILE_VAULT_PASSWORD_SECRET, password);
    return this.rememberPortableProfileVaultWrite(result);
  }

  normalizePortableProfileSnapshot(value) {
    const snapshot = asObject(value);
    if (!snapshot || !Array.isArray(snapshot.secrets)) {
      throw new Error('Portable profile vault snapshot is incomplete.');
    }
    return {
      profilesFile: normalizeProfilesFile(snapshot.profilesFile),
      activeProfileId: asOptionalString(snapshot.activeProfileId) || null,
      lastProfileId: asOptionalString(snapshot.lastProfileId) || null,
      secrets: snapshot.secrets
    };
  }

  async mergePortableProfileSnapshot(value) {
    const snapshot = this.normalizePortableProfileSnapshot(value);
    await this.createProtectiveProfileBackup('before-portable-vault-import');

    const secretByProfileId = new Map();
    for (const rawSecret of snapshot.secrets) {
      const entry = asObject(rawSecret);
      const profileId = entry && asOptionalString(entry.profileId);
      if (profileId) {
        secretByProfileId.set(profileId, entry);
      }
    }

    const sourceToTargetId = new Map();
    const secretImports = [];
    let created = 0;
    let updated = 0;

    this.mutateProfilesFile((file) => {
      const usedIds = new Set(file.profiles.map((profile) => profile.id));
      for (const sourceProfile of snapshot.profilesFile.profiles) {
        const sourceProfileId = sourceProfile.id;
        const sourceSecret = secretByProfileId.get(sourceProfileId) || {};
        const tokens = asObject(sourceSecret.tokens);
        const identity = {
          email: sourceProfile.email,
          accountId:
            (tokens && asOptionalString(tokens.accountId)) || sourceProfile.accountId,
          defaultOrganizationId: sourceProfile.defaultOrganizationId,
          chatgptUserId: sourceProfile.chatgptUserId,
          userId: sourceProfile.userId,
          subject: sourceProfile.subject
        };
        let targetProfile = file.profiles.find(
          (profile) => profile.id === sourceProfileId
        );
        if (!targetProfile) {
          targetProfile = file.profiles.find((profile) => this.matchesAuth(profile, identity));
        }

        let targetProfileId;
        if (targetProfile) {
          targetProfileId = targetProfile.id;
          const targetIndex = file.profiles.findIndex(
            (profile) => profile.id === targetProfileId
          );
          file.profiles[targetIndex] = normalizeProfileSummary({
            ...targetProfile,
            ...sourceProfile,
            id: targetProfileId,
            createdAt: targetProfile.createdAt || sourceProfile.createdAt
          });
          updated += 1;
        } else {
          targetProfileId = usedIds.has(sourceProfileId) ? randomUUID() : sourceProfileId;
          usedIds.add(targetProfileId);
          file.profiles.push(
            normalizeProfileSummary({
              ...sourceProfile,
              id: targetProfileId
            })
          );
          created += 1;
        }

        sourceToTargetId.set(sourceProfileId, targetProfileId);
        secretImports.push({ targetProfileId, sourceSecret });
      }
      return file;
    });

    for (const { targetProfileId, sourceSecret } of secretImports) {
      const tokens = asObject(sourceSecret.tokens);
      if (
        tokens &&
        asOptionalString(tokens.idToken) &&
        asOptionalString(tokens.accessToken) &&
        asOptionalString(tokens.refreshToken)
      ) {
        await this.writeStoredTokens(targetProfileId, cloneJson(tokens));
      }

      if (typeof sourceSecret.privateNote === 'string' && sourceSecret.privateNote) {
        await this.context.secrets.store(
          this.privateNoteSecretKey(targetProfileId),
          sourceSecret.privateNote
        );
      }

      const importedTotp = asObject(sourceSecret.totp);
      if (importedTotp && asOptionalString(importedTotp.secret)) {
        const base = normalizeTotpConfiguration(importedTotp.secret);
        const configuration = {
          ...base,
          algorithm: importedTotp.algorithm || base.algorithm,
          digits: importedTotp.digits || base.digits,
          period: importedTotp.period || base.period,
          issuer: importedTotp.issuer || '',
          account: importedTotp.account || ''
        };
        generateTotpCode(configuration, 0);
        await this.context.secrets.store(
          this.privateTotpSecretKey(targetProfileId),
          JSON.stringify(configuration)
        );
      }
    }

    const bucket = this.getStateBucket();
    if (!asOptionalString(bucket.get(ACTIVE_PROFILE_KEY)) && snapshot.activeProfileId) {
      const importedActiveProfileId = sourceToTargetId.get(snapshot.activeProfileId);
      if (importedActiveProfileId) {
        await bucket.update(ACTIVE_PROFILE_KEY, importedActiveProfileId);
      }
    }
    if (!asOptionalString(bucket.get(LAST_PROFILE_KEY)) && snapshot.lastProfileId) {
      const importedLastProfileId = sourceToTargetId.get(snapshot.lastProfileId);
      if (importedLastProfileId) {
        await bucket.update(LAST_PROFILE_KEY, importedLastProfileId);
      }
    }

    this.windowActiveProfileInitialized = false;
    this.notifiedProfilesReadError = false;
    return {
      created,
      updated,
      skipped: snapshot.profilesFile.profiles.length - created - updated,
      importedProfileCount: snapshot.profilesFile.profiles.length
    };
  }

  async importPortableProfileVault(password, options = {}) {
    const store = this.getPortableProfileVaultStore();
    const opened = store.read(password);
    const result = await this.mergePortableProfileSnapshot(opened.snapshot);
    await this.createProfileBackup('after-portable-vault-import');

    if (options.keepSynchronized === true) {
      const mergedSnapshot = await this.captureFullProfileSnapshot();
      const written = store.write(mergedSnapshot, password, {
        expectedFingerprint: opened.fingerprint
      });
      await this.context.secrets.store(PORTABLE_PROFILE_VAULT_PASSWORD_SECRET, password);
      await this.context.globalState.update(PORTABLE_PROFILE_VAULT_ENABLED_KEY, true);
      await this.rememberPortableProfileVaultWrite(written);
    } else {
      this.notifyPortableProfileVaultChanged();
    }

    return result;
  }

  queueProfileBackup(reason = 'profile-change') {
    this.pendingProfileBackupReason = reason;
    if (this.profileBackupPromise) {
      return;
    }

    const now = Date.now();
    const delay = Math.max(
      0,
      CHANGE_BACKUP_MIN_INTERVAL_MS - (now - this.lastScheduledProfileBackupAt)
    );
    if (delay > 0) {
      if (!this.profileBackupTimer) {
        this.profileBackupTimer = setTimeout(() => {
          this.profileBackupTimer = null;
          this.queueProfileBackup(this.pendingProfileBackupReason || 'profile-change');
        }, delay);
        if (typeof this.profileBackupTimer.unref === 'function') {
          this.profileBackupTimer.unref();
        }
      }
      return;
    }

    const backupReason = this.pendingProfileBackupReason || reason;
    this.pendingProfileBackupReason = null;
    this.lastScheduledProfileBackupAt = now;
    this.profileBackupPromise = this.createProfileBackup(backupReason)
      .catch((error) => {
        this.log('warn', 'Failed to create an encrypted Codex profile backup.', {
          error: error && error.message ? error.message : String(error)
        });
      })
      .finally(() => {
        this.profileBackupPromise = null;
        if (this.pendingProfileBackupReason) {
          this.queueProfileBackup(this.pendingProfileBackupReason);
        }
      });
  }

  async createProfileBackup(reason = 'manual') {
    const snapshot = await this.captureFullProfileSnapshot();
    const result = await this.getProfileBackupStore().write(snapshot, reason);
    this.log('info', 'Created encrypted Codex profile backup.', {
      backupPath: result.path,
      profileCount: snapshot.profilesFile.profiles.length,
      reason
    });
    await this.syncPortableProfileVault(reason, { snapshot });
    return result;
  }

  async createProtectiveProfileBackup(reason) {
    try {
      normalizeProfilesFile(fs.readFileSync(this.getProfilesPath(), 'utf8'));
      return await this.createProfileBackup(reason);
    } catch (error) {
      this.log('warn', 'Could not create a protective profile backup before restore.', {
        reason,
        error: error && error.message ? error.message : String(error)
      });
      return null;
    }
  }

  listProfileBackups() {
    return this.getProfileBackupStore().list();
  }

  deleteProfileBackup(backupPath) {
    this.getProfileBackupStore().delete(backupPath);
  }

  listProfileRestoreCandidates() {
    const candidates = this.listProfileBackups().map((backup) => ({
      ...backup,
      kind: 'encrypted'
    }));
    const mirrorPath = this.getProfilesBackupPath();
    if (fs.existsSync(mirrorPath)) {
      try {
        normalizeProfilesFile(fs.readFileSync(mirrorPath, 'utf8'));
        const stats = fs.statSync(mirrorPath);
        candidates.push({
          name: path.basename(mirrorPath),
          path: mirrorPath,
          createdAt: new Date(stats.mtimeMs).toISOString(),
          size: stats.size,
          kind: 'metadata'
        });
      } catch {
        // A damaged mirror is not a restore candidate.
      }
    }
    return candidates.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async restoreProfileCandidate(candidate) {
    if (!candidate) {
      throw new Error('No Codex profile backup was selected.');
    }
    if (candidate.kind === 'encrypted') {
      return this.restoreProfileBackup(candidate.path);
    }
    if (candidate.kind !== 'metadata' || candidate.path !== this.getProfilesBackupPath()) {
      throw new Error('Unsupported Codex profile restore candidate.');
    }

    const profilesFile = normalizeProfilesFile(fs.readFileSync(candidate.path, 'utf8'));
    await this.createProtectiveProfileBackup('before-metadata-restore');
    writeJsonAtomicSync(this.getProfilesPath(), profilesFile);
    this.notifiedProfilesReadError = false;
    this.lastScheduledProfileBackupAt = Date.now();
    this.emitChanged(null);
    await this.createProfileBackup('after-metadata-restore');
    return {
      profileCount: profilesFile.profiles.length,
      activeProfileId: null,
      sourceCreatedAt: candidate.createdAt || null
    };
  }

  async restoreProfileBackup(backupPath) {
    const snapshot = await this.getProfileBackupStore().read(backupPath);
    if (
      !snapshot ||
      !snapshot.profilesFile ||
      !Array.isArray(snapshot.profilesFile.profiles) ||
      !Array.isArray(snapshot.secrets)
    ) {
      throw new Error('The selected profile backup is incomplete.');
    }

    await this.createProtectiveProfileBackup('before-restore');

    const profilesFile = normalizeProfilesFile(snapshot.profilesFile);
    const profileIds = new Set(profilesFile.profiles.map((profile) => profile.id));
    const restoredSecrets = new Map(
      snapshot.secrets
        .filter((entry) => entry && profileIds.has(asOptionalString(entry.profileId)))
        .map((entry) => [entry.profileId, entry])
    );

    writeJsonAtomicSync(this.getProfilesPath(), profilesFile);
    writeJsonAtomicSync(this.getProfilesBackupPath(), profilesFile);

    for (const profile of profilesFile.profiles) {
      const entry = restoredSecrets.get(profile.id) || {};
      if (entry.tokens) {
        await this.writeStoredTokens(profile.id, entry.tokens);
      } else {
        await this.deleteStoredTokens(profile.id);
      }
      if (entry.privateNote) {
        await this.context.secrets.store(
          this.privateNoteSecretKey(profile.id),
          String(entry.privateNote)
        );
      } else {
        await this.context.secrets.delete(this.privateNoteSecretKey(profile.id));
      }
      if (entry.totp) {
        const base = normalizeTotpConfiguration(entry.totp.secret);
        const configuration = {
          ...base,
          algorithm: entry.totp.algorithm || base.algorithm,
          digits: entry.totp.digits || base.digits,
          period: entry.totp.period || base.period,
          issuer: entry.totp.issuer || '',
          account: entry.totp.account || ''
        };
        generateTotpCode(configuration, 0);
        await this.context.secrets.store(
          this.privateTotpSecretKey(profile.id),
          JSON.stringify(configuration)
        );
      } else {
        await this.context.secrets.delete(this.privateTotpSecretKey(profile.id));
      }
    }

    const bucket = this.getStateBucket();
    const activeProfileId = profileIds.has(asOptionalString(snapshot.activeProfileId))
      ? snapshot.activeProfileId
      : undefined;
    const lastProfileId = profileIds.has(asOptionalString(snapshot.lastProfileId))
      ? snapshot.lastProfileId
      : undefined;
    await bucket.update(ACTIVE_PROFILE_KEY, activeProfileId);
    await bucket.update(ACTIVE_PROFILE_SET_AT_KEY, undefined);
    await bucket.update(LAST_PROFILE_KEY, lastProfileId);
    this.windowActiveProfileInitialized = false;
    this.notifiedProfilesReadError = false;
    this.lastScheduledProfileBackupAt = Date.now();
    this.emitChanged(null);
    await this.createProfileBackup('after-restore');
    return {
      profileCount: profilesFile.profiles.length,
      activeProfileId: activeProfileId || null,
      sourceCreatedAt: snapshot.createdAt || null
    };
  }

  async offerProfileRestore(error) {
    if (this.profileRestorePromptPromise) {
      return this.profileRestorePromptPromise;
    }

    this.profileRestorePromptPromise = (async () => {
      const backups = this.listProfileRestoreCandidates();
      if (!backups.length) {
        return false;
      }
      const message = error && error.message ? error.message : String(error);
      const choice = await vscode.window.showErrorMessage(
        `Codex profiles are damaged and cannot be read. Restore an encrypted backup? ${message}`,
        { modal: true },
        'Restore latest',
        'Choose backup'
      );
      if (choice !== 'Restore latest' && choice !== 'Choose backup') {
        return false;
      }

      let selected = backups[0];
      if (choice === 'Choose backup') {
        selected = await vscode.window.showQuickPick(
          backups.map((backup) => ({
            label: `${new Date(backup.createdAt).toLocaleString()}${
              backup.kind === 'metadata' ? ' — metadata mirror' : ''
            }`,
            description: `${Math.max(1, Math.round(backup.size / 1024))} KiB`,
            backup
          })),
          { placeHolder: 'Choose a Codex profile backup to restore' }
        );
        selected = selected && selected.backup;
      }
      if (!selected) {
        return false;
      }

      try {
        const restored = await this.restoreProfileCandidate(selected);
        void vscode.window.showInformationMessage(
          `Restored ${restored.profileCount} Codex profile(s) from backup.`
        );
        return true;
      } catch (restoreError) {
        const restoreMessage = restoreError && restoreError.message
          ? restoreError.message
          : String(restoreError);
        void vscode.window.showErrorMessage(`Failed to restore Codex profiles: ${restoreMessage}`);
        return false;
      }
    })().finally(() => {
      this.profileRestorePromptPromise = null;
    });

    return this.profileRestorePromptPromise;
  }

  async promptProfileBackupRestore() {
    const backups = this.listProfileRestoreCandidates();
    if (!backups.length) {
      void vscode.window.showInformationMessage('No Codex profile backups are available.');
      return false;
    }
    const selectedItem = await vscode.window.showQuickPick(
      backups.map((backup) => ({
        label: `${new Date(backup.createdAt).toLocaleString()}${
          backup.kind === 'metadata' ? ' — metadata mirror' : ''
        }`,
        description: `${backup.reason || backup.kind} · ${Math.max(1, Math.round(backup.size / 1024))} KiB`,
        backup
      })),
      { placeHolder: 'Choose a Codex profile backup to restore' }
    );
    if (!selectedItem) {
      return false;
    }
    const confirmation = await vscode.window.showWarningMessage(
      'Restore the selected Codex profile backup? Current profile metadata and protected values from the snapshot will be replaced.',
      { modal: true },
      'Restore'
    );
    if (confirmation !== 'Restore') {
      return false;
    }
    const restored = await this.restoreProfileCandidate(selectedItem.backup);
    void vscode.window.showInformationMessage(
      `Restored ${restored.profileCount} Codex profile(s) from backup.`
    );
    return true;
  }

  async promptProfileBackupDelete() {
    const backups = this.listProfileBackups();
    if (!backups.length) {
      void vscode.window.showInformationMessage(
        'No encrypted Codex profile backups are available.'
      );
      return false;
    }
    const selectedItem = await vscode.window.showQuickPick(
      backups.map((backup) => ({
        label: new Date(backup.createdAt).toLocaleString(),
        description: backup.reason || 'backup',
        detail: `${Math.max(1, Math.round(backup.size / 1024))} KiB · ${backup.name}`,
        backup
      })),
      { placeHolder: 'Choose a Codex profile backup to delete' }
    );
    if (!selectedItem) {
      return false;
    }
    const confirmation = await vscode.window.showWarningMessage(
      `Delete the selected Codex profile backup from ${new Date(
        selectedItem.backup.createdAt
      ).toLocaleString()}?`,
      { modal: true },
      'Delete backup'
    );
    if (confirmation !== 'Delete backup') {
      return false;
    }
    this.deleteProfileBackup(selectedItem.backup.path);
    void vscode.window.showInformationMessage(
      'Deleted the selected Codex profile backup.'
    );
    return true;
  }

  async promptProfileBackupManager() {
    const backupCount = this.listProfileBackups().length;
    const selection = await vscode.window.showQuickPick(
      [
        {
          label: '$(save) Create backup now',
          description: `${backupCount} encrypted backup${backupCount === 1 ? '' : 's'} stored`,
          detail:
            'Capture profiles, protected tokens, private notes, 2FA, and active-account state.',
          action: 'create'
        },
        {
          label: '$(history) Restore backup...',
          detail: 'Choose a protected profile snapshot or the latest metadata mirror.',
          action: 'restore'
        },
        {
          label: '$(trash) Delete backup...',
          detail: 'Remove one encrypted snapshot after confirmation.',
          action: 'delete'
        },
        {
          label: '$(folder-opened) Open backup folder',
          detail: this.getProfileBackupsDir(),
          action: 'open'
        }
      ],
      { title: 'Codex profile backups', placeHolder: 'Choose a backup action' }
    );
    if (!selection) {
      return false;
    }
    if (selection.action === 'create') {
      const backup = await this.createProfileBackup('manual');
      void vscode.window.showInformationMessage(
        `Created an encrypted Codex profile backup: ${path.basename(backup.path)}`
      );
      return true;
    }
    if (selection.action === 'restore') {
      return this.promptProfileBackupRestore();
    }
    if (selection.action === 'delete') {
      return this.promptProfileBackupDelete();
    }
    if (selection.action === 'open') {
      fs.mkdirSync(this.getProfileBackupsDir(), { recursive: true, mode: 0o700 });
      await vscode.commands.executeCommand(
        'revealFileInOS',
        vscode.Uri.file(this.getProfileBackupsDir())
      );
      return true;
    }
    return false;
  }

  getActiveWindowUsagesPath() {
    return path.join(this.getStorageDir(), ACTIVE_WINDOW_USAGES_FILENAME);
  }

  getAuthBackupsDir() {
    return path.join(this.getStorageDir(), AUTH_BACKUPS_DIRNAME);
  }

  getActivityLogPath() {
    return path.join(this.getStorageDir(), ACTIVITY_LOG_FILENAME);
  }

  claimRateLimitRefresh(profileId, options = {}) {
    return this.rateLimitRefreshCoordinator.claim(profileId, options);
  }

  completeRateLimitRefresh(profileId, claim, succeeded) {
    this.rateLimitRefreshCoordinator.complete(profileId, claim, succeeded);
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

  async readProfilesFile(options = {}) {
    this.ensureStorageDir();
    const filePath = this.getProfilesPath();

    try {
      if (this.isRemoteFilesMode()) {
        const parsed = readJsonFile(filePath);
        if (parsed == null) {
          return { version: CURRENT_PROFILES_VERSION, profiles: [] };
        }
        return normalizeProfilesFile(parsed);
      }

      return readJsonFileSync(
        filePath,
        { version: CURRENT_PROFILES_VERSION, profiles: [] },
        normalizeProfilesFile,
        {
          backupFilePath: this.getProfilesBackupPath(),
          onStaleLockRemoved: ({ lockPath, lockAgeMs }) => {
            this.log('warn', 'Removed stale Codex profiles.json lock while reading.', {
              lockPath,
              lockAgeMs
            });
          }
        }
      );
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      this.log('error', 'Failed to read Codex profiles.json.', {
        error: message,
        filePath
      });
      if (options.offerRestore !== false && await this.offerProfileRestore(error)) {
        return this.readProfilesFile({ offerRestore: false });
      }
      if (!this.notifiedProfilesReadError) {
        this.notifiedProfilesReadError = true;
        void vscode.window.showErrorMessage(
          `Codex Multitool cannot read profiles.json at ${filePath}: ${message}`
        );
      }
      throw new Error(`Failed to read Codex profiles.json at ${filePath}: ${message}`);
    }
  }

  writeProfilesFile(data) {
    this.ensureStorageDir();
    const normalized = normalizeProfilesFile(data);
    this.mutateProfilesFile(() => normalized);
  }

  mutateProfilesFile(mutate) {
    this.ensureStorageDir();
    const filePath = this.getProfilesPath();
    try {
      return mutateJsonFileSync(
        filePath,
        { version: CURRENT_PROFILES_VERSION, profiles: [] },
        normalizeProfilesFile,
        mutate,
        {
          backupFilePath: this.getProfilesBackupPath(),
          skipWriteIfUnchanged: true,
          onStaleLockRemoved: ({ lockPath, lockAgeMs }) => {
            this.log('warn', 'Removed stale Codex profiles.json lock.', {
              lockPath,
              lockAgeMs
            });
          },
          onTransientRenameRecovered: ({ attempts, elapsedMs, errorCode, strategy }) => {
            this.log('info', 'Recovered transient Windows profiles.json replace contention.', {
              filePath,
              attempts,
              elapsedMs,
              errorCode,
              strategy: strategy || 'atomic-rename'
            });
          }
        }
      );
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      this.log('error', 'Failed to update Codex profiles.json.', {
        error: message,
        filePath
      });
      void this.offerProfileRestore(error);
      throw new Error(`Failed to update Codex profiles.json at ${filePath}: ${message}`);
    }
  }

  readActiveWindowUsageFile() {
    this.ensureStorageDir();
    const filePath = this.getActiveWindowUsagesPath();

    try {
      return readJsonFileSync(
        filePath,
        { version: 1, windows: [] },
        normalizeActiveWindowUsageFile,
        {
          recoverInvalidValue: true,
          onInvalidValueRecovered: ({ error, byteLength }) => {
            this.log('warn', 'Recovered invalid Codex active-window usage file.', {
              filePath,
              byteLength,
              error: error && error.message ? error.message : String(error)
            });
          },
          onStaleLockRemoved: ({ lockPath, lockAgeMs }) => {
            this.log('warn', 'Removed stale Codex active-window usage lock while reading.', {
              lockPath,
              lockAgeMs
            });
          }
        }
      );
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      this.log('error', 'Failed to read Codex active-window usage file.', {
        error: message,
        filePath
      });
      throw new Error(`Failed to read Codex active-window usage file at ${filePath}: ${message}`);
    }
  }

  writeActiveWindowUsageFile(data) {
    this.ensureStorageDir();
    const normalized = normalizeActiveWindowUsageFile(data);
    const filePath = this.getActiveWindowUsagesPath();
    mutateJsonFileSync(
      filePath,
      { version: 1, windows: [] },
      normalizeActiveWindowUsageFile,
      () => normalized,
      {
        recoverInvalidValue: true,
        onInvalidValueRecovered: ({ error, byteLength }) => {
          this.log('warn', 'Recovered invalid Codex active-window usage file.', {
            filePath,
            byteLength,
            error: error && error.message ? error.message : String(error)
          });
        },
        onStaleLockRemoved: ({ lockPath, lockAgeMs }) => {
          this.log('warn', 'Removed stale Codex active-window usage lock.', {
            lockPath,
            lockAgeMs
          });
        },
        onTransientRenameRecovered: ({ attempts, elapsedMs, errorCode, strategy }) => {
          this.log('info', 'Recovered transient Windows active-window usage replace contention.', {
            filePath,
            attempts,
            elapsedMs,
            errorCode,
            strategy: strategy || 'atomic-rename'
          });
        }
      }
    );
  }

  mutateActiveWindowUsageFile(mutate) {
    this.ensureStorageDir();
    const filePath = this.getActiveWindowUsagesPath();
    try {
      return mutateJsonFileSync(
        filePath,
        { version: 1, windows: [] },
        normalizeActiveWindowUsageFile,
        mutate,
        {
          recoverInvalidValue: true,
          onInvalidValueRecovered: ({ error, byteLength }) => {
            this.log('warn', 'Recovered invalid Codex active-window usage file.', {
              filePath,
              byteLength,
              error: error && error.message ? error.message : String(error)
            });
          },
          onStaleLockRemoved: ({ lockPath, lockAgeMs }) => {
            this.log('warn', 'Removed stale Codex active-window usage lock.', {
              lockPath,
              lockAgeMs
            });
          },
          onTransientRenameRecovered: ({ attempts, elapsedMs, errorCode, strategy }) => {
            this.log('info', 'Recovered transient Windows active-window usage replace contention.', {
              filePath,
              attempts,
              elapsedMs,
              errorCode,
              strategy: strategy || 'atomic-rename'
            });
          }
        }
      );
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      this.log('error', 'Failed to update Codex active-window usage file.', {
        error: message,
        filePath
      });
      throw new Error(`Failed to update Codex active-window usage file at ${filePath}: ${message}`);
    }
  }

  getWindowUsageWorkspaceLabel() {
    if (vscode.workspace.name) {
      return normalizeWindowUsageWorkspaceLabel(vscode.workspace.name);
    }

    const folder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
    if (folder && folder.uri && folder.uri.fsPath) {
      return normalizeWindowUsageWorkspaceLabel(path.basename(folder.uri.fsPath) || folder.uri.fsPath);
    }

    return 'VS Code window';
  }

  recordActiveWindowProfileUsage(profileId) {
    const normalizedProfileId = asOptionalString(profileId);
    if (!normalizedProfileId) {
      return this.clearActiveWindowProfileUsage();
    }

    this.mutateActiveWindowUsageFile((file) => {
      const windows = file.windows.filter((entry) => entry.windowId !== this.windowUsageId);
      windows.push({
        windowId: this.windowUsageId,
        profileId: normalizedProfileId,
        workspaceLabel: this.getWindowUsageWorkspaceLabel(),
        pid: typeof process !== 'undefined' ? process.pid : null,
        updatedAt: Date.now()
      });
      return {
        version: 1,
        windows
      };
    });
    return true;
  }

  clearActiveWindowProfileUsage() {
    try {
      let changed = false;
      this.mutateActiveWindowUsageFile((file) => {
        const windows = file.windows.filter((entry) => entry.windowId !== this.windowUsageId);
        changed = windows.length !== file.windows.length;
        return {
          version: 1,
          windows
        };
      });
      return changed;
    } catch (error) {
      this.log('warn', 'Failed to clear Codex active-window usage.', {
        error: error && error.message ? error.message : String(error)
      });
      return false;
    }
  }

  getOtherActiveWindowProfileUsageByProfileId() {
    const usageByProfileId = new Map();
    const file = this.readActiveWindowUsageFile();
    file.windows
      .filter((entry) => entry.windowId !== this.windowUsageId)
      .forEach((entry) => {
        const entries = usageByProfileId.get(entry.profileId) || [];
        entries.push(entry);
        usageByProfileId.set(entry.profileId, entries);
      });
    return usageByProfileId;
  }

  secretKey(profileId) {
    return `${NEW_SECRET_PREFIX}${profileId}`;
  }

  legacySecretKey(profileId) {
    return `${OLD_SECRET_PREFIX}${profileId}`;
  }

  privateNoteSecretKey(profileId) {
    return `${PRIVATE_NOTE_SECRET_PREFIX}${profileId}`;
  }

  privateTotpSecretKey(profileId) {
    return `${PRIVATE_TOTP_SECRET_PREFIX}${profileId}`;
  }

  async readProfilePrivateNote(profileId) {
    const value = await this.context.secrets.get(this.privateNoteSecretKey(profileId));
    return typeof value === 'string' ? value : '';
  }

  async writeProfilePrivateNote(profileId, value) {
    const note = String(value == null ? '' : value);
    if (note.length > MAX_PRIVATE_NOTE_LENGTH) {
      throw new Error('Private account note is too large (maximum 256 KiB).');
    }

    const currentNote = await this.readProfilePrivateNote(profileId);
    if (currentNote === note) {
      return;
    }
    await this.createProfileBackup('before-private-note-change');

    if (!note) {
      await this.context.secrets.delete(this.privateNoteSecretKey(profileId));
      this.queueProfileBackup('private-note-change');
      return;
    }

    await this.context.secrets.store(this.privateNoteSecretKey(profileId), note);
    this.queueProfileBackup('private-note-change');
  }

  async deleteProfilePrivateNote(profileId) {
    await this.context.secrets.delete(this.privateNoteSecretKey(profileId));
  }

  async readProfileTotpConfiguration(profileId) {
    const raw = await this.context.secrets.get(this.privateTotpSecretKey(profileId));
    if (!raw) {
      return null;
    }
    try {
      const value = JSON.parse(raw);
      const base = normalizeTotpConfiguration(value && value.secret);
      const configuration = {
        ...base,
        algorithm: value.algorithm || base.algorithm,
        digits: value.digits || base.digits,
        period: value.period || base.period,
        issuer: value.issuer || '',
        account: value.account || ''
      };
      generateTotpCode(configuration, 0);
      return configuration;
    } catch (error) {
      this.log('error', 'Failed to read a protected TOTP configuration.', {
        profileId,
        error: error && error.message ? error.message : String(error)
      });
      return null;
    }
  }

  async writeProfileTotpConfiguration(profileId, value) {
    const configuration = normalizeTotpConfiguration(value);
    const current = await this.readProfileTotpConfiguration(profileId);
    if (serializeComparable(current) === serializeComparable(configuration)) {
      return configuration;
    }
    await this.createProfileBackup('before-totp-change');
    await this.context.secrets.store(
      this.privateTotpSecretKey(profileId),
      JSON.stringify(configuration)
    );
    this.queueProfileBackup('totp-change');
    return configuration;
  }

  async deleteProfileTotpConfiguration(profileId, options = {}) {
    const current = await this.readProfileTotpConfiguration(profileId);
    if (!current) {
      return false;
    }
    if (options.skipBackup !== true) {
      await this.createProfileBackup('before-totp-change');
    }
    await this.context.secrets.delete(this.privateTotpSecretKey(profileId));
    if (options.skipBackup !== true) {
      this.queueProfileBackup('totp-change');
    }
    return true;
  }

  async getProfileTotpCode(profileId, timestamp = Date.now()) {
    const configuration = await this.readProfileTotpConfiguration(profileId);
    if (!configuration) {
      return {
        configured: false
      };
    }
    return {
      configured: true,
      ...generateTotpCode(configuration, timestamp)
    };
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
    } catch (error) {
      this.log('error', 'Failed to parse stored Codex profile tokens.', {
        profileId,
        error: error && error.message ? error.message : String(error)
      });
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

  ensureAuthBackupsDir() {
    this.ensureStorageDir();
    const backupsDir = this.getAuthBackupsDir();
    if (!fs.existsSync(backupsDir)) {
      fs.mkdirSync(backupsDir, { recursive: true });
    }
    return backupsDir;
  }

  async backupCurrentAuth(reason = 'manual') {
    const authPath = getDefaultCodexAuthPath(this.logger);
    if (!fs.existsSync(authPath)) {
      this.log('warn', 'Cannot back up Codex auth.json because it does not exist.', {
        authPath,
        reason
      });
      return null;
    }

    const backupsDir = this.ensureAuthBackupsDir();
    const name = `auth-${getTimestampFilePart()}-${sanitizePathPart(reason)}.json`;
    const backupPath = path.join(backupsDir, name);
    fs.copyFileSync(authPath, backupPath);

    const authData = await loadAuthDataFromFile(authPath, this.logger);
    const metadataPath = `${backupPath}.meta.json`;
    fs.writeFileSync(metadataPath, JSON.stringify({
      createdAt: getNowIso(),
      reason,
      sourcePath: authPath,
      email: authData && authData.email ? authData.email : undefined,
      accountId: authData && authData.accountId ? authData.accountId : undefined,
      defaultOrganizationId:
        authData && authData.defaultOrganizationId ? authData.defaultOrganizationId : undefined
    }, null, 2), 'utf8');

    this.log('info', 'Backed up current Codex auth.json.', {
      backupPath,
      reason
    });
    await this.pruneAuthBackups();
    return backupPath;
  }

  async listAuthBackups() {
    const backupsDir = this.getAuthBackupsDir();
    if (!fs.existsSync(backupsDir)) {
      return [];
    }

    const entries = fs.readdirSync(backupsDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json') && !entry.name.endsWith('.meta.json'))
      .map((entry) => {
        const backupPath = path.join(backupsDir, entry.name);
        const stats = fs.statSync(backupPath);
        let metadata = {};
        try {
          const metadataPath = `${backupPath}.meta.json`;
          if (fs.existsSync(metadataPath)) {
            metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
          }
        } catch (error) {
          this.log('warn', 'Failed to read Codex auth backup metadata.', {
            backupPath,
            error: error && error.message ? error.message : String(error)
          });
        }
        return {
          name: entry.name,
          path: backupPath,
          createdAt: metadata.createdAt || new Date(stats.mtimeMs).toISOString(),
          reason: metadata.reason || 'unknown',
          email: metadata.email,
          accountId: metadata.accountId,
          defaultOrganizationId: metadata.defaultOrganizationId
        };
      })
      .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
  }

  async pruneAuthBackups(now = Date.now()) {
    const backups = await this.listAuthBackups();
    if (!backups.length) {
      return 0;
    }

    const cutoff = now - AUTH_BACKUP_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    const keptPerDay = new Map();
    const keepPaths = new Set();
    for (const backup of backups) {
      if (keepPaths.size >= MAX_AUTH_BACKUPS) {
        break;
      }
      const timestamp = Date.parse(backup.createdAt);
      if (!Number.isFinite(timestamp) || timestamp < cutoff) {
        continue;
      }
      const day = new Date(timestamp).toISOString().slice(0, 10);
      const keptForDay = keptPerDay.get(day) || 0;
      if (keptForDay >= AUTH_BACKUPS_PER_DAY) {
        continue;
      }
      keptPerDay.set(day, keptForDay + 1);
      keepPaths.add(backup.path);
    }

    if (!keepPaths.size) {
      keepPaths.add(backups[0].path);
    }

    let removed = 0;
    for (const backup of backups) {
      if (keepPaths.has(backup.path)) {
        continue;
      }
      deleteFileIfExists(backup.path);
      deleteFileIfExists(`${backup.path}.meta.json`);
      removed += 1;
    }
    if (removed > 0) {
      this.log('info', 'Pruned old Codex auth backups.', {
        removed,
        retained: keepPaths.size,
        retentionDays: AUTH_BACKUP_RETENTION_DAYS
      });
    }
    return removed;
  }

  async restoreAuthBackup(backupPath) {
    if (!backupPath || !fs.existsSync(backupPath)) {
      throw new Error('Selected Codex auth backup no longer exists.');
    }

    const authData = await loadAuthDataFromFile(backupPath, this.logger);
    if (!authData) {
      throw new Error('Selected Codex auth backup is not a valid auth.json.');
    }

    await this.backupCurrentAuth('before-restore');
    const authPath = getDefaultCodexAuthPath(this.logger);
    const authDir = path.dirname(authPath);
    if (!fs.existsSync(authDir)) {
      fs.mkdirSync(authDir, { recursive: true });
    }
    fs.copyFileSync(backupPath, authPath);
    this.windowActiveProfileInitialized = false;
    await this.appendProfileActivity('restoreAuthBackup', {
      backupName: path.basename(backupPath),
      restoredEmail: authData.email,
      restoredAccountId: authData.accountId
    });
    this.emitChanged();
    return authData;
  }

  async appendProfileActivity(action, data = {}) {
    const activityLoggingEnabled = vscode.workspace
      .getConfiguration('codexSwitch')
      .get('profileActivityLogEnabled', false);
    if (!activityLoggingEnabled) {
      return;
    }

    try {
      this.ensureStorageDir();
      const entry = {
        timestamp: getNowIso(),
        action,
        ...data
      };
      fs.appendFileSync(this.getActivityLogPath(), `${JSON.stringify(entry)}\n`, 'utf8');
    } catch (error) {
      this.log('warn', 'Failed to write Codex profile activity log.', {
        action,
        error: error && error.message ? error.message : String(error)
      });
    }
  }

  async listProfiles() {
    await this.clearExpiredCooldowns();
    const file = await this.readProfilesFile();
    return [...file.profiles].sort((left, right) => compareDisplayText(left.name, right.name));
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
        group: asOptionalString(profile.group),
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

    await this.createProfileBackup('before-profile-import');

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
        await this.replaceProfileAuth(duplicate.id, parsed.authData, {
          skipBackup: true
        });
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
    let changed = false;
    this.mutateProfilesFile((file) => {
      const index = file.profiles.findIndex((profile) => profile.id === profileId);
      if (index === -1) {
        return file;
      }

      const current = file.profiles[index];
      const next = normalizeProfileSummary({
        ...current,
        group: metadata && metadata.group != null
          ? normalizeProfileGroup(metadata.group)
          : current.group,
        cooldownUntil:
          metadata && metadata.cooldownUntil != null
            ? metadata.cooldownUntil
            : current.cooldownUntil,
        rateLimitState:
          metadata && metadata.rateLimitState != null
            ? metadata.rateLimitState
            : current.rateLimitState,
        updatedAt: getNowIso()
      });

      if (serializeComparable(current) === serializeComparable(next)) {
        return file;
      }

      file.profiles[index] = next;
      changed = true;
      return file;
    });
    if (!changed) {
      return false;
    }
    this.emitChanged('imported-metadata-change');
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

  async initializeWindowActiveProfile(force = false) {
    if (this.windowActiveProfileInitialized && !force) {
      return {
        hasAuth: this.windowActiveHasAuth,
        profileId: this.windowActiveProfileId
      };
    }

    const bucket = this.getStateBucket();
    const savedProfileId = asOptionalString(bucket.get(ACTIVE_PROFILE_KEY));
    if (savedProfileId) {
      const savedProfile = await this.getProfile(savedProfileId);
      if (savedProfile) {
        this.windowActiveProfileInitialized = true;
        this.windowActiveHasAuth = true;
        this.windowActiveProfileId = savedProfileId;
        this.windowActiveProfileActivatedAt = asTimestamp(
          bucket.get(ACTIVE_PROFILE_SET_AT_KEY)
        );
        return {
          hasAuth: true,
          profileId: savedProfileId
        };
      }

      await bucket.update(ACTIVE_PROFILE_KEY, undefined);
      await bucket.update(ACTIVE_PROFILE_SET_AT_KEY, undefined);
    }

    return this.initializeWindowActiveProfileFromCurrentAuth(true);
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
      await this.getStateBucket().update(ACTIVE_PROFILE_KEY, undefined);
      await this.getStateBucket().update(ACTIVE_PROFILE_SET_AT_KEY, undefined);
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
    await this.getStateBucket().update(
      ACTIVE_PROFILE_KEY,
      this.windowActiveProfileId
    );
    await this.getStateBucket().update(
      ACTIVE_PROFILE_SET_AT_KEY,
      this.windowActiveProfileActivatedAt
    );
    if (match) {
      this.lastSyncedProfileId = match.id;
    }

    return {
      hasAuth: true,
      profileId: this.windowActiveProfileId
    };
  }

  async getWindowActiveProfileMatch() {
    return this.initializeWindowActiveProfile();
  }

  async findDuplicateProfile(authData) {
    return this.findProfileMatchingAuthData(authData);
  }

  async loadCurrentAuthData() {
    return loadAuthDataFromFile(getDefaultCodexAuthPath(this.logger), this.logger);
  }

  async waitForCurrentAuthData(options = {}) {
    const timeoutMs = Math.max(0, Number(options.timeoutMs) || 0);
    const intervalMs = Math.max(100, Number(options.intervalMs) || 500);
    const stableMs = Math.max(0, Number(options.stableMs) || 250);
    const requireModifiedAfter = Number(options.requireModifiedAfter) || 0;
    const startedAt = Date.now();
    const authPath = getDefaultCodexAuthPath(this.logger);

    while (Date.now() - startedAt < timeoutMs) {
      const modifiedAt = this.getAuthFileModifiedAt();
      if (requireModifiedAfter && (!modifiedAt || modifiedAt < requireModifiedAfter)) {
        await sleep(intervalMs);
        continue;
      }

      const authData = await this.loadCurrentAuthData();
      if (authData) {
        if (stableMs > 0) {
          const beforeStableModifiedAt = this.getAuthFileModifiedAt();
          await sleep(stableMs);
          const afterStableModifiedAt = this.getAuthFileModifiedAt();
          if (
            beforeStableModifiedAt &&
            afterStableModifiedAt &&
            beforeStableModifiedAt !== afterStableModifiedAt
          ) {
            continue;
          }
        }

        return {
          authData,
          authPath,
          waitedMs: Date.now() - startedAt
        };
      }

      await sleep(intervalMs);
    }

    return {
      authData: await this.loadCurrentAuthData(),
      authPath,
      waitedMs: Date.now() - startedAt
    };
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
        `Selected auth.json belongs to a different account and cannot restore profile "${displayProfileName(profile)}".`
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
      `Profile "${profile ? displayProfileName(profile) : profileId}" is missing tokens. Restoring requires the matching auth.json for that same account.`,
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

  async replaceProfileAuth(profileId, authData, options = {}) {
    if (options.skipBackup !== true) {
      const existing = await this.getProfile(profileId);
      if (!existing) {
        return false;
      }
      await this.createProfileBackup('before-auth-change');
    }
    let updated = false;
    this.mutateProfilesFile((file) => {
      const index = file.profiles.findIndex((profile) => profile.id === profileId);
      if (index === -1) {
        return file;
      }

      file.profiles[index] = normalizeProfileSummary({
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
      updated = true;
      return file;
    });
    if (!updated) {
      return false;
    }

    await this.writeStoredTokens(profileId, {
      idToken: authData.idToken,
      accessToken: authData.accessToken,
      refreshToken: authData.refreshToken,
      accountId: authData.accountId,
      authJson: cloneJson(authData.authJson)
    });

    this.emitChanged('auth-change');
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
      return false;
    }

    const profile = await this.getProfile(profileId);
    const currentAuthData = await this.loadCurrentAuthData();
    if (profile && currentAuthData && this.matchesAuth(profile, currentAuthData)) {
      await this.syncStoredProfileAuth(profileId, currentAuthData);
      this.lastSyncedProfileId = profileId;
      return false;
    }

    const authData = await this.loadAuthData(profileId);
    if (!authData) {
      return false;
    }

    syncCodexAuthFile(getDefaultCodexAuthPath(this.logger), authData);
    this.lastSyncedProfileId = profileId;
    return true;
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

    let storedProfile = profile;
    let created = false;
    this.mutateProfilesFile((file) => {
      const duplicate = file.profiles.find((candidate) => this.matchesAuth(candidate, authData));
      if (duplicate) {
        storedProfile = duplicate;
        return file;
      }

      file.profiles.push(profile);
      created = true;
      return file;
    });

    await this.writeStoredTokens(storedProfile.id, {
      idToken: authData.idToken,
      accessToken: authData.accessToken,
      refreshToken: authData.refreshToken,
      accountId: authData.accountId,
      authJson: cloneJson(authData.authJson)
    });

    if (created) {
      this.emitChanged('profile-created');
    }
    return storedProfile;
  }

  async renameProfile(profileId, newName) {
    const existing = await this.getProfile(profileId);
    if (!existing) {
      return false;
    }
    if (existing.name === newName) {
      return true;
    }
    await this.createProfileBackup('before-profile-rename');
    let renamed = false;
    this.mutateProfilesFile((file) => {
      const index = file.profiles.findIndex((profile) => profile.id === profileId);
      if (index === -1) {
        return file;
      }
      file.profiles[index] = normalizeProfileSummary({
        ...file.profiles[index],
        name: newName,
        updatedAt: getNowIso()
      });
      renamed = true;
      return file;
    });
    if (!renamed) {
      return false;
    }
    this.emitChanged('profile-renamed');
    return true;
  }

  async setProfileGroup(profileId, groupName) {
    const nextGroup = normalizeProfileGroup(groupName);
    const existing = await this.getProfile(profileId);
    if (!existing) {
      return false;
    }
    if (existing.group === nextGroup) {
      return true;
    }
    await this.createProfileBackup('before-profile-group-change');
    let found = false;
    let changed = false;
    this.mutateProfilesFile((file) => {
      const index = file.profiles.findIndex((profile) => profile.id === profileId);
      if (index === -1) {
        return file;
      }
      found = true;
      if (file.profiles[index].group === nextGroup) {
        return file;
      }
      file.profiles[index] = normalizeProfileSummary({
        ...file.profiles[index],
        group: nextGroup,
        updatedAt: getNowIso()
      });
      changed = true;
      return file;
    });
    if (changed) {
      this.emitChanged('profile-group-changed');
    }
    return found;
  }

  async deleteProfile(profileId) {
    const existing = await this.getProfile(profileId);
    if (!existing) {
      return false;
    }
    await this.createProfileBackup('before-profile-delete');
    let deleted = false;
    this.mutateProfilesFile((file) => {
      const beforeCount = file.profiles.length;
      file.profiles = file.profiles.filter((profile) => profile.id !== profileId);
      deleted = file.profiles.length !== beforeCount;
      return file;
    });
    if (!deleted) {
      return false;
    }

    await this.deleteStoredTokens(profileId);
    await this.deleteProfilePrivateNote(profileId);
    await this.deleteProfileTotpConfiguration(profileId, { skipBackup: true });

    const bucket = this.getStateBucket();
    if (bucket.get(ACTIVE_PROFILE_KEY) === profileId) {
      await bucket.update(ACTIVE_PROFILE_KEY, undefined);
      await bucket.update(ACTIVE_PROFILE_SET_AT_KEY, undefined);
      this.windowActiveProfileInitialized = false;
    }

    const lastProfileId = await this.getLastProfileId();
    if (lastProfileId === profileId) {
      await this.setLastProfileId(undefined);
    }

    this.emitChanged('profile-deleted');
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
    return this.context.workspaceState;
  }

  async getActiveProfileId() {
    const windowActive = await this.getWindowActiveProfileMatch();
    return windowActive.profileId;
  }

  async getActiveProfileActivatedAt() {
    await this.getWindowActiveProfileMatch();
    return this.windowActiveProfileActivatedAt;
  }

  async setActiveProfileId(profileId, options = {}) {
    const bucket = this.getStateBucket();
    const previous = await this.getActiveProfileId();
    const transient = options && options.transient === true;
    const forceAuthSync = options && options.forceAuthSync === true;
    const skipAuthBackup =
      transient && options && options.skipAuthBackup === true;

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

      if (previous === profileId && !forceAuthSync) {
        activationTimestampMs = await this.getActiveProfileActivatedAt();
      }

      const currentAuthData = await loadAuthDataFromFile(
        getDefaultCodexAuthPath(this.logger),
        this.logger
      );
      currentAuthMatchesTarget = Boolean(
        currentAuthData && this.matchesAuth(targetProfile, currentAuthData)
      );

      if (!activationTimestampMs && currentAuthMatchesTarget && !forceAuthSync) {
        activationTimestampMs = this.getAuthFileModifiedAt();
      }
    }

    const switchedAtIso = getNowIso();
    const effectiveActivatedAt =
      profileId ? activationTimestampMs || Date.parse(switchedAtIso) : undefined;

    const shouldSyncAuthFile = Boolean(
      profileId && authData && (forceAuthSync || !currentAuthMatchesTarget)
    );
    if (shouldSyncAuthFile) {
      if (!skipAuthBackup) {
        await this.backupCurrentAuth('before-profile-switch');
      }
      syncCodexAuthFile(getDefaultCodexAuthPath(this.logger), authData);
      this.lastSyncedProfileId = profileId;
    } else if (profileId) {
      this.lastSyncedProfileId = profileId;
    }

    if (!transient && previous && profileId && previous !== profileId) {
      await this.setLastProfileId(previous);
    }

    await bucket.update(ACTIVE_PROFILE_KEY, profileId);
    await bucket.update(ACTIVE_PROFILE_SET_AT_KEY, effectiveActivatedAt);

    await this.appendProfileActivity('setActiveProfile', {
      profileId: profileId || null,
      previousProfileId: previous || null,
      changedAuthFile: shouldSyncAuthFile,
      transient
    });

    this.windowActiveProfileInitialized = true;
    this.windowActiveHasAuth = Boolean(profileId);
    this.windowActiveProfileId = profileId || undefined;
    this.windowActiveProfileActivatedAt = effectiveActivatedAt;

    this.emitChanged();
    return true;
  }

  async getLastProfileId() {
    const bucket = this.getStateBucket();
    return bucket.get(LAST_PROFILE_KEY);
  }

  async setLastProfileId(profileId) {
    const bucket = this.getStateBucket();
    await bucket.update(LAST_PROFILE_KEY, profileId);
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
    const now = Date.now();
    let changed = false;
    this.mutateProfilesFile((file) => {
      const nextProfiles = file.profiles.map((profile) => {
        const currentRateLimitState = profile.rateLimitState || null;
        let latestExpiredResetAt = null;
        const clearExpiredWindow = (windowState) => {
          if (!windowState) {
            return null;
          }
          const resetAt = asTimestamp(windowState.resetAt);
          if (!resetAt || resetAt > now) {
            return windowState;
          }
          latestExpiredResetAt = Math.max(latestExpiredResetAt || 0, resetAt);
          return {
            ...windowState,
            usedPercent: 0,
            resetAt: null
          };
        };
        const nextPrimary = clearExpiredWindow(
          currentRateLimitState && currentRateLimitState.primary
        );
        const nextSecondary = clearExpiredWindow(
          currentRateLimitState && currentRateLimitState.secondary
        );
        const nextRateLimitState = currentRateLimitState
          ? {
              ...currentRateLimitState,
              assumedResetAt:
                Math.max(
                  latestExpiredResetAt || 0,
                  asTimestamp(currentRateLimitState.assumedResetAt) || 0
                ) || null,
              primary: nextPrimary,
              secondary: nextSecondary
            }
          : null;

        const nextCooldownUntil = getExhaustedCooldownUntil([
          nextRateLimitState && nextRateLimitState.primary,
          nextRateLimitState && nextRateLimitState.secondary
        ], now);

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

      return {
        version: CURRENT_PROFILES_VERSION,
        profiles: nextProfiles
      };
    });
    if (changed) {
      this.emitChanged();
    }
    return changed;
  }

  async recordRateLimitObservation(profileId, observation) {
    const result = await this.recordRateLimitObservationWithResult(profileId, observation);
    return result.changed;
  }

  async recordRateLimitObservationWithResult(profileId, observation) {
    const now = Date.now();
    const observationTimestamp = asTimestamp(observation && observation.recordTimestampMs);
    const observedPrimary =
      observation && observation.primary
        ? observation.primary
        : null;
    const primaryResetAt =
      observedPrimary &&
      !observedPrimary.outdated &&
      asTimestamp(observedPrimary.resetAt);
    const secondaryResetAt =
      observation &&
      observation.secondary &&
      !observation.secondary.outdated &&
      asTimestamp(observation.secondary.resetAt);
    const cooldownUntil = getExhaustedCooldownUntil([
      observedPrimary
        ? {
            usedPercent: observedPrimary.usedPercent,
            resetAt: primaryResetAt
          }
        : null,
      observation && observation.secondary
        ? {
            usedPercent: observation.secondary.usedPercent,
            resetAt: secondaryResetAt
          }
        : null
    ], now);

    const observedRateLimitState = normalizeRateLimitState({
      observedAt: observation && observation.recordTimestampMs,
      sourceFile: observation && observation.filePath,
      planType: observation && observation.planType,
      totalTokens:
        observation && observation.totalUsage ? observation.totalUsage.total_tokens : null,
      lastTokens: observation && observation.lastUsage ? observation.lastUsage.total_tokens : null,
      primary: observedPrimary
        ? {
            usedPercent: observedPrimary.usedPercent,
            resetAt: primaryResetAt,
            windowMinutes: observedPrimary.windowMinutes
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

    let changed = false;
    let unexpectedResetWindows = [];
    this.mutateProfilesFile((file) => {
      const index = file.profiles.findIndex((profile) => profile.id === profileId);
      if (index === -1) {
        return file;
      }

      const profile = file.profiles[index];
      const storedObservationTimestamp = asTimestamp(
        profile.rateLimitState && profile.rateLimitState.observedAt
      );
      if (
        storedObservationTimestamp &&
        (!observationTimestamp || observationTimestamp < storedObservationTimestamp)
      ) {
        this.log('warn', 'Rejected older Codex rate-limit observation.', {
          profileId,
          observationTimestamp,
          storedObservationTimestamp,
          sourceFile: observation && observation.filePath
        });
        return file;
      }

      const primaryWithResetMetadata = preserveUnexpectedResetMetadata(
        profile.rateLimitState,
        observedRateLimitState,
        'primary',
        observationTimestamp
      );
      const secondaryWithResetMetadata = preserveUnexpectedResetMetadata(
        profile.rateLimitState,
        observedRateLimitState,
        'secondary',
        observationTimestamp
      );
      unexpectedResetWindows = [
        primaryWithResetMetadata.unexpectedResetDetected ? 'primary' : null,
        secondaryWithResetMetadata.unexpectedResetDetected ? 'secondary' : null
      ].filter(Boolean);
      const rateLimitState = normalizeRateLimitState({
        ...observedRateLimitState,
        primary: primaryWithResetMetadata.windowState,
        secondary: secondaryWithResetMetadata.windowState
      });
      const nextProfile = normalizeProfileSummary({
        ...profile,
        planType: asOptionalString(observation && observation.planType) || profile.planType,
        cooldownUntil,
        rateLimitState,
        updatedAt: getNowIso()
      });

      if (serializeComparable(profile) === serializeComparable(nextProfile)) {
        return file;
      }

      file.profiles[index] = nextProfile;
      changed = true;
      return file;
    });
    if (changed) {
      if (unexpectedResetWindows.length > 0) {
        this.log('info', 'Detected an out-of-schedule Codex rate-limit reset.', {
          profileId,
          windows: unexpectedResetWindows,
          observedAt: observationTimestamp
        });
      }
      this.emitChanged();
    }
    return {
      changed,
      unexpectedResetWindows,
      observedAt: observationTimestamp
    };
  }

  async resetPaidProfileRateLimits(resetDetectedAt = Date.now()) {
    const normalizedResetDetectedAt = asTimestamp(resetDetectedAt) || Date.now();
    const currentProfilesFile = await this.readProfilesFile();
    const hasPaidRateLimitState = currentProfilesFile.profiles.some(
      (profile) => isPaidPlanType(profile.planType) && profile.rateLimitState
    );
    if (!hasPaidRateLimitState) {
      return 0;
    }

    await this.createProfileBackup('before-paid-limit-reset');
    let resetProfileCount = 0;
    this.mutateProfilesFile((file) => {
      file.profiles = file.profiles.map((profile) => {
        if (!isPaidPlanType(profile.planType) || !profile.rateLimitState) {
          return profile;
        }

        const resetWindow = (windowState) => {
          if (!windowState) {
            return null;
          }

          const alreadyCounted =
            asTimestamp(windowState.lastUnexpectedResetAt) === normalizedResetDetectedAt;
          return {
            ...windowState,
            usedPercent: 0,
            resetAt: null,
            unexpectedResetCount:
              Math.max(0, Math.round(Number(windowState.unexpectedResetCount) || 0)) +
              (alreadyCounted ? 0 : 1),
            lastUnexpectedResetAt: normalizedResetDetectedAt
          };
        };
        const nextRateLimitState = normalizeRateLimitState({
          ...profile.rateLimitState,
          assumedResetAt: normalizedResetDetectedAt,
          primary: resetWindow(profile.rateLimitState.primary),
          secondary: resetWindow(profile.rateLimitState.secondary)
        });
        const nextProfile = normalizeProfileSummary({
          ...profile,
          cooldownUntil: null,
          rateLimitState: nextRateLimitState,
          updatedAt: getNowIso()
        });

        if (serializeComparable(profile) === serializeComparable(nextProfile)) {
          return profile;
        }

        resetProfileCount += 1;
        return nextProfile;
      });
      return file;
    });

    if (resetProfileCount > 0) {
      this.log('info', 'Reset locally stored rate-limit usage for paid Codex profiles.', {
        resetDetectedAt: normalizedResetDetectedAt,
        profileCount: resetProfileCount
      });
      this.emitChanged();
    }
    return resetProfileCount;
  }

  createWatchers(onChanged) {
    const disposables = [];
    this.ensureStorageDir();
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

    const activeWindowUsageWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.file(this.getStorageDir()), ACTIVE_WINDOW_USAGES_FILENAME)
    );
    activeWindowUsageWatcher.onDidCreate(() => fire('windowUsage'));
    activeWindowUsageWatcher.onDidChange(() => fire('windowUsage'));
    activeWindowUsageWatcher.onDidDelete(() => fire('windowUsage'));
    disposables.push(activeWindowUsageWatcher);

    const profilesWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.file(this.getStorageDir()), PROFILES_FILENAME)
    );
    profilesWatcher.onDidCreate(() => fire('profiles'));
    profilesWatcher.onDidChange(() => fire('profiles'));
    profilesWatcher.onDidDelete(() => fire('profiles'));
    disposables.push(profilesWatcher);

    if (this.isRemoteFilesMode()) {
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
