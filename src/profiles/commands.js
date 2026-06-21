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
  getProfileRateStatus,
  isProfileWeeklyTokensLow,
  sortProfilesForDisplay
} = require('./profileStatus');
const { RateLimitDetailsPanel } = require('./webview');
const {
  displayProfileEmail,
  displayProfileName
} = require('./privacy');

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

async function buildProfileQuickPickItems(profiles, activeProfileId, profileManager) {
  const now = Date.now();
  const sortedProfiles = sortProfilesForDisplay(profiles, activeProfileId, now);
  return Promise.all(sortedProfiles.map(async (profile) => {
    const status = getProfileRateStatus(profile, now, { activeProfileId });
    const descriptionParts = [];
    const authState = await getProfileAuthState(profileManager, profile.id);
    const isActive = profile.id === activeProfileId;
    const weeklyTokensLow = isProfileWeeklyTokensLow(profile, now, { activeProfileId });

    if (isActive) {
      descriptionParts.push('ACTIVE PROFILE');
    }
    if (weeklyTokensLow) {
      descriptionParts.push('W < 5%');
    }
    if (authState.description) {
      descriptionParts.push(authState.description);
    }
    descriptionParts.push(formatPlanType(profile.planType));
    if (profile.email && profile.email !== 'Unknown') {
      descriptionParts.push(displayProfileEmail(profile.email));
    }

    const summary = formatCompactRateSummary(status, now, {
      includePrimaryCountdown: true,
      includeSecondaryCountdown: true,
      percentageMode: 'remaining'
    });
    const estimateSuffix = status.isEstimatedRateLimitData ? ' • estimate' : '';

    return {
      label: displayProfileName(profile),
      description: descriptionParts.length ? descriptionParts.join(' • ') : undefined,
      detail: authState.hasIssue
        ? `${isActive ? 'Currently selected • ' : ''}Restore the matching auth.json for this account`
        : `${isActive ? 'Currently selected • ' : ''}${summary}${estimateSuffix}`,
      profileId: profile.id,
      profileName: profile.name,
      isActive,
      iconPath: weeklyTokensLow
        ? new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('disabledForeground'))
        : undefined,
      weeklyTokensLow,
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
  return new Date(numeric).toLocaleString();
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
    label: '$(settings-gear) More profile actions...',
    detail: 'Open the full profile management menu.',
    command: 'codex-switch.profile.manage'
  };
}

function buildSwitchQuickPickItems(
  profileItems,
  addCurrentProfileItem,
  reloadEnabled,
  restoreStrategy,
  sendToCodexEnabled
) {
  const items = [];
  const activeItems = profileItems.filter((item) => item.isActive);
  const inactiveItems = profileItems.filter((item) => !item.isActive);

  if (activeItems.length > 0) {
    items.push({
      label: 'Active profile',
      kind: vscode.QuickPickItemKind.Separator
    });
    items.push(...activeItems);
  }

  if (inactiveItems.length > 0) {
    items.push({
      label: activeItems.length > 0 ? 'Other profiles' : 'Saved profiles',
      kind: vscode.QuickPickItemKind.Separator
    });
    items.push(...inactiveItems);
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

    const finish = (selection) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(selection);
      quickPick.hide();
    };

    const rebuildItems = () => {
      const items = buildSwitchQuickPickItems(
        profileItems,
        addCurrentProfileItem,
        getReloadEnabled(),
        getRestoreStrategy(),
        getSendToCodexEnabled()
      );
      quickPick.items = items;

      const activeProfileItem = items.find((item) => item && item.isActive);
      if (activeProfileItem) {
        quickPick.activeItems = [activeProfileItem];
      }
    };

    quickPick.title = 'Codex Multitool';
    quickPick.placeholder = 'Switch profile';
    quickPick.matchOnDescription = true;
    quickPick.matchOnDetail = true;
    rebuildItems();

    quickPick.onDidAccept(async () => {
      const selection = quickPick.selectedItems[0];
      if (!selection) {
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
    const { reloadWindowOnSwitch = true, forceReloadWindow = false } = options;
    const previousProfileId = await profileManager.getActiveProfileId();
    const changedProfile = previousProfileId !== profileId;
    const shouldReloadWindow = reloadWindowOnSwitch && (changedProfile || forceReloadWindow);
    if (profileId && (changedProfile || forceReloadWindow)) {
      markWindowAuthChangeExpected({ profileId });
    }
    const switched = await profileManager.setActiveProfileId(profileId);
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

  const saveAuthDataAsProfile = async (authData, options = {}) => {
    const { activate = true, reloadWindowOnSwitch = true, forceReloadWindow = false } = options;
    const existing = await profileManager.findDuplicateProfile(authData);
    if (existing) {
      const existingHasTokens = await profileManager.hasStoredTokens(existing.id);
      if (!existingHasTokens) {
        await profileManager.replaceProfileAuth(existing.id, authData);
        if (activate) {
          await setActiveProfileAndRefresh(existing.id, {
            reloadWindowOnSwitch,
            forceReloadWindow: true
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
          forceReloadWindow: true
        });
      }
      return existing;
    }

    const profile = await createProfileFromAuthData(profileManager, authData);
    if (activate) {
      await setActiveProfileAndRefresh(profile.id, {
        reloadWindowOnSwitch,
        forceReloadWindow
      });
    }
    return profile;
  };

  const openTerminalAndRun = async (sequence) => {
    markWindowAuthChangeExpected();
    await vscode.commands.executeCommand('workbench.action.terminal.new');
    setTimeout(() => {
      void vscode.commands.executeCommand('workbench.action.terminal.sendSequence', {
        text: sequence.endsWith('\n') ? sequence : `${sequence}\n`
      });
    }, 500);
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
      terminalEnv: { CODEX_HOME: isolatedHome },
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
    const profile = await saveAuthDataAsProfile(authData, { activate: true });
    if (!profile) {
      return;
    }
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
      reloadWindowOnSwitch: true,
      forceReloadWindow: true
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
    const maxWaitMs = 10 * 60 * 1000;
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

    await openTerminalAndRun(getReauthCommandText());

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

  const getDefaultSettingsExportUri = () => {
    const workspacePath = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0]
      ? vscode.workspace.workspaceFolders[0].uri.fsPath
      : os.homedir();
    return vscode.Uri.file(path.join(workspacePath, 'codex-switch-profiles.json'));
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
      if (!switched) {
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
    async () => {
      if (!(await ensureProfileFeaturesEnabled())) {
        return;
      }

      const activeProfileId = await profileManager.getActiveProfileId();
      if (!activeProfileId) {
        await startIsolatedCodexCliLoginFlow();
        return;
      }

      const activeProfile = await profileManager.getProfile(activeProfileId);
      const profileName = activeProfile ? displayProfileName(activeProfile) : activeProfileId;
      const continueLabel = 'Log out and sign in';
      const selection = await vscode.window.showWarningMessage(
        `Re-authenticate profile "${profileName}"? This runs "${getLogoutCommandText()}" before "${getLoginCommandText()}" so revoked refresh tokens are cleared.`,
        { modal: true },
        continueLabel
      );
      if (selection !== continueLabel) {
        return;
      }

      await startCodexCliLoginFlow({ targetProfileId: activeProfileId });
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
        `Delete profile "${displayProfileName({ id: pick.profileId, name: pick.profileName })}"?`,
        { modal: true },
        deleteLabel
      );
      if (confirm !== deleteLabel) {
        return;
      }

      await profileManager.deleteProfile(pick.profileId);
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
          detail: `${backup.createdAt} - ${backup.path}`,
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
        `Generated: ${new Date().toLocaleString()}`,
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
          return `  - ${backup.name}; ${backup.reason}; ${email}; ${backup.createdAt}`;
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

      const authPath = getDefaultCodexAuthPath(profileManager.logger);
      const profiles = await profileManager.listProfiles();
      const hasProfiles = profiles.length > 0;
      const addCurrentProfileItem = await buildAddCurrentProfileItem(profileManager);
      const disableSendToCodexItem = buildSendToCodexToggleItem(getSendToCodexEnabled());

      const action = await vscode.window.showQuickPick(
        [
          {
            label: 'Login via Codex CLI (isolated)...',
            detail: 'Sign in with a temporary CODEX_HOME, then save the new auth.json as a profile.',
            command: 'codex-switch.profile.login'
          },
          ...(hasProfiles
            ? [
                {
                  label: 'Re-authenticate active profile...',
                  detail: 'Clear revoked refresh tokens with codex logout, then sign in again.',
                  command: 'codex-switch.profile.reauthenticate'
                }
              ]
            : []),
          ...(hasProfiles
            ? [
                {
                  label: 'Switch profile',
                  command: 'codex-switch.profile.switch'
                }
              ]
            : []),
          {
            label: 'Show rate limit details',
            command: 'codex-ratelimit.showDetails'
          },
          {
            label: 'Profile doctor',
            detail: 'Open a diagnostics report for active auth, profiles, backups, and rate-limit source.',
            command: 'codex-switch.profile.doctor'
          },
          {
            label: 'Refresh rate limits',
            command: 'codex-ratelimit.refreshStats'
          },
          {
            label: 'Post-switch chat restore strategy...',
            detail: getPostSwitchRestoreStrategyOption(getPostSwitchRestoreStrategy()).detail,
            command: 'codex-switch.profile.restoreStrategy'
          },
          disableSendToCodexItem,
          ...(addCurrentProfileItem
            ? [
                {
                  label: addCurrentProfileItem.label,
                  description: addCurrentProfileItem.description || authPath,
                  detail: addCurrentProfileItem.detail,
                  command: addCurrentProfileItem.command
                }
              ]
            : []),
          {
            label: 'Import from file...',
            command: 'codex-switch.profile.addFromFile'
          },
          {
            label: 'Restore auth.json backup...',
            command: 'codex-switch.profile.restoreAuthBackup'
          },
          {
            label: 'Export profiles...',
            command: 'codex-switch.profile.exportSettings'
          },
          {
            label: 'Import profiles...',
            command: 'codex-switch.profile.importSettings'
          },
          ...(hasProfiles
            ? [
                {
                  label: 'Rename profile',
                  command: 'codex-switch.profile.rename'
                },
                {
                  label: 'Delete profile',
                  command: 'codex-switch.profile.delete'
                }
              ]
            : [])
        ],
        { placeHolder: 'Manage profiles' }
      );

      if (!action) {
        return;
      }

      if (action.sendToggle) {
        await setSendToCodexEnabled(!getSendToCodexEnabled());
        await vscode.commands.executeCommand('codex-switch.profile.manage');
        return;
      }

      await vscode.commands.executeCommand(action.command);
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
    restoreStrategyCommand,
    refreshStatsCommand,
    showDetailsCommand,
    openSettingsCommand
  );
}

module.exports = {
  registerProfileCommands
};
