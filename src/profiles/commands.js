'use strict';

const fs = require('fs');
const crypto = require('crypto');
const os = require('os');
const path = require('path');
const vscode = require('vscode');
const { execFileSync } = require('child_process');
const {
  CONFIG_SECTION,
  SEND_TO_CODEX_ENABLED_DEFAULT,
  SEND_TO_CODEX_ENABLED_SETTING
} = require('../config');
const {
  getDefaultCodexAuthPath,
  loadAuthDataFromFile,
  shouldUseWslAuthPath
} = require('./authManager');
const {
  DEFAULT_POST_SWITCH_RESTORE_STRATEGY,
  POST_SWITCH_RESTORE_STRATEGY_OPTIONS,
  getPostSwitchRestoreStrategyOption,
  normalizePostSwitchRestoreStrategy
} = require('../codex/CodexPostSwitchWarmup');
const { areProfileFeaturesEnabled } = require('./featureFlags');
const {
  formatCompactRateSummary,
  formatPlanType,
  getPlanSortRank,
  getProfileRateStatus,
  getWindowRemainingPercent,
  isProfileWeeklyTokensLow,
  sortProfilesForDisplay
} = require('./profileStatus');
const { RateLimitDetailsPanel } = require('./webview');
const {
  PROFILE_QUICK_PICK_SECONDARY_SORT_OPTIONS,
  PROFILE_QUICK_PICK_SORT_OPTIONS,
  formatLowRemainingPercentThreshold,
  getProfileQuickPickSectionLabel,
  getProfileQuickPickSettings,
  isProfileQuickPickSectionVisible,
  sortProfileQuickPickItems
} = require('./quickPickSettings');
const {
  displayProfileEmail,
  displayProfileName
} = require('./privacy');
const { ProfileNotePanel } = require('./profileNotePanel');
const {
  RateLimitActivationReportPanel
} = require('./rateLimitActivationReportPanel');
const {
  getUnstartedProfiles,
  resolveLocalCodexExecutable
} = require('./rateLimitWindowActivator');
const {
  ACTIVATION_MODE_APP_SERVER,
  ACTIVATION_MODE_VSCODE_EXTENSION,
  RateLimitActivationWindowLauncher,
  createReportEnvironment,
  getActivationModeLabel
} = require('./rateLimitActivationWindow');
const { formatLocalDateTime } = require('../ui/userFormatting');

function getDefaultSettingsExportUri(homeDirectory = os.homedir()) {
  return vscode.Uri.file(
    path.join(homeDirectory, 'codex-switch-profiles.json')
  );
}

const ENCRYPTED_EXPORT_FORMAT = 'codex-switch-profile-export-encrypted';
const EXPORT_ENCRYPTION_VERSION = 1;
const EXPORT_KEY_ITERATIONS = 210000;

function hasRequiredStoredTokens(tokens) {
  if (!tokens || typeof tokens !== 'object') {
    return false;
  }

  return ['idToken', 'accessToken', 'refreshToken'].every((key) => {
    return typeof tokens[key] === 'string' && tokens[key].trim();
  });
}

async function getProfileAuthState(profileManager, profileId) {
  const tokens = await profileManager.readStoredTokens(profileId);
  if (!tokens || typeof tokens !== 'object') {
    return {
      hasIssue: true,
      description: 'Auth required'
    };
  }

  if (!hasRequiredStoredTokens(tokens)) {
    return {
      hasIssue: true,
      description: 'Auth issue'
    };
  }

  return {
    hasIssue: false,
    description: undefined
  };
}

function getProfileQuickPickSection(status, authState, weeklyTokensLow) {
  if (authState.hasIssue) {
    return 'needsAuth';
  }
  if (status.cooldownActive) {
    return 'coolingDown';
  }
  if (status.windowNotStarted) {
    return 'notStarted';
  }
  if (weeklyTokensLow) {
    return 'weeklyLow';
  }
  if (status.isEstimatedRateLimitData) {
    return 'staleEstimate';
  }
  return 'ready';
}

function getProfileQuickPickIcon(isActive, authState, weeklyTokensLow, status) {
  if (isActive) {
    return '$(check)';
  }
  if (authState.hasIssue) {
    return '$(warning)';
  }
  if (status.cooldownActive) {
    return '$(watch)';
  }
  if (status.windowNotStarted) {
    return '$(watch)';
  }
  if (weeklyTokensLow) {
    return '$(circle-slash)';
  }
  return '$(account)';
}

function getFutureTimestamp(value, now) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > now ? numeric : null;
}

function getEarliestFutureTimestamp(values, now) {
  const futureValues = values
    .map((value) => getFutureTimestamp(value, now))
    .filter((value) => value != null)
    .sort((left, right) => left - right);
  return futureValues.length ? futureValues[0] : null;
}

function getLowestRemainingPercent(primaryRemainingPercent, weeklyRemainingPercent) {
  const values = [primaryRemainingPercent, weeklyRemainingPercent]
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value >= 0);
  return values.length ? Math.min(...values) : -1;
}

function getOtherWindowUsageEntries(profileId, otherWindowProfileUsageByProfileId) {
  if (!profileId || !otherWindowProfileUsageByProfileId) {
    return [];
  }

  if (typeof otherWindowProfileUsageByProfileId.get === 'function') {
    return otherWindowProfileUsageByProfileId.get(profileId) || [];
  }

  return otherWindowProfileUsageByProfileId[profileId] || [];
}

function formatWindowUsageLabel(value) {
  return String(value || '')
    .trim()
    .replace(/\s*\(Workspace\)\s*$/i, '')
    .trim();
}

function formatWindowUsageDescription(entries, options = {}) {
  const includeCurrentWindow = options.includeCurrentWindow === true;
  if ((!entries || !entries.length) && !includeCurrentWindow) {
    return '';
  }

  const currentWindowLabel = includeCurrentWindow
    ? formatWindowUsageLabel(options.currentWindowLabel) || 'This window'
    : null;
  const labels = [...new Set(
    (currentWindowLabel ? [{ workspaceLabel: currentWindowLabel }] : [])
      .concat(entries || [])
      .map((entry) => formatWindowUsageLabel(entry && entry.workspaceLabel))
      .filter(Boolean)
  )];
  const suffix = labels.length ? ` ${labels.slice(0, 2).join(', ')}` : '';
  return `$(window)${suffix}`;
}

async function confirmSwitchToProfileUsedInOtherWindow(profile, profileManager) {
  const usageByProfileId = profileManager.getOtherActiveWindowProfileUsageByProfileId();
  const entries = getOtherWindowUsageEntries(profile && profile.id, usageByProfileId);
  if (!entries.length) {
    return true;
  }

  const profileName = displayProfileName(profile);
  const labels = [...new Set(
    entries
      .map((entry) => formatWindowUsageLabel(entry && entry.workspaceLabel))
      .filter(Boolean)
  )];
  const locationText = labels.length ? ` (${labels.join(', ')})` : '';
  const switchLabel = 'Switch anyway';
  const selection = await vscode.window.showWarningMessage(
    `Codex profile "${profileName}" is already active in ${entries.length} other VS Code window(s)${locationText}.`,
    { modal: true },
    switchLabel
  );
  return selection === switchLabel;
}

async function buildProfileQuickPickItems(profiles, activeProfileId, profileManager) {
  const now = Date.now();
  const quickPickSettings = getProfileQuickPickSettings();
  const lowWeeklyOptions = {
    activeProfileId,
    lowRemainingPercentThreshold: quickPickSettings.lowWeeklyRemainingZeroThreshold
  };
  const otherWindowProfileUsageByProfileId =
    profileManager.getOtherActiveWindowProfileUsageByProfileId();
  const sortedProfiles = sortProfilesForDisplay(profiles, activeProfileId, now, lowWeeklyOptions);
  return Promise.all(sortedProfiles.map(async (profile, index) => {
    const status = getProfileRateStatus(profile, now, { activeProfileId });
    const descriptionParts = [];
    const authState = await getProfileAuthState(profileManager, profile.id);
    const isActive = profile.id === activeProfileId;
    const weeklyTokensLow = isProfileWeeklyTokensLow(profile, now, lowWeeklyOptions);

    if (weeklyTokensLow) {
      descriptionParts.push(
        `W < ${formatLowRemainingPercentThreshold(
          quickPickSettings.lowWeeklyRemainingZeroThreshold
        )}%`
      );
    }
    const otherWindowUsageEntries = getOtherWindowUsageEntries(
      profile.id,
      otherWindowProfileUsageByProfileId
    );
    const windowUsageDescription =
      formatWindowUsageDescription(otherWindowUsageEntries, {
        includeCurrentWindow: isActive,
        currentWindowLabel: isActive && profileManager.getWindowUsageWorkspaceLabel
          ? profileManager.getWindowUsageWorkspaceLabel()
          : undefined
      });
    if (windowUsageDescription) {
      descriptionParts.push(windowUsageDescription);
    }
    if (authState.description) {
      descriptionParts.push(authState.description);
    }
    descriptionParts.push(formatPlanType(profile.planType));

    const summary = formatCompactRateSummary(status, now, {
      includePrimaryCountdown: true,
      includeSecondaryCountdown: true,
      percentageMode: 'remaining',
      includePercentageLabel: true,
      roundLowWeeklyRemainingToZero: quickPickSettings.roundLowWeeklyRemainingToZero,
      lowRemainingPercentThreshold: quickPickSettings.lowWeeklyRemainingZeroThreshold
    });
    const estimateSuffix = status.isEstimatedRateLimitData ? ' • estimate' : '';
    const email = profile.email && profile.email !== 'Unknown'
      ? displayProfileEmail(profile.email)
      : null;
    const group = profile.group ? `Group: ${profile.group}` : null;
    if (authState.hasIssue) {
      descriptionParts.push('Restore the matching auth.json for this account');
    } else {
      descriptionParts.push(`${summary}${estimateSuffix}`);
    }
    if (email) {
      descriptionParts.push(email);
    }
    if (group) {
      descriptionParts.push(group);
    }
    const primaryResetAt = getFutureTimestamp(status.primary && status.primary.resetAt, now);
    const weeklyResetAt = getFutureTimestamp(status.secondary && status.secondary.resetAt, now);
    const nextResetAt = getEarliestFutureTimestamp(
      [status.cooldownUntil, primaryResetAt, weeklyResetAt],
      now
    );
    const primaryRemainingPercent = getWindowRemainingPercent(status.primary, now);
    const weeklyRemainingPercent = getWindowRemainingPercent(status.secondary, now);

    return {
      label: `${getProfileQuickPickIcon(isActive, authState, weeklyTokensLow, status)} ${displayProfileName(profile)}`,
      description: descriptionParts.length ? descriptionParts.join('   ') : undefined,
      profileId: profile.id,
      profileName: profile.name,
      profileDisplayName: displayProfileName(profile),
      planText: formatPlanType(profile.planType),
      planRank: getPlanSortRank(profile.planType),
      profileGroup: profile.group || '',
      quickPickSortIndex: index,
      primaryResetAt,
      weeklyResetAt,
      nextResetAt,
      observedAt: status.observedAt || null,
      primaryRemainingPercent,
      weeklyRemainingPercent,
      lowestRemainingPercent: getLowestRemainingPercent(primaryRemainingPercent, weeklyRemainingPercent),
      isActive,
      iconPath: weeklyTokensLow
        ? new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('disabledForeground'))
        : undefined,
      buttons: [
        {
          iconPath: new vscode.ThemeIcon('notebook'),
          tooltip: 'Open private note'
        }
      ],
      weeklyTokensLow,
      otherWindowUsageCount: otherWindowUsageEntries.length,
      quickPickSection: getProfileQuickPickSection(status, authState, weeklyTokensLow),
      alwaysShow: isActive
    };
  }));
}

async function buildAddCurrentProfileItem(profileManager) {
  const windowActive = await profileManager.getWindowActiveProfileMatch();
  if (!windowActive.hasAuth) {
    return null;
  }

  const authData = await profileManager.loadCurrentAuthData();
  if (!authData) {
    return null;
  }

  if (windowActive.profileId) {
    if (await profileManager.hasStoredTokens(windowActive.profileId)) {
      return null;
    }

    const activeProfile = await profileManager.getProfile(windowActive.profileId);
    if (activeProfile && profileManager.matchesAuth(activeProfile, authData)) {
      return {
        label: '$(key) Restore current profile',
        description: displayProfileName(activeProfile),
        detail: 'Store tokens from the current ~/.codex/auth.json for this saved profile',
        command: 'codex-switch.profile.addFromCodexAuthFile'
      };
    }

    return null;
  }

  const existing = await profileManager.findDuplicateProfile(authData);
  if (existing) {
    if (await profileManager.hasStoredTokens(existing.id)) {
      return null;
    }

    return {
      label: '$(key) Restore current profile',
      description: displayProfileName(existing),
      detail: 'Store tokens from the current ~/.codex/auth.json for this saved profile',
      command: 'codex-switch.profile.addFromCodexAuthFile'
    };
  }

  const description =
    authData.email && authData.email !== 'Unknown'
      ? displayProfileEmail(authData.email)
      : getDefaultCodexAuthPath(profileManager.logger);

  return {
    label: '$(add) Add current profile',
    description,
    detail: 'Save the current ~/.codex/auth.json as a managed profile',
    command: 'codex-switch.profile.addFromCodexAuthFile'
  };
}

async function buildAutoProfileName(profileManager, authData) {
  const rawBase =
    authData && authData.email && authData.email !== 'Unknown'
      ? String(authData.email).split('@')[0]
      : 'profile';
  const base = rawBase.trim().replace(/\s+/g, ' ') || 'profile';
  const existingNames = new Set(
    (await profileManager.listProfiles()).map((profile) => String(profile.name).toLowerCase())
  );

  if (!existingNames.has(base.toLowerCase())) {
    return base;
  }

  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${base} ${index}`;
    if (!existingNames.has(candidate.toLowerCase())) {
      return candidate;
    }
  }

  return `${base} ${Date.now()}`;
}

async function createProfileFromAuthData(profileManager, authData) {
  const name = await buildAutoProfileName(profileManager, authData);
  const profile = await profileManager.createProfile(name, authData);
  await profileManager.appendProfileActivity('createProfile', {
    profileId: profile.id,
    email: authData.email,
    accountId: authData.accountId
  });
  void vscode.window.showInformationMessage(`Added Codex profile "${displayProfileName(profile)}".`);
  return profile;
}

function showAutoAddAccountPrompt(accountLabel, options = {}) {
  const timeoutMs = Math.max(0, Number(options.timeoutMs) || 5_000);
  const tickMs = Math.max(10, Math.min(1_000, Number(options.tickMs) || 250));
  const quickPick = vscode.window.createQuickPick();
  const addItem = {
    label: '$(add) Add account now',
    description: 'Save securely and make this the active Codex account',
    action: 'add',
    alwaysShow: true
  };
  const cancelItem = {
    label: '$(close) Cancel account addition',
    description: 'Keep the current Codex account unchanged',
    action: 'cancel',
    alwaysShow: true
  };
  const deadline = Date.now() + timeoutMs;

  quickPick.title = 'Add Codex account';
  quickPick.items = [addItem, cancelItem];
  quickPick.ignoreFocusOut = true;
  quickPick.matchOnDescription = true;

  return new Promise((resolve) => {
    let settled = false;
    let interval;
    let timeout;
    const disposables = [];

    const updateCountdown = () => {
      const secondsRemaining = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      quickPick.placeholder =
        `Login completed for ${accountLabel}. Adding automatically in ${secondsRemaining}s unless cancelled.`;
    };

    const finish = (shouldAdd) => {
      if (settled) {
        return;
      }
      settled = true;
      if (interval) {
        clearInterval(interval);
      }
      if (timeout) {
        clearTimeout(timeout);
      }
      quickPick.hide();
      for (const disposable of disposables) {
        disposable.dispose();
      }
      quickPick.dispose();
      resolve(shouldAdd);
    };

    disposables.push(
      quickPick.onDidAccept(() => {
        const selected = quickPick.activeItems[0] || quickPick.selectedItems[0];
        if (selected && selected.action === 'cancel') {
          finish(false);
          return;
        }
        if (selected && selected.action === 'add') {
          finish(true);
        }
      }),
      quickPick.onDidHide(() => {
        finish(false);
      })
    );

    updateCountdown();
    interval = setInterval(updateCountdown, tickMs);
    timeout = setTimeout(() => finish(true), timeoutMs);
    quickPick.show();
  });
}

function encryptTransferPayload(payload, passphrase) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.pbkdf2Sync(
    String(passphrase),
    salt,
    EXPORT_KEY_ITERATIONS,
    32,
    'sha256'
  );
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const plaintext = Buffer.from(JSON.stringify(payload), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    format: ENCRYPTED_EXPORT_FORMAT,
    version: EXPORT_ENCRYPTION_VERSION,
    exportedAt: new Date().toISOString(),
    cipher: 'aes-256-gcm',
    kdf: 'pbkdf2-sha256',
    iterations: EXPORT_KEY_ITERATIONS,
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    ciphertext: ciphertext.toString('base64')
  };
}

function decryptTransferPayload(payload, passphrase) {
  if (!payload || payload.format !== ENCRYPTED_EXPORT_FORMAT) {
    return payload;
  }

  if (payload.version !== EXPORT_ENCRYPTION_VERSION) {
    throw new Error('Unsupported encrypted export version.');
  }

  const salt = Buffer.from(String(payload.salt || ''), 'base64');
  const iv = Buffer.from(String(payload.iv || ''), 'base64');
  const tag = Buffer.from(String(payload.tag || ''), 'base64');
  const ciphertext = Buffer.from(String(payload.ciphertext || ''), 'base64');
  const key = crypto.pbkdf2Sync(
    String(passphrase),
    salt,
    Number(payload.iterations) || EXPORT_KEY_ITERATIONS,
    32,
    'sha256'
  );
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(plaintext.toString('utf8'));
}

async function promptForExportPassphrase() {
  return vscode.window.showInputBox({
    prompt: 'Passphrase for encrypted Codex profile export',
    password: true,
    ignoreFocusOut: true,
    validateInput(value) {
      return value && value.length >= 8 ? undefined : 'Use at least 8 characters.';
    }
  });
}

async function promptForImportPassphrase() {
  return vscode.window.showInputBox({
    prompt: 'Passphrase for encrypted Codex profile export',
    password: true,
    ignoreFocusOut: true
  });
}

function shortDiagnosticValue(value) {
  const normalized = String(value || '').trim();
  if (!normalized) {
    return 'n/a';
  }
  return normalized.length > 12 ? `${normalized.slice(0, 8)}...${normalized.slice(-4)}` : normalized;
}

function formatDoctorTimestamp(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return 'n/a';
  }
  return formatLocalDateTime(numeric);
}

function formatRefreshDiagnostic(result) {
  if (!result) {
    return 'n/a';
  }

  const parts = [
    `${result.source || 'unknown'} / ${result.outcome || 'unknown'}`
  ];
  if (result.sourceFile) {
    parts.push(`sourceFile=${result.sourceFile}`);
  }
  if (result.error) {
    parts.push(`error=${result.error}`);
  }
  if (result.timestamp) {
    parts.push(`at=${formatDoctorTimestamp(result.timestamp)}`);
  }
  return parts.join('; ');
}

function readCodexCliVersionForDoctor() {
  const attempts = shouldUseWslAuthPath()
    ? [
        ['wsl.exe', ['codex', '--version']],
        ['wsl.exe', ['sh', '-lc', 'command -v codex']]
      ]
    : [
        ['codex', ['--version']]
      ];

  const errors = [];
  for (const [command, args] of attempts) {
    try {
      const output = String(
        execFileSync(command, args, {
          encoding: 'utf8',
          windowsHide: true,
          timeout: 5000
        })
      ).trim();
      if (output) {
        return output;
      }
    } catch (error) {
      errors.push(error && error.message ? error.message : String(error));
    }
  }

  return `ERROR: ${errors.join(' | ') || 'codex command did not return output'}`;
}

function buildReloadWindowToggleItem(enabled) {
  return {
    label: `${enabled ? '$(check)' : '$(circle-large-outline)'} Reload VS Code after switch`,
    description: enabled ? 'On' : 'Off',
    detail:
      'Recommended for Codex: reloads the VS Code window so the Codex extension restarts with the selected auth.json.',
    reloadToggle: true
  };
}

function buildSendToCodexToggleItem(enabled) {
  return {
    label: `${enabled ? '$(check)' : '$(circle-large-outline)'} Send to Codex`,
    description: enabled ? 'On' : 'Off',
    detail: enabled
      ? 'Click to turn off capture, popups, status buttons, and attach commands while keeping profiles available.'
      : 'Click to turn Send to Codex capture, popups, status buttons, and attach commands back on.',
    sendToggle: true
  };
}

function buildPostSwitchRestoreStrategyItem(strategy) {
  const option = getPostSwitchRestoreStrategyOption(strategy);
  return {
    label: `$(beaker) Post-switch chat restore: ${option.label}`,
    description: option.description,
    detail: option.detail,
    restoreStrategyPicker: true
  };
}

async function showPostSwitchRestoreStrategyQuickPick(currentStrategy) {
  const normalizedCurrent = normalizePostSwitchRestoreStrategy(currentStrategy);
  return vscode.window.showQuickPick(
    POST_SWITCH_RESTORE_STRATEGY_OPTIONS.map((option) => ({
      label: `${option.id === normalizedCurrent ? '$(check) ' : ''}${option.label}`,
      description: option.description,
      detail: option.detail,
      strategy: option.id
    })),
    {
      title: 'Codex Multitool',
      placeHolder: 'Choose post-switch chat restore strategy'
    }
  );
}

function buildSendToCodexSettingsItem() {
  return {
    label: '$(gear) Send to Codex settings...',
    detail: 'Open capture, popup, status button, and attachment settings.',
    command: 'codexTerminalRecorder.openSettings'
  };
}

function buildManageProfilesItem() {
  return {
    label: '$(settings-gear) Open accounts page...',
    detail: 'Open the full Codex account management page.',
    command: 'codex-switch.profile.manage'
  };
}

function pushProfileSection(items, label, sectionItems) {
  if (!sectionItems.length) {
    return;
  }

  items.push({
    label: `${label} (${sectionItems.length})`,
    kind: vscode.QuickPickItemKind.Separator
  });
  items.push(...sectionItems);
}

function buildManageBackupsItem() {
  return {
    label: '$(history) Manage backups...',
    detail: 'Create, restore, delete, or open encrypted profile backups.',
    command: 'codex-switch.profile.manageBackups'
  };
}

function getQuickPickSortOptionLabel(options, selectedId) {
  const option = options.find((candidate) => candidate.id === selectedId);
  return option ? option.label : selectedId;
}

function buildProfileSortControlItems(settings) {
  return [
    {
      label: '$(list-ordered) Sort accounts...',
      description: getQuickPickSortOptionLabel(
        PROFILE_QUICK_PICK_SORT_OPTIONS,
        settings.profileSort
      ),
      detail: 'Choose the primary ordering for visible accounts.',
      profileSortPicker: true,
      alwaysShow: true
    },
    {
      label: '$(list-tree) Tie-break sort...',
      description: getQuickPickSortOptionLabel(
        PROFILE_QUICK_PICK_SECONDARY_SORT_OPTIONS,
        settings.secondaryProfileSort
      ),
      detail: 'Used when two accounts have the same primary sort value.',
      secondaryProfileSortPicker: true,
      alwaysShow: true
    }
  ];
}

function buildProfileSortPickerItems(settings, secondary = false) {
  const options = secondary
    ? PROFILE_QUICK_PICK_SECONDARY_SORT_OPTIONS
    : PROFILE_QUICK_PICK_SORT_OPTIONS;
  const selectedId = secondary ? settings.secondaryProfileSort : settings.profileSort;
  const modeProperty = secondary ? 'secondaryProfileSortMode' : 'profileSortMode';

  return [
    {
      label: '$(arrow-left) Back to accounts',
      profileSortPickerBack: true,
      alwaysShow: true
    },
    {
      label: secondary ? 'Tie-break sort' : 'Account sort',
      kind: vscode.QuickPickItemKind.Separator
    },
    ...options.map((option) => ({
      label: `${option.id === selectedId ? '$(check) ' : ''}${option.label}`,
      description: option.id === selectedId ? 'Current' : undefined,
      [modeProperty]: option.id,
      alwaysShow: true
    }))
  ];
}

function buildSwitchQuickPickItems(
  profileItems,
  addCurrentProfileItem,
  reloadEnabled,
  restoreStrategy,
  sendToCodexEnabled
) {
  const items = [];
  const quickPickSettings = getProfileQuickPickSettings();

  if (profileItems.length > 1) {
    items.push({
      label: 'Account ordering',
      kind: vscode.QuickPickItemKind.Separator
    });
    items.push(...buildProfileSortControlItems(quickPickSettings));
  }

  if (profileItems.length > 0) {
    const sectionOrder = quickPickSettings.sectionOrder;
    const activeItems = profileItems.filter((item) => item.isActive);
    const nonActiveItems = profileItems.filter((item) => !item.isActive);
    pushProfileSection(items, 'Active account', activeItems);

    if (quickPickSettings.profileSort !== 'availability') {
      const knownSectionIds = new Set(sectionOrder);
      const visibleItems = nonActiveItems.filter((item) => {
        const sectionId = knownSectionIds.has(item.quickPickSection)
          ? item.quickPickSection
          : 'otherProfiles';
        return isProfileQuickPickSectionVisible(quickPickSettings, sectionId);
      });
      pushProfileSection(
        items,
        'Accounts',
        sortProfileQuickPickItems(
          visibleItems,
          quickPickSettings.profileSort,
          quickPickSettings.secondaryProfileSort
        )
      );
    } else {
      const remainingItems = [...nonActiveItems];
      for (const sectionId of sectionOrder) {
        const sectionItems = remainingItems.filter(
          (item) => item.quickPickSection === sectionId
        );
        if (
          isProfileQuickPickSectionVisible(quickPickSettings, sectionId)
        ) {
          pushProfileSection(
            items,
            getProfileQuickPickSectionLabel(sectionId),
            sortProfileQuickPickItems(
              sectionItems,
              quickPickSettings.profileSort,
              quickPickSettings.secondaryProfileSort
            )
          );
        }
        for (const sectionItem of sectionItems) {
          const index = remainingItems.indexOf(sectionItem);
          if (index !== -1) {
            remainingItems.splice(index, 1);
          }
        }
      }
      if (
        isProfileQuickPickSectionVisible(quickPickSettings, 'otherProfiles')
      ) {
        pushProfileSection(
          items,
          getProfileQuickPickSectionLabel('otherProfiles'),
          sortProfileQuickPickItems(
            remainingItems,
            quickPickSettings.profileSort,
            quickPickSettings.secondaryProfileSort
          )
        );
      }
    }
  }

  if (addCurrentProfileItem) {
    if (items.length > 0) {
      items.push({
        label: 'Current environment',
        kind: vscode.QuickPickItemKind.Separator
      });
    }
    items.push(addCurrentProfileItem);
  }

  items.push(
    {
      label: 'Extension',
      kind: vscode.QuickPickItemKind.Separator
    },
    buildReloadWindowToggleItem(reloadEnabled),
    buildPostSwitchRestoreStrategyItem(restoreStrategy),
    buildSendToCodexToggleItem(sendToCodexEnabled),
    buildSendToCodexSettingsItem(),
    buildManageBackupsItem(),
    buildManageProfilesItem()
  );

  return items;
}

function showProfileSwitchQuickPick(
  profileItems,
  addCurrentProfileItem,
  getReloadEnabled,
  setReloadEnabled,
  getRestoreStrategy,
  getSendToCodexEnabled,
  setSendToCodexEnabled
) {
  return new Promise((resolve) => {
    const quickPick = vscode.window.createQuickPick();
    let settled = false;
    let viewMode = 'profiles';

    const finish = (selection) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(selection);
      quickPick.hide();
    };

    const rebuildItems = () => {
      const quickPickSettings = getProfileQuickPickSettings();
      const items =
        viewMode === 'primarySort'
          ? buildProfileSortPickerItems(quickPickSettings, false)
          : viewMode === 'secondarySort'
            ? buildProfileSortPickerItems(quickPickSettings, true)
            : buildSwitchQuickPickItems(
                profileItems,
                addCurrentProfileItem,
                getReloadEnabled(),
                getRestoreStrategy(),
                getSendToCodexEnabled()
              );
      quickPick.items = items;
      quickPick.placeholder =
        viewMode === 'primarySort'
          ? 'Choose account sort'
          : viewMode === 'secondarySort'
            ? 'Choose tie-break sort'
            : 'Switch profile';
      quickPick.activeItems = [];

      const activeProfileItem =
        viewMode === 'profiles' && items.find((item) => item && item.isActive);
      if (activeProfileItem && viewMode === 'profiles') {
        quickPick.activeItems = [activeProfileItem];
      }
    };

    quickPick.title = 'Codex Multitool';
    quickPick.placeholder = 'Switch profile';
    quickPick.matchOnDescription = true;
    quickPick.matchOnDetail = false;
    quickPick.keepScrollPosition = true;
    rebuildItems();

    quickPick.onDidAccept(async () => {
      const selection = quickPick.selectedItems[0];
      if (!selection) {
        return;
      }

      if (selection.profileSortPicker) {
        viewMode = 'primarySort';
        rebuildItems();
        return;
      }

      if (selection.secondaryProfileSortPicker) {
        viewMode = 'secondarySort';
        rebuildItems();
        return;
      }

      if (selection.profileSortPickerBack) {
        viewMode = 'profiles';
        rebuildItems();
        return;
      }

      if (selection.profileSortMode || selection.secondaryProfileSortMode) {
        quickPick.busy = true;
        try {
          const key = selection.profileSortMode
            ? 'profileQuickPick.profileSort'
            : 'profileQuickPick.secondaryProfileSort';
          const value = selection.profileSortMode || selection.secondaryProfileSortMode;
          await vscode.workspace
            .getConfiguration('codexSwitch')
            .update(key, value, vscode.ConfigurationTarget.Global);
          viewMode = 'profiles';
          rebuildItems();
        } finally {
          quickPick.busy = false;
        }
        return;
      }

      if (selection.reloadToggle) {
        quickPick.busy = true;
        try {
          await setReloadEnabled(!getReloadEnabled());
          rebuildItems();
        } finally {
          quickPick.busy = false;
        }
        return;
      }

      if (selection.restoreStrategyPicker) {
        finish({ command: 'codex-switch.profile.restoreStrategy' });
        return;
      }

      if (selection.sendToggle) {
        quickPick.busy = true;
        try {
          await setSendToCodexEnabled(!getSendToCodexEnabled());
          rebuildItems();
        } finally {
          quickPick.busy = false;
        }
        return;
      }

      finish(selection);
    });

    quickPick.onDidTriggerItemButton((event) => {
      const profileId = event && event.item && event.item.profileId;
      if (profileId) {
        finish({ openPrivateNoteProfileId: profileId });
      }
    });

    quickPick.onDidHide(() => {
      if (!settled) {
        settled = true;
        resolve(undefined);
      }
      quickPick.dispose();
    });

    quickPick.show();
  });
}

function registerProfileCommands(
  context,
  profileManager,
  rateLimitMonitor,
  refreshProfileUi,
  options = {}
) {
  const markWindowAuthChangeExpected =
    options && typeof options.markWindowAuthChangeExpected === 'function'
      ? options.markWindowAuthChangeExpected
      : () => {};
  const onProfileSwitchCommitted =
    options && typeof options.onProfileSwitchCommitted === 'function'
      ? options.onProfileSwitchCommitted
      : async () => {};
  const autoAddAccountTimeoutMs = Math.max(
    0,
    Number(options.autoAddAccountTimeoutMs) || 5_000
  );
  const authLoginMaxWaitMs = Math.max(
    10,
    Number(options.authLoginMaxWaitMs) || 10 * 60 * 1000
  );
  const resolveCodexExecutable =
    options && typeof options.resolveCodexExecutable === 'function'
      ? options.resolveCodexExecutable
      : resolveLocalCodexExecutable;
  const rateLimitWindowActivator = new RateLimitActivationWindowLauncher(
    context,
    profileManager,
    rateLimitMonitor,
    profileManager.logger
  );

  const getReloadWindowAfterProfileSwitch = () => Boolean(
    vscode.workspace
      .getConfiguration('codexSwitch')
      .get('reloadWindowAfterProfileSwitch', true)
  );

  const getPostSwitchRestoreStrategy = () => normalizePostSwitchRestoreStrategy(
    vscode.workspace
      .getConfiguration('codexSwitch')
      .get('postSwitchRestoreStrategy', DEFAULT_POST_SWITCH_RESTORE_STRATEGY)
  );

  const getSendToCodexEnabled = () => Boolean(
    vscode.workspace
      .getConfiguration(CONFIG_SECTION)
      .get(SEND_TO_CODEX_ENABLED_SETTING, SEND_TO_CODEX_ENABLED_DEFAULT)
  );

  const setReloadWindowAfterProfileSwitch = async (enabled) => {
    await vscode.workspace
      .getConfiguration('codexSwitch')
      .update(
        'reloadWindowAfterProfileSwitch',
        Boolean(enabled),
        vscode.ConfigurationTarget.Global
      );
  };

  const setPostSwitchRestoreStrategy = async (strategy) => {
    const normalized = normalizePostSwitchRestoreStrategy(strategy);
    await vscode.workspace
      .getConfiguration('codexSwitch')
      .update(
        'postSwitchRestoreStrategy',
        normalized,
        vscode.ConfigurationTarget.Global
      );
    profileManager.logger &&
      profileManager.logger.info &&
      profileManager.logger.info('Changed Codex post-switch chat restore strategy.', {
        strategy: normalized
      });
  };

  const setSendToCodexEnabled = async (enabled) => {
    await vscode.workspace
      .getConfiguration(CONFIG_SECTION)
      .update(
        SEND_TO_CODEX_ENABLED_SETTING,
        Boolean(enabled),
        vscode.ConfigurationTarget.Global
      );
  };

  const ensureProfileFeaturesEnabled = async () => {
    if (areProfileFeaturesEnabled()) {
      return true;
    }

    const enableLabel = 'Enable profiles';
    const openSettingsLabel = 'Open settings';
    const selection = await vscode.window.showInformationMessage(
      'Codex profiles and rate limits are disabled.',
      enableLabel,
      openSettingsLabel
    );

    if (selection === enableLabel) {
      await vscode.workspace
        .getConfiguration('codexSwitch')
        .update('enabled', true, vscode.ConfigurationTarget.Global);
      return true;
    }

    if (selection === openSettingsLabel) {
      await vscode.commands.executeCommand('codexTerminalRecorder.openSettings');
    }

    return false;
  };

  const maybeReloadWindowAfterProfileSwitch = () => {
    if (getReloadWindowAfterProfileSwitch()) {
      profileManager.logger &&
        profileManager.logger.info &&
        profileManager.logger.info('Requesting VS Code window reload after Codex profile switch.');
      setTimeout(() => {
        void vscode.commands.executeCommand('workbench.action.reloadWindow').then(
          undefined,
          (error) => {
            const message = error && error.message ? error.message : String(error);
            profileManager.logger &&
              profileManager.logger.error &&
              profileManager.logger.error('Failed to request VS Code window reload after profile switch.', {
                error: message
              });
            void vscode.window.showErrorMessage(
              `Failed to reload VS Code after Codex profile switch: ${message}`
            );
          }
        );
      }, 0);
    }
  };

  const afterProfileSwitch = async (options = {}) => {
    const { reloadWindow = true } = options;

    await rateLimitMonitor.refresh(true);
    await refreshProfileUi();
    if (reloadWindow) {
      maybeReloadWindowAfterProfileSwitch();
    }
  };

  const setActiveProfileAndRefresh = async (profileId, options = {}) => {
    const {
      reloadWindowOnSwitch = true,
      forceReloadWindow = false,
      forceAuthSync = false
    } = options;
    const previousProfileId = await profileManager.getActiveProfileId();
    const changedProfile = previousProfileId !== profileId;
    const shouldReloadWindow = reloadWindowOnSwitch && (changedProfile || forceReloadWindow);
    if (profileId && changedProfile) {
      const targetProfile = await profileManager.getProfile(profileId);
      if (targetProfile && !(await confirmSwitchToProfileUsedInOtherWindow(targetProfile, profileManager))) {
        return null;
      }
    }
    if (profileId && (changedProfile || forceReloadWindow)) {
      markWindowAuthChangeExpected({ profileId });
    }
    const switched = await profileManager.setActiveProfileId(profileId, {
      forceAuthSync
    });
    if (!switched) {
      return false;
    }

    await onProfileSwitchCommitted(profileId, {
      changedProfile: changedProfile || forceReloadWindow,
      willReloadWindow: shouldReloadWindow && getReloadWindowAfterProfileSwitch()
    });
    await afterProfileSwitch({
      reloadWindow: shouldReloadWindow
    });
    return true;
  };

  const getLoginCommandText = () => (shouldUseWslAuthPath() ? 'wsl codex login' : 'codex login');
  const getLogoutCommandText = () => (shouldUseWslAuthPath() ? 'wsl codex logout' : 'codex logout');
  const getReauthCommandText = () => `${getLogoutCommandText()}\n${getLoginCommandText()}`;

  const createCodexTerminalEnvironment = (additionalEnvironment = {}) => {
    const environment = { ...additionalEnvironment };
    if (shouldUseWslAuthPath()) {
      return Object.keys(environment).length ? environment : undefined;
    }

    const executable = resolveCodexExecutable();
    const executableDirectory = path.dirname(executable);
    const inheritedPath = String(process.env.PATH || process.env.Path || '');
    environment.PATH = [executableDirectory, inheritedPath]
      .filter(Boolean)
      .join(path.delimiter);
    profileManager.logger &&
      profileManager.logger.info &&
      profileManager.logger.info('Resolved Codex CLI for terminal authentication flow.', {
        executable
      });
    return environment;
  };

  const saveAuthDataAsProfile = async (authData, options = {}) => {
    const {
      activate = true,
      reloadWindowOnSwitch = true,
      forceReloadWindow = false,
      forceAuthSync = false
    } = options;
    const existing = await profileManager.findDuplicateProfile(authData);
    if (existing) {
      const existingHasTokens = await profileManager.hasStoredTokens(existing.id);
      if (!existingHasTokens) {
        await profileManager.replaceProfileAuth(existing.id, authData);
        if (activate) {
          await setActiveProfileAndRefresh(existing.id, {
            reloadWindowOnSwitch,
            forceReloadWindow: true,
            forceAuthSync
          });
        }
        return existing;
      }

      const replaceLabel = 'Replace';
      const confirm = await vscode.window.showWarningMessage(
        `This account is already saved as profile "${displayProfileName(existing)}". Replace it?`,
        { modal: true },
        replaceLabel
      );
      if (confirm !== replaceLabel) {
        return null;
      }

      await profileManager.replaceProfileAuth(existing.id, authData);
      if (activate) {
        await setActiveProfileAndRefresh(existing.id, {
          reloadWindowOnSwitch,
          forceReloadWindow: true,
          forceAuthSync
        });
      }
      return existing;
    }

    const profile = await createProfileFromAuthData(profileManager, authData);
    if (activate) {
      await setActiveProfileAndRefresh(profile.id, {
        reloadWindowOnSwitch,
        forceReloadWindow,
        forceAuthSync
      });
    }
    return profile;
  };

  const openTerminalAndRun = async (sequence) => {
    let terminalEnvironment;
    try {
      terminalEnvironment = createCodexTerminalEnvironment();
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      profileManager.logger &&
        profileManager.logger.error &&
        profileManager.logger.error('Failed to resolve Codex CLI for authentication.', {
          error: message
        });
      void vscode.window.showErrorMessage(message);
      return false;
    }

    markWindowAuthChangeExpected();
    const terminal = vscode.window.createTerminal({
      name: 'Codex Re-authentication',
      env: terminalEnvironment
    });
    terminal.show();
    terminal.sendText(sequence);
    return true;
  };

  const quoteShellSingle = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;

  const createIsolatedLoginHome = () => {
    if (shouldUseWslAuthPath()) {
      const linuxHome = String(
        execFileSync(
          'wsl.exe',
          ['sh', '-lc', 'mktemp -d /tmp/codex-multitool-login.XXXXXX'],
          { encoding: 'utf8', windowsHide: true }
        )
      ).trim();
      if (!linuxHome.startsWith('/tmp/codex-multitool-login.')) {
        throw new Error(`Refusing to use unexpected WSL login directory: ${linuxHome}`);
      }
      const windowsHome = String(
        execFileSync(
          'wsl.exe',
          ['sh', '-lc', `wslpath -w ${quoteShellSingle(linuxHome)}`],
          { encoding: 'utf8', windowsHide: true }
        )
      ).trim();
      return {
        authPath: path.join(windowsHome, 'auth.json'),
        terminalName: 'Codex Login: isolated WSL profile',
        terminalEnv: undefined,
        terminalText: `wsl sh -lc "CODEX_HOME=${quoteShellSingle(linuxHome)} codex login"`,
        cleanup: () => {
          execFileSync(
            'wsl.exe',
            ['sh', '-lc', `rm -rf -- ${quoteShellSingle(linuxHome)}`],
            { windowsHide: true }
          );
        }
      };
    }

    const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-multitool-login-'));
    return {
      authPath: path.join(isolatedHome, 'auth.json'),
      terminalName: 'Codex Login: isolated profile',
      terminalEnv: createCodexTerminalEnvironment({ CODEX_HOME: isolatedHome }),
      terminalText: 'codex login',
      cleanup: () => {
        const resolved = path.resolve(isolatedHome);
        const tmpRoot = path.resolve(os.tmpdir());
        if (!resolved.startsWith(tmpRoot + path.sep)) {
          throw new Error(`Refusing to clean unexpected login directory: ${resolved}`);
        }
        fs.rmSync(resolved, { recursive: true, force: true });
      }
    };
  };

  const getFileModifiedAt = (filePath) => {
    try {
      return Math.round(fs.statSync(filePath).mtimeMs);
    } catch {
      return undefined;
    }
  };

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const waitForAuthDataFile = async (authPath, timeoutMs, options = {}) => {
    const started = Date.now();
    const requireModifiedAfter = Number(options.requireModifiedAfter) || 0;
    const intervalMs = Math.max(100, Number(options.intervalMs) || 1000);
    const stableMs = Math.max(0, Number(options.stableMs) || 250);
    const isCancelled =
      typeof options.isCancelled === 'function' ? options.isCancelled : () => false;

    while (Date.now() - started < timeoutMs) {
      if (isCancelled()) {
        return null;
      }

      const modifiedAt = getFileModifiedAt(authPath);
      if (requireModifiedAfter && (!modifiedAt || modifiedAt < requireModifiedAfter)) {
        await sleep(intervalMs);
        continue;
      }

      const authData = await loadAuthDataFromFile(authPath, profileManager.logger);
      if (authData) {
        if (stableMs > 0) {
          await sleep(stableMs);
          const afterStableModifiedAt = getFileModifiedAt(authPath);
          if (modifiedAt && afterStableModifiedAt && modifiedAt !== afterStableModifiedAt) {
            continue;
          }
        }
        return authData;
      }

      await sleep(intervalMs);
    }
    return null;
  };

  const startIsolatedCodexCliLoginFlow = async () => {
    let isolated;
    let cleanedUp = false;
    try {
      isolated = createIsolatedLoginHome();
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      void vscode.window.showErrorMessage(`Could not create isolated Codex login home: ${message}`);
      return;
    }

    const cleanupIsolatedHome = (level = 'warning') => {
      if (!isolated || cleanedUp) {
        return;
      }
      cleanedUp = true;
      try {
        isolated.cleanup();
      } catch (error) {
        const message = error && error.message ? error.message : String(error);
        if (level === 'error') {
          void vscode.window.showErrorMessage(
            `Failed to clean the isolated Codex login directory: ${message}`
          );
        } else {
          void vscode.window.showWarningMessage(
            `Failed to clean the isolated Codex login directory: ${message}`
          );
        }
      }
    };

    const terminal = vscode.window.createTerminal({
      name: isolated.terminalName,
      env: isolated.terminalEnv
    });
    terminal.show();
    terminal.sendText(isolated.terminalText);
    void vscode.window.showInformationMessage(
      'Complete the Codex login flow. This login is isolated and will not overwrite the current auth.json until the profile is saved.'
    );

    const authData = await waitForAuthDataFile(isolated.authPath, 10 * 60 * 1000);
    if (!authData) {
      cleanupIsolatedHome('warning');
      void vscode.window.showErrorMessage(
        `Isolated Codex login did not produce a valid auth.json at ${isolated.authPath}.`
      );
      return;
    }

    cleanupIsolatedHome('warning');
    const accountLabel =
      authData.email && authData.email !== 'Unknown'
        ? displayProfileEmail(authData.email)
        : 'the signed-in Codex account';
    const shouldAdd = await showAutoAddAccountPrompt(accountLabel, {
      timeoutMs: autoAddAccountTimeoutMs
    });
    if (!shouldAdd) {
      return;
    }

    const profile = await saveAuthDataAsProfile(authData, {
      activate: true,
      forceReloadWindow: true,
      forceAuthSync: true
    });
    if (!profile) {
      return;
    }

    const currentAuthMatch = await profileManager.getCurrentAuthProfileMatch();
    if (!currentAuthMatch.hasAuth || currentAuthMatch.profileId !== profile.id) {
      void vscode.window.showErrorMessage(
        `Profile "${displayProfileName(profile)}" was saved, but Codex auth.json could not be switched to it. Select the account from the switcher to retry.`
      );
      return;
    }

    profileManager.logger &&
      profileManager.logger.info &&
      profileManager.logger.info('Added and activated an account after isolated Codex login.', {
        profileId: profile.id,
        reloadedWindow: getReloadWindowAfterProfileSwitch()
      });
  };

  const importCurrentAuthAfterLogin = async (options = {}) => {
    const { targetProfileId, requireModifiedAfter } = options;
    const authPath = getDefaultCodexAuthPath(profileManager.logger);
    let authData;

    if (requireModifiedAfter) {
      authData = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Waiting for Codex login to finish...',
          cancellable: true
        },
        (_progress, token) => waitForAuthDataFile(authPath, 10 * 60 * 1000, {
          requireModifiedAfter,
          intervalMs: 1000,
          stableMs: 500,
          isCancelled: () => token.isCancellationRequested
        })
      );

      if (!authData) {
        void vscode.window.showErrorMessage(
          `Codex login did not produce a valid auth.json at ${authPath}.`
        );
        return false;
      }
    } else {
      authData = await loadAuthDataFromFile(authPath, profileManager.logger);
    }

    if (!authData) {
      void vscode.window.showErrorMessage(`Could not read auth from ${authPath}.`);
      return false;
    }

    if (!targetProfileId) {
      await vscode.commands.executeCommand('codex-switch.profile.addFromCodexAuthFile');
      return true;
    }

    const targetProfile = await profileManager.getProfile(targetProfileId);
    if (!targetProfile) {
      void vscode.window.showErrorMessage('The selected Codex profile no longer exists.');
      return false;
    }

    if (!profileManager.matchesAuth(targetProfile, authData)) {
      void vscode.window.showErrorMessage(
        `The current auth.json belongs to a different account and cannot update profile "${displayProfileName(targetProfile)}".`
      );
      return false;
    }

    await profileManager.replaceProfileAuth(targetProfileId, authData);
    await setActiveProfileAndRefresh(targetProfileId, {
      forceReloadWindow: true,
      forceAuthSync: true
    });
    void vscode.window.showInformationMessage(
      `Updated Codex profile "${displayProfileName(targetProfile)}" with the current auth.json.`
    );
    return true;
  };

  const startCodexCliLoginFlow = async (options = {}) => {
    const { targetProfileId } = options;
    const authPath = getDefaultCodexAuthPath(profileManager.logger);
    const targetProfile = targetProfileId ? await profileManager.getProfile(targetProfileId) : null;
    const startedAt = Date.now();
    const maxWaitMs = authLoginMaxWaitMs;
    let watcher;
    let done = false;

    const cleanup = () => {
      if (done) {
        return;
      }
      done = true;
      if (watcher) {
        try {
          watcher.close();
        } catch {
          // Ignore watcher cleanup failures.
        }
      }
    };

    const promptImport = async () => {
      if (done) {
        return;
      }
      cleanup();
      const importLabel = targetProfile ? 'Update profile' : 'Import';
      const message = targetProfile
        ? `Codex auth file detected at ${authPath}. Update profile "${displayProfileName(targetProfile)}" with it?`
        : `Codex auth file detected at ${authPath}. Import it as a profile?`;
      const pick = await vscode.window.showInformationMessage(message, importLabel);
      if (pick === importLabel) {
        await importCurrentAuthAfterLogin({ targetProfileId });
      }
    };

    try {
      const authDirectory = path.dirname(authPath);
      if (fs.existsSync(authDirectory)) {
        watcher = fs.watch(authDirectory, { persistent: false }, async (_event, filename) => {
          if (done) {
            return;
          }
          if (!filename || String(filename).toLowerCase() !== 'auth.json') {
            return;
          }
          if (Date.now() - startedAt > maxWaitMs) {
            cleanup();
            return;
          }
          if (fs.existsSync(authPath)) {
            const authData = await waitForAuthDataFile(authPath, 30 * 1000, {
              requireModifiedAfter: startedAt,
              intervalMs: 1000,
              stableMs: 500
            });
            if (!authData) {
              return;
            }
            await promptImport();
          }
        });
      }
    } catch {
      // Best effort only.
    }

    if (!(await openTerminalAndRun(getReauthCommandText()))) {
      cleanup();
      return;
    }

    const importNowLabel = targetProfile ? 'Update after login' : 'Import after login';
    const manageLabel = 'Manage profiles';
    const followUp = await vscode.window.showInformationMessage(
      `Complete the Codex login flow. It starts with "${getLogoutCommandText()}" to clear revoked refresh tokens, then runs "${getLoginCommandText()}".`,
      importNowLabel,
      manageLabel
    );

    if (followUp === importNowLabel) {
      cleanup();
      await importCurrentAuthAfterLogin({
        targetProfileId,
        requireModifiedAfter: startedAt
      });
    } else if (followUp === manageLabel) {
      cleanup();
      await vscode.commands.executeCommand('codex-switch.profile.manage');
    } else {
      setTimeout(() => cleanup(), maxWaitMs);
    }
  };

  const getStatusBarClickBehavior = () => {
    const behavior = vscode.workspace
      .getConfiguration('codexSwitch')
      .get('statusBarClickBehavior', 'cycle');
    return behavior === 'toggleLast' ? 'toggleLast' : 'cycle';
  };

  const loginCommand = vscode.commands.registerCommand('codex-switch.login', async () => {
    const reauthCommandText = getReauthCommandText();
    const manageLabel = 'Manage profiles';
    const openTerminalLabel = 'Open terminal';
    const copyCommandLabel = 'Copy commands';

    const selection = await vscode.window.showInformationMessage(
      `Authentication required. Add a profile or run "${getLogoutCommandText()}" and "${getLoginCommandText()}".`,
      manageLabel,
      openTerminalLabel,
      copyCommandLabel
    );

    if (selection === manageLabel) {
      await vscode.commands.executeCommand('codex-switch.profile.manage');
      return;
    }

    if (selection === openTerminalLabel) {
      await openTerminalAndRun(reauthCommandText);
      return;
    }

    if (selection === copyCommandLabel) {
      await vscode.env.clipboard.writeText(reauthCommandText);
      void vscode.window.showInformationMessage('Codex logout/login commands copied to clipboard.');
    }
  });

  const switchProfileCommand = vscode.commands.registerCommand(
    'codex-switch.profile.switch',
    async () => {
      if (!(await ensureProfileFeaturesEnabled())) {
        return;
      }

      const profiles = await profileManager.listProfiles();
      const addCurrentProfileItem = await buildAddCurrentProfileItem(profileManager);
      if (!profiles.length && !addCurrentProfileItem) {
        await vscode.commands.executeCommand('codex-switch.profile.manage');
        return;
      }

      const activeProfileId = await profileManager.getActiveProfileId();
      const profileItems = await buildProfileQuickPickItems(
        profiles,
        activeProfileId,
        profileManager
      );
      const selection = await showProfileSwitchQuickPick(
        profileItems,
        addCurrentProfileItem,
        getReloadWindowAfterProfileSwitch,
        setReloadWindowAfterProfileSwitch,
        getPostSwitchRestoreStrategy,
        getSendToCodexEnabled,
        setSendToCodexEnabled
      );

      if (!selection) {
        return;
      }

      if (selection.command) {
        await vscode.commands.executeCommand(selection.command);
        return;
      }

      if (selection.openPrivateNoteProfileId) {
        await vscode.commands.executeCommand(
          'codex-switch.profile.openPrivateNote',
          selection.openPrivateNoteProfileId
        );
        return;
      }

      const switched = await setActiveProfileAndRefresh(selection.profileId);
      if (!switched) {
        return;
      }
    }
  );

  const activateProfileCommand = vscode.commands.registerCommand(
    'codex-switch.profile.activate',
    async (profileId) => {
      if (!(await ensureProfileFeaturesEnabled())) {
        return;
      }

      if (!profileId) {
        await vscode.commands.executeCommand('codex-switch.profile.switch');
        return;
      }

      const switched = await setActiveProfileAndRefresh(profileId);
      if (switched == null) {
        return;
      }
      if (!switched) {
        const profile = await profileManager.getProfile(profileId);
        const message = profile
          ? `Failed to activate Codex profile "${displayProfileName(profile)}". Stored tokens may be missing or invalid.`
          : 'Failed to activate Codex profile because it no longer exists.';
        profileManager.logger &&
          profileManager.logger.error &&
          profileManager.logger.error(message, { profileId });
        void vscode.window.showErrorMessage(message);
        return;
      }
    }
  );

  const toggleLastProfileCommand = vscode.commands.registerCommand(
    'codex-switch.profile.toggleLast',
    async () => {
      if (!(await ensureProfileFeaturesEnabled())) {
        return;
      }

      if (getStatusBarClickBehavior() === 'toggleLast') {
        const activeProfileId = await profileManager.getActiveProfileId();
        const toggledProfileId = await profileManager.toggleLastProfileId();
        if (!toggledProfileId) {
          await vscode.commands.executeCommand('codex-switch.profile.switch');
          return;
        }
        await afterProfileSwitch({
          reloadWindow: activeProfileId !== toggledProfileId
        });
        return;
      }

      const profiles = await profileManager.listProfiles();
      if (!profiles.length) {
        await vscode.commands.executeCommand('codex-switch.profile.manage');
        return;
      }

      const activeProfileId = await profileManager.getActiveProfileId();
      const currentIndex = profiles.findIndex((profile) => profile.id === activeProfileId);
      const nextIndex = currentIndex === -1 ? 0 : (currentIndex + 1) % profiles.length;
      const switched = await setActiveProfileAndRefresh(profiles[nextIndex].id);
      if (!switched) {
        return;
      }
    }
  );

  const addFromCodexAuthFileCommand = vscode.commands.registerCommand(
    'codex-switch.profile.addFromCodexAuthFile',
    async () => {
      if (!(await ensureProfileFeaturesEnabled())) {
        return;
      }

      const authPath = getDefaultCodexAuthPath(profileManager.logger);
      const loginCommandText = getLoginCommandText();
      const authData = await loadAuthDataFromFile(authPath, profileManager.logger);
      if (!authData) {
        void vscode.window.showErrorMessage(
          `Could not read auth from ${authPath}. Run "${loginCommandText}" first.`
        );
        return;
      }

      await saveAuthDataAsProfile(authData, { activate: true });
    }
  );

  const loginViaCliCommand = vscode.commands.registerCommand(
    'codex-switch.profile.login',
    async () => {
      if (!(await ensureProfileFeaturesEnabled())) {
        return;
      }

      await startIsolatedCodexCliLoginFlow();
    }
  );

  const reauthenticateProfileCommand = vscode.commands.registerCommand(
    'codex-switch.profile.reauthenticate',
    async (profileId) => {
      if (!(await ensureProfileFeaturesEnabled())) {
        return;
      }

      const activeProfileId = await profileManager.getActiveProfileId();
      const targetProfileId = profileId || activeProfileId;
      if (!targetProfileId) {
        await startIsolatedCodexCliLoginFlow();
        return;
      }

      const targetProfile = await profileManager.getProfile(targetProfileId);
      if (!targetProfile) {
        const message = 'The selected Codex profile no longer exists.';
        profileManager.logger &&
          profileManager.logger.error &&
          profileManager.logger.error(message, { profileId: targetProfileId });
        void vscode.window.showErrorMessage(message);
        return;
      }

      const profileName = displayProfileName(targetProfile);
      const continueLabel = 'Log out and sign in';
      const selection = await vscode.window.showWarningMessage(
        `Re-authenticate profile "${profileName}"? This runs "${getLogoutCommandText()}" before "${getLoginCommandText()}" so revoked refresh tokens are cleared.`,
        { modal: true },
        continueLabel
      );
      if (selection !== continueLabel) {
        return;
      }

      await startCodexCliLoginFlow({ targetProfileId });
    }
  );

  const addFromFileCommand = vscode.commands.registerCommand(
    'codex-switch.profile.addFromFile',
    async () => {
      if (!(await ensureProfileFeaturesEnabled())) {
        return;
      }

      const uri = await vscode.window.showOpenDialog({
        canSelectMany: false,
        openLabel: 'Import auth.json',
        filters: { JSON: ['json'] }
      });
      if (!uri || !uri.length) {
        return;
      }

      const authData = await loadAuthDataFromFile(uri[0].fsPath, profileManager.logger);
      if (!authData) {
        void vscode.window.showErrorMessage('Selected file is not a valid auth.json.');
        return;
      }

      await saveAuthDataAsProfile(authData, { activate: true });
    }
  );

  const exportSettingsCommand = vscode.commands.registerCommand(
    'codex-switch.profile.exportSettings',
    async () => {
      if (!(await ensureProfileFeaturesEnabled())) {
        return;
      }

      const saveUri = await vscode.window.showSaveDialog({
        saveLabel: 'Export profiles',
        defaultUri: getDefaultSettingsExportUri(),
        filters: { JSON: ['json'] }
      });
      if (!saveUri) {
        return;
      }

      const exported = await profileManager.exportProfilesForTransfer();
      const exportMode = await vscode.window.showQuickPick(
        [
          {
            label: 'Encrypted',
            description: 'Recommended',
            detail: 'Protect profile tokens with a passphrase before writing the export file.',
            encrypted: true
          },
          {
            label: 'Plain JSON',
            description: 'Advanced',
            detail: 'Write tokens as plain JSON. Use only for local manual backups.',
            encrypted: false
          }
        ],
        { placeHolder: 'Choose export protection' }
      );
      if (!exportMode) {
        return;
      }

      let exportPayload = exported.data;
      if (exportMode.encrypted) {
        const passphrase = await promptForExportPassphrase();
        if (!passphrase) {
          return;
        }
        exportPayload = encryptTransferPayload(exportPayload, passphrase);
      }

      fs.writeFileSync(saveUri.fsPath, JSON.stringify(exportPayload, null, 2), 'utf8');
      await profileManager.appendProfileActivity('exportProfiles', {
        encrypted: Boolean(exportMode.encrypted),
        profileCount: exported.data.profiles.length,
        skipped: exported.skipped
      });

      void vscode.window.showInformationMessage(
        `Exported ${exported.data.profiles.length} profile(s) to ${saveUri.fsPath}. Skipped ${exported.skipped} profile(s) without tokens.`
      );
    }
  );

  const importSettingsCommand = vscode.commands.registerCommand(
    'codex-switch.profile.importSettings',
    async () => {
      if (!(await ensureProfileFeaturesEnabled())) {
        return;
      }

      const uri = await vscode.window.showOpenDialog({
        canSelectMany: false,
        openLabel: 'Import profiles',
        filters: { JSON: ['json'] }
      });
      if (!uri || !uri.length) {
        return;
      }

      let payload;
      try {
        payload = JSON.parse(fs.readFileSync(uri[0].fsPath, 'utf8'));
      } catch {
        void vscode.window.showErrorMessage(
          'Selected file is not a valid JSON profiles export.'
        );
        return;
      }

      if (payload && payload.format === ENCRYPTED_EXPORT_FORMAT) {
        const passphrase = await promptForImportPassphrase();
        if (!passphrase) {
          return;
        }
        try {
          payload = decryptTransferPayload(payload, passphrase);
        } catch (error) {
          const message = error && error.message ? error.message : String(error);
          void vscode.window.showErrorMessage(`Failed to decrypt profiles export: ${message}`);
          return;
        }
      }

      try {
        const result = await profileManager.importProfilesFromTransfer(payload);
        await rateLimitMonitor.refresh(true);
        await refreshProfileUi();
        await profileManager.appendProfileActivity('importProfiles', result);
        void vscode.window.showInformationMessage(
          `Import completed: created ${result.created}, updated ${result.updated}, skipped ${result.skipped}.`
        );
      } catch (error) {
        const message = error && error.message ? error.message : 'Unknown import error.';
        void vscode.window.showErrorMessage(`Failed to import profiles: ${message}`);
      }
    }
  );

  const renameProfileCommand = vscode.commands.registerCommand(
    'codex-switch.profile.rename',
    async () => {
      if (!(await ensureProfileFeaturesEnabled())) {
        return;
      }

      const profiles = await profileManager.listProfiles();
      if (!profiles.length) {
        return;
      }

      const pick = await vscode.window.showQuickPick(
        await buildProfileQuickPickItems(
          profiles,
          await profileManager.getActiveProfileId(),
          profileManager
        ),
        { placeHolder: 'Rename profile' }
      );
      if (!pick) {
        return;
      }

      const nextName = await vscode.window.showInputBox({
        prompt: 'New profile name',
        value: pick.profileName || ''
      });
      if (!nextName) {
        return;
      }

      await profileManager.renameProfile(pick.profileId, nextName);
      await profileManager.appendProfileActivity('renameProfile', {
        profileId: pick.profileId,
        oldName: pick.profileName,
        newName: nextName
      });
      await refreshProfileUi();
    }
  );

  const deleteProfileCommand = vscode.commands.registerCommand(
    'codex-switch.profile.delete',
    async () => {
      if (!(await ensureProfileFeaturesEnabled())) {
        return;
      }

      const profiles = await profileManager.listProfiles();
      if (!profiles.length) {
        return;
      }

      const pick = await vscode.window.showQuickPick(
        await buildProfileQuickPickItems(
          profiles,
          await profileManager.getActiveProfileId(),
          profileManager
        ),
        { placeHolder: 'Delete profile' }
      );
      if (!pick) {
        return;
      }

      const deleteLabel = 'Delete';
      const confirm = await vscode.window.showWarningMessage(
        `Delete profile "${displayProfileName({ id: pick.profileId, name: pick.profileName })}"? Stored tokens and its private note will also be removed.`,
        { modal: true },
        deleteLabel
      );
      if (confirm !== deleteLabel) {
        return;
      }

      const deleted = await profileManager.deleteProfile(pick.profileId);
      if (deleted) {
        ProfileNotePanel.closeForProfile(pick.profileId);
      }
      await profileManager.appendProfileActivity('deleteProfile', {
        profileId: pick.profileId,
        name: pick.profileName
      });
      await refreshProfileUi();
    }
  );

  const restoreAuthBackupCommand = vscode.commands.registerCommand(
    'codex-switch.profile.restoreAuthBackup',
    async () => {
      if (!(await ensureProfileFeaturesEnabled())) {
        return;
      }

      const backups = await profileManager.listAuthBackups();
      if (!backups.length) {
        void vscode.window.showErrorMessage(
          `No Codex auth.json backups found in ${profileManager.getAuthBackupsDir()}.`
        );
        return;
      }

      const pick = await vscode.window.showQuickPick(
        backups.map((backup) => ({
          label: backup.name,
          description: backup.email ? displayProfileEmail(backup.email) : backup.reason,
          detail: `${formatLocalDateTime(backup.createdAt)} - ${backup.path}`,
          backup
        })),
        { placeHolder: 'Restore a Codex auth.json backup' }
      );
      if (!pick) {
        return;
      }

      const restoreLabel = 'Restore';
      const confirm = await vscode.window.showWarningMessage(
        `Restore ${pick.backup.name} to the current Codex auth.json? The current auth.json will be backed up first.`,
        { modal: true },
        restoreLabel
      );
      if (confirm !== restoreLabel) {
        return;
      }

      try {
        markWindowAuthChangeExpected();
        const authData = await profileManager.restoreAuthBackup(pick.backup.path);
        await profileManager.initializeWindowActiveProfileFromCurrentAuth(true);
        await rateLimitMonitor.refresh(true);
        await refreshProfileUi();
        void vscode.window.showInformationMessage(
          `Restored Codex auth backup for ${displayProfileEmail(authData.email)}.`
        );
      } catch (error) {
        const message = error && error.message ? error.message : String(error);
        void vscode.window.showErrorMessage(`Failed to restore Codex auth backup: ${message}`);
      }
    }
  );

  const profileDoctorCommand = vscode.commands.registerCommand(
    'codex-switch.profile.doctor',
    async () => {
      if (!(await ensureProfileFeaturesEnabled())) {
        return;
      }

      const authPath = getDefaultCodexAuthPath(profileManager.logger);
      const authData = await profileManager.loadCurrentAuthData();
      const currentMatch = await profileManager.getCurrentAuthProfileMatch();
      const windowMatch = await profileManager.getWindowActiveProfileMatch();
      const activeProfileId = await profileManager.getActiveProfileId();
      const profiles = await profileManager.listProfiles();
      const activeProfile = activeProfileId
        ? profiles.find((profile) => profile.id === activeProfileId) || null
        : null;
      const matchingProfile = currentMatch.profileId
        ? profiles.find((profile) => profile.id === currentMatch.profileId) || null
        : null;
      const backups = await profileManager.listAuthBackups();
      const missingTokenProfiles = [];
      for (const profile of profiles) {
        if (!(await profileManager.hasStoredTokens(profile.id))) {
          missingTokenProfiles.push(profile);
        }
      }

      const lastRefreshResult = rateLimitMonitor.getLastRefreshResult
        ? rateLimitMonitor.getLastRefreshResult()
        : null;
      const codexExtension = vscode.extensions.getExtension('openai.chatgpt');
      const cliVersion = readCodexCliVersionForDoctor();
      const authModifiedAt = profileManager.getAuthFileModifiedAt();
      const storageMode = profileManager.getResolvedStorageMode();
      const usageMode = vscode.workspace
        .getConfiguration('codexRatelimit')
        .get('preferUsageApi', true)
        ? 'Usage API for active profile; local estimates for inactive profiles'
        : 'local estimates only; active exact limits unavailable';
      const doctorIssues = [];
      if (currentMatch.hasAuth && !currentMatch.profileId) {
        doctorIssues.push('- Current Codex auth.json belongs to an unmanaged account. Use "Add current profile".');
      }
      if (activeProfileId && currentMatch.profileId && activeProfileId !== currentMatch.profileId) {
        doctorIssues.push('- Active profile state does not match the current auth.json. Switching or restoring auth.json is recommended.');
      }
      if (!fs.existsSync(authPath)) {
        doctorIssues.push('- Codex auth.json is missing. Use isolated "Login via Codex CLI".');
      }
      if (missingTokenProfiles.length) {
        doctorIssues.push('- Some profiles have metadata but no stored tokens. Re-authenticate or import matching auth.json files.');
      }
      if (!lastRefreshResult || lastRefreshResult.outcome === 'error') {
        doctorIssues.push('- Rate-limit monitor has no fresh result. See the Last refresh line above.');
      }
      if (!doctorIssues.length) {
        doctorIssues.push('- No obvious issues were detected.');
      }

      const lines = [
        '# Codex Multitool Doctor',
        '',
        `Generated: ${formatLocalDateTime(Date.now())}`,
        '',
        '## Environment',
        `- Storage mode: ${storageMode}`,
        `- Profiles file: ${profileManager.getProfilesPath()}`,
        `- Auth path: ${authPath}`,
        `- Auth file exists: ${fs.existsSync(authPath) ? 'yes' : 'no'}`,
        `- Auth file modified: ${formatDoctorTimestamp(authModifiedAt)}`,
        `- Backups directory: ${profileManager.getAuthBackupsDir()}`,
        `- Activity log: ${profileManager.getActivityLogPath()}`,
        `- Codex CLI: ${cliVersion}`,
        `- Official Codex extension: ${codexExtension ? `installed (${codexExtension.isActive ? 'active' : 'inactive'})` : 'not installed'}`,
        '',
        '## Active Account',
        `- Active profile: ${activeProfile ? `${displayProfileName(activeProfile)} (${shortDiagnosticValue(activeProfile.id)})` : 'none'}`,
        `- Current auth account: ${authData ? `${displayProfileEmail(authData.email)}; account=${shortDiagnosticValue(authData.accountId)}; org=${shortDiagnosticValue(authData.defaultOrganizationId)}` : 'none'}`,
        `- Current auth saved as: ${matchingProfile ? `${displayProfileName(matchingProfile)} (${shortDiagnosticValue(matchingProfile.id)})` : currentMatch.hasAuth ? 'not managed' : 'n/a'}`,
        `- Window active match: ${windowMatch.profileId ? shortDiagnosticValue(windowMatch.profileId) : windowMatch.hasAuth ? 'unmanaged auth' : 'no auth'}`,
        '',
        '## Rate Limits',
        `- Usage mode: ${usageMode}`,
        `- Last refresh: ${formatRefreshDiagnostic(lastRefreshResult)}`,
        `- Last monitor error: ${rateLimitMonitor.getLastError() || 'none'}`,
        '',
        '## Profiles',
        `- Saved profiles: ${profiles.length}`,
        `- Profiles missing stored tokens: ${missingTokenProfiles.length || 'none'}`,
        ...missingTokenProfiles.map((profile) => {
          return `  - ${displayProfileName(profile)} (${shortDiagnosticValue(profile.id)})`;
        }),
        '',
        '## Backups',
        `- Auth backups: ${backups.length}`,
        ...backups.slice(0, 10).map((backup) => {
          const email = backup.email ? displayProfileEmail(backup.email) : 'unknown account';
          return `  - ${backup.name}; ${backup.reason}; ${email}; ${formatLocalDateTime(
            backup.createdAt
          )}`;
        }),
        '',
        '## Issues',
        ...doctorIssues
      ];

      const document = await vscode.workspace.openTextDocument({
        language: 'markdown',
        content: lines.join('\n')
      });
      await vscode.window.showTextDocument(document, { preview: false });
    }
  );

  const manageProfilesCommand = vscode.commands.registerCommand(
    'codex-switch.profile.manage',
    async () => {
      if (!(await ensureProfileFeaturesEnabled())) {
        return;
      }

      RateLimitDetailsPanel.createOrShow(context.extensionUri, profileManager, rateLimitMonitor);
    }
  );

  const manageBackupsCommand = vscode.commands.registerCommand(
    'codex-switch.profile.manageBackups',
    async () => {
      if (!(await ensureProfileFeaturesEnabled())) {
        return;
      }
      await profileManager.promptProfileBackupManager();
      await refreshProfileUi();
    }
  );

  const openPrivateNoteCommand = vscode.commands.registerCommand(
    'codex-switch.profile.openPrivateNote',
    async (profileId) => {
      if (!(await ensureProfileFeaturesEnabled())) {
        return;
      }

      const profile = profileId ? await profileManager.getProfile(profileId) : null;
      if (!profile) {
        void vscode.window.showErrorMessage(
          'Cannot open the private note because this Codex account no longer exists.'
        );
        return;
      }

      await ProfileNotePanel.createOrShow(profileManager, profile);
    }
  );

  const restoreStrategyCommand = vscode.commands.registerCommand(
    'codex-switch.profile.restoreStrategy',
    async () => {
      if (!(await ensureProfileFeaturesEnabled())) {
        return;
      }

      const selection = await showPostSwitchRestoreStrategyQuickPick(
        getPostSwitchRestoreStrategy()
      );
      if (!selection || !selection.strategy) {
        return;
      }

      await setPostSwitchRestoreStrategy(selection.strategy);
      const option = getPostSwitchRestoreStrategyOption(selection.strategy);
      void vscode.window.showInformationMessage(
        `Codex post-switch chat restore strategy: ${option.label}.`
      );
    }
  );

  const refreshStatsCommand = vscode.commands.registerCommand(
    'codex-ratelimit.refreshStats',
    async () => {
      if (!(await ensureProfileFeaturesEnabled())) {
        return;
      }

      await rateLimitMonitor.refresh(true);
      await refreshProfileUi();
    }
  );

  const activateUnstartedCountersCommand = vscode.commands.registerCommand(
    'codex-switch.profile.activateUnstartedCounters',
    async (commandOptions = {}) => {
      if (!(await ensureProfileFeaturesEnabled())) {
        return null;
      }

      const profiles = await profileManager.listProfiles();
      const activeProfileId = await profileManager.getActiveProfileId();
      const candidates = getUnstartedProfiles(profiles, activeProfileId);
      if (candidates.length === 0) {
        void vscode.window.showInformationMessage(
          'No Codex accounts have a rate-limit counter waiting for first use.'
        );
        return {
          started: false,
          reason: 'no-candidates',
          attempted: 0,
          succeeded: 0,
          failed: []
        };
      }

      let activationMode =
        commandOptions.mode === ACTIVATION_MODE_APP_SERVER ||
        commandOptions.mode === ACTIVATION_MODE_VSCODE_EXTENSION
          ? commandOptions.mode
          : null;
      if (!activationMode) {
        const extensionModeItem = {
          label: '$(window) Codex extension window (recommended)',
          description:
            process.platform === 'win32' ? 'Most realistic' : 'Windows only',
          detail:
            process.platform === 'win32'
              ? 'Switch accounts in an isolated VS Code window and submit тест through the official Codex extension UI.'
              : 'Precise worker-window input currently requires Windows; choose app-server on this platform.',
          mode: ACTIVATION_MODE_VSCODE_EXTENSION,
          picked: process.platform === 'win32'
        };
        const appServerModeItem = {
          label: '$(server-process) Codex app-server only',
          description: 'Direct protocol',
          detail:
            'Use a dedicated app-server process; do not open or control the official Codex chat UI.',
          mode: ACTIVATION_MODE_APP_SERVER,
          picked: process.platform !== 'win32'
        };
        const modeSelection = await vscode.window.showQuickPick(
          process.platform === 'win32'
            ? [extensionModeItem, appServerModeItem]
            : [appServerModeItem, extensionModeItem],
          {
            title: 'Choose counter activation method',
            placeHolder: 'The Codex extension window is closest to normal interactive use.',
            ignoreFocusOut: true
          }
        );
        if (!modeSelection) {
          return null;
        }
        activationMode = modeSelection.mode;
      }

      if (commandOptions.skipConfirmation !== true) {
        const continueLabel = `Activate ${candidates.length} counter(s)`;
        const methodDescription =
          activationMode === ACTIVATION_MODE_VSCODE_EXTENSION
            ? 'use the official Codex UI in that window, keep every answer visible briefly, and close only its exact editor tab'
            : 'send through Codex app-server without opening the official Codex chat UI, then archive every service thread';
        const selection = await vscode.window.showWarningMessage(
          `Open a dedicated VS Code window, switch through ${candidates.length} Codex account(s), ${methodDescription}, and restore the original account afterwards?`,
          { modal: true },
          continueLabel
        );
        if (selection !== continueLabel) {
          return null;
        }
      }

      const startedAt = Date.now();
      let result;
      try {
        result = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            cancellable: true,
            title: 'Activating Codex rate-limit counters'
          },
          async (progress, cancellationToken) => {
            return rateLimitWindowActivator.run({
              mode: activationMode,
              cancellationToken,
              onProgress: ({ profile, index, total, increment, phase }) => {
                progress.report({
                  increment,
                  message: `${index + 1}/${total}: ${displayProfileName(profile)}${
                    phase ? ` — ${phase.replace(/-/g, ' ')}` : ''
                  }`
                });
              }
            });
          }
        );
      } catch (error) {
        const completedAt = Date.now();
        const message = error && error.message ? error.message : String(error);
        const activeProfile = profiles.find(
          (profile) => profile.id === activeProfileId
        );
        const report = {
          jobId: null,
          mode: activationMode,
          modeLabel: getActivationModeLabel(activationMode),
          status: 'failed',
          phase: 'launcher-error',
          createdAt: startedAt,
          completedAt,
          durationMs: Math.max(0, completedAt - startedAt),
          attempted: candidates.length,
          succeeded: 0,
          failed: candidates.length,
          unconfirmed: 0,
          cancelled: false,
          originalProfileId: activeProfileId,
          originalProfileName: activeProfile
            ? displayProfileName(activeProfile)
            : null,
          originalAccountRestored: true,
          lastError: message,
          environment: createReportEnvironment(context),
          events: [
            {
              at: completedAt,
              phase: 'launcher-error',
              detail: message
            }
          ],
          accounts: candidates.map((profile) => ({
            profileId: profile.id,
            profileName: displayProfileName(profile),
            status: 'not-run',
            prompt: 'тест',
            archived: false,
            limitConfirmed: false
          }))
        };
        RateLimitActivationReportPanel.createOrShow(report);
        void vscode.window.showErrorMessage(
          `Codex counter activation could not start: ${message}`
        );
        return {
          started: false,
          reason: 'failed',
          attempted: candidates.length,
          succeeded: 0,
          failed: candidates.map((profile) => ({
            profileId: profile.id,
            profileName: displayProfileName(profile),
            error: message
          })),
          report
        };
      }

      await refreshProfileUi();
      if (!result) {
        return result;
      }
      if (result.report) {
        RateLimitActivationReportPanel.createOrShow(result.report);
      }

      if (result.reason === 'already-running') {
        void vscode.window.showInformationMessage(
          'Codex counter activation is already running in this VS Code window.'
        );
      } else if (result.cancelled) {
        void vscode.window.showWarningMessage(
          `Codex counter activation cancelled: ${result.succeeded}/${result.attempted} completed.`
        );
      } else if (result.reason === 'failed' || result.failed.length > 0) {
        const failedNames = result.failed
          .map((failure) => failure.profileName)
          .filter(Boolean)
          .join(', ');
        void vscode.window.showErrorMessage(
          `Codex counters activated for ${result.succeeded}/${result.attempted} account(s). Failed: ${failedNames}.`
        );
      } else if (result.unconfirmed && result.unconfirmed.length > 0) {
        const chatResult =
          activationMode === ACTIVATION_MODE_APP_SERVER
            ? 'all service threads were archived'
            : 'the official Codex editor tabs were closed after their answers';
        void vscode.window.showWarningMessage(
          `Codex answered and ${chatResult} for ${result.succeeded} account(s), but the usage API has not yet confirmed ${result.unconfirmed.length} counter(s).`
        );
      } else {
        const chatResult =
          activationMode === ACTIVATION_MODE_APP_SERVER
            ? 'Every service thread was archived'
            : 'Every answer was shown in the official extension and only its exact editor tab was closed';
        void vscode.window.showInformationMessage(
          `Codex counters activated for ${result.succeeded} account(s) in the dedicated window. ${chatResult}, and the original account was restored.`
        );
      }
      return result;
    }
  );

  const activateUnstartedCountersViaCodexExtensionCommand =
    vscode.commands.registerCommand(
      'codex-switch.profile.activateUnstartedCountersViaCodexExtension',
      async (commandOptions = {}) =>
        vscode.commands.executeCommand(
          'codex-switch.profile.activateUnstartedCounters',
          {
            ...commandOptions,
            mode: ACTIVATION_MODE_VSCODE_EXTENSION
          }
        )
    );

  const activateUnstartedCountersViaAppServerCommand =
    vscode.commands.registerCommand(
      'codex-switch.profile.activateUnstartedCountersViaAppServer',
      async (commandOptions = {}) =>
        vscode.commands.executeCommand(
          'codex-switch.profile.activateUnstartedCounters',
          {
            ...commandOptions,
            mode: ACTIVATION_MODE_APP_SERVER
          }
        )
    );

  const showDetailsCommand = vscode.commands.registerCommand(
    'codex-ratelimit.showDetails',
    async () => {
      if (!(await ensureProfileFeaturesEnabled())) {
        return;
      }

      RateLimitDetailsPanel.createOrShow(context.extensionUri, profileManager, rateLimitMonitor);
    }
  );

  const openSettingsCommand = vscode.commands.registerCommand(
    'codex-ratelimit.openSettings',
    async () => {
      await vscode.commands.executeCommand(
        'workbench.action.openSettings',
        `@ext:${context.extension.id} codexSwitch codexRatelimit`
      );
    }
  );

  context.subscriptions.push(
    loginCommand,
    switchProfileCommand,
    activateProfileCommand,
    toggleLastProfileCommand,
    addFromCodexAuthFileCommand,
    loginViaCliCommand,
    reauthenticateProfileCommand,
    addFromFileCommand,
    exportSettingsCommand,
    importSettingsCommand,
    renameProfileCommand,
    deleteProfileCommand,
    restoreAuthBackupCommand,
    profileDoctorCommand,
    manageProfilesCommand,
    manageBackupsCommand,
    openPrivateNoteCommand,
    restoreStrategyCommand,
    refreshStatsCommand,
    activateUnstartedCountersCommand,
    activateUnstartedCountersViaCodexExtensionCommand,
    activateUnstartedCountersViaAppServerCommand,
    showDetailsCommand,
    openSettingsCommand
  );
}

module.exports = {
  buildProfileSortPickerItems,
  buildSwitchQuickPickItems,
  getDefaultSettingsExportUri,
  registerProfileCommands,
  showAutoAddAccountPrompt,
  showProfileSwitchQuickPick
};
