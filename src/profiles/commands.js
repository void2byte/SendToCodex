'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const vscode = require('vscode');
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
const { areProfileFeaturesEnabled } = require('./featureFlags');
const {
  formatCompactRateSummary,
  formatPlanType,
  getProfileRateStatus,
  isProfileWeeklyTokensLow,
  sortProfilesForDisplay
} = require('./profileStatus');
const { RateLimitDetailsPanel } = require('./webview');

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
    const status = getProfileRateStatus(profile, now);
    const descriptionParts = [];
    const authState = await getProfileAuthState(profileManager, profile.id);
    const isActive = profile.id === activeProfileId;
    const weeklyTokensLow = isProfileWeeklyTokensLow(profile, now);

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
      descriptionParts.push(profile.email);
    }

    return {
      label: profile.name,
      description: descriptionParts.length ? descriptionParts.join(' • ') : undefined,
      detail: authState.hasIssue
        ? `${isActive ? 'Currently selected • ' : ''}Restore the matching auth.json for this account`
        : `${isActive ? 'Currently selected • ' : ''}${formatCompactRateSummary(status, now, {
            includePrimaryCountdown: true,
            includeSecondaryCountdown: true,
            percentageMode: 'remaining'
          })}`,
      profileId: profile.id,
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
        description: activeProfile.name,
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
      description: existing.name,
      detail: 'Store tokens from the current ~/.codex/auth.json for this saved profile',
      command: 'codex-switch.profile.addFromCodexAuthFile'
    };
  }

  const description =
    authData.email && authData.email !== 'Unknown'
      ? authData.email
      : getDefaultCodexAuthPath(profileManager.logger);

  return {
    label: '$(add) Add current profile',
    description,
    detail: 'Save the current ~/.codex/auth.json as a managed profile',
    command: 'codex-switch.profile.addFromCodexAuthFile'
  };
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

  const maybeReloadWindowAfterProfileSwitch = async () => {
    if (getReloadWindowAfterProfileSwitch()) {
      await vscode.commands.executeCommand('workbench.action.reloadWindow');
    }
  };

  const afterProfileSwitch = async (options = {}) => {
    const { reloadWindow = true } = options;

    await rateLimitMonitor.refresh(true);
    await refreshProfileUi();
    if (reloadWindow) {
      await maybeReloadWindowAfterProfileSwitch();
    }
  };

  const setActiveProfileAndRefresh = async (profileId, options = {}) => {
    const { reloadWindowOnSwitch = true } = options;
    const previousProfileId = await profileManager.getActiveProfileId();
    const changedProfile = previousProfileId !== profileId;
    const switched = await profileManager.setActiveProfileId(profileId);
    if (!switched) {
      return false;
    }

    await onProfileSwitchCommitted(profileId, {
      changedProfile,
      willReloadWindow:
        reloadWindowOnSwitch && changedProfile && getReloadWindowAfterProfileSwitch()
    });
    await afterProfileSwitch({
      reloadWindow: reloadWindowOnSwitch && changedProfile
    });
    return true;
  };

  const getLoginCommandText = () => (shouldUseWslAuthPath() ? 'wsl codex login' : 'codex login');
  const getLogoutCommandText = () => (shouldUseWslAuthPath() ? 'wsl codex logout' : 'codex logout');
  const getReauthCommandText = () => `${getLogoutCommandText()}\n${getLoginCommandText()}`;

  const openTerminalAndRun = async (sequence) => {
    markWindowAuthChangeExpected();
    await vscode.commands.executeCommand('workbench.action.terminal.new');
    setTimeout(() => {
      void vscode.commands.executeCommand('workbench.action.terminal.sendSequence', {
        text: sequence.endsWith('\n') ? sequence : `${sequence}\n`
      });
    }, 500);
  };

  const importCurrentAuthAfterLogin = async (options = {}) => {
    const { targetProfileId, requireModifiedAfter } = options;
    const authPath = getDefaultCodexAuthPath(profileManager.logger);
    const authModifiedAt = profileManager.getAuthFileModifiedAt();

    if (
      requireModifiedAfter &&
      authModifiedAt &&
      authModifiedAt < requireModifiedAfter
    ) {
      void vscode.window.showWarningMessage(
        `The Codex auth file at ${authPath} has not changed since this login flow started. Finish the browser login first, then import again.`
      );
      return false;
    }

    const authData = await loadAuthDataFromFile(authPath, profileManager.logger);
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
        `The current auth.json belongs to a different account and cannot update profile "${targetProfile.name}".`
      );
      return false;
    }

    await profileManager.replaceProfileAuth(targetProfileId, authData);
    await setActiveProfileAndRefresh(targetProfileId, { reloadWindowOnSwitch: false });
    void vscode.window.showInformationMessage(
      `Updated Codex profile "${targetProfile.name}" with the current auth.json.`
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
        ? `Codex auth file detected at ${authPath}. Update profile "${targetProfile.name}" with it?`
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

      const windowActive = await profileManager.getWindowActiveProfileMatch();
      if (windowActive.profileId) {
        const activeProfile = await profileManager.getProfile(windowActive.profileId);
        if (activeProfile && !profileManager.matchesAuth(activeProfile, authData)) {
          void vscode.window.showInformationMessage(
            `This window is still using "${activeProfile.name}". Switch or reload this window before importing the current auth.json.`
          );
          return;
        }
      }

      const existing = await profileManager.findDuplicateProfile(authData);
      if (existing) {
        const existingHasTokens = await profileManager.hasStoredTokens(existing.id);
        if (!existingHasTokens) {
          await profileManager.replaceProfileAuth(existing.id, authData);
          await setActiveProfileAndRefresh(existing.id, { reloadWindowOnSwitch: false });
          return;
        }

        const replaceLabel = 'Replace';
        const confirm = await vscode.window.showWarningMessage(
          `This account is already saved as profile "${existing.name}". Replace it?`,
          { modal: true },
          replaceLabel
        );
        if (confirm !== replaceLabel) {
          return;
        }

        await profileManager.replaceProfileAuth(existing.id, authData);
        await setActiveProfileAndRefresh(existing.id, { reloadWindowOnSwitch: false });
        return;
      }

      const defaultName =
        authData.email && authData.email !== 'Unknown'
          ? authData.email.split('@')[0]
          : 'profile';
      const name = await vscode.window.showInputBox({
        prompt: 'Profile name (for example "work" or "personal")',
        value: defaultName
      });
      if (!name) {
        return;
      }

      const profile = await profileManager.createProfile(name, authData);
      await setActiveProfileAndRefresh(profile.id, { reloadWindowOnSwitch: false });
    }
  );

  const loginViaCliCommand = vscode.commands.registerCommand(
    'codex-switch.profile.login',
    async () => {
      if (!(await ensureProfileFeaturesEnabled())) {
        return;
      }

      await startCodexCliLoginFlow();
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
        await startCodexCliLoginFlow();
        return;
      }

      const activeProfile = await profileManager.getProfile(activeProfileId);
      const profileName = activeProfile ? activeProfile.name : activeProfileId;
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

      const existing = await profileManager.findDuplicateProfile(authData);
      if (existing) {
        const existingHasTokens = await profileManager.hasStoredTokens(existing.id);
        if (!existingHasTokens) {
          await profileManager.replaceProfileAuth(existing.id, authData);
          await setActiveProfileAndRefresh(existing.id, { reloadWindowOnSwitch: false });
          return;
        }

        const replaceLabel = 'Replace';
        const confirm = await vscode.window.showWarningMessage(
          `This account is already saved as profile "${existing.name}". Replace it?`,
          { modal: true },
          replaceLabel
        );
        if (confirm !== replaceLabel) {
          return;
        }

        await profileManager.replaceProfileAuth(existing.id, authData);
        await setActiveProfileAndRefresh(existing.id, { reloadWindowOnSwitch: false });
        return;
      }

      const defaultName =
        authData.email && authData.email !== 'Unknown'
          ? authData.email.split('@')[0]
          : 'profile';
      const name = await vscode.window.showInputBox({
        prompt: 'Profile name',
        value: defaultName
      });
      if (!name) {
        return;
      }

      const profile = await profileManager.createProfile(name, authData);
      await setActiveProfileAndRefresh(profile.id, { reloadWindowOnSwitch: false });
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
      fs.writeFileSync(saveUri.fsPath, JSON.stringify(exported.data, null, 2), 'utf8');

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

      try {
        const result = await profileManager.importProfilesFromTransfer(payload);
        await rateLimitMonitor.refresh(true);
        await refreshProfileUi();
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
        value: pick.label.replace(/\s+\$\([^)]+\)$/u, '')
      });
      if (!nextName) {
        return;
      }

      await profileManager.renameProfile(pick.profileId, nextName);
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
        `Delete profile "${pick.label.replace(/\s+\$\([^)]+\)$/u, '')}"?`,
        { modal: true },
        deleteLabel
      );
      if (confirm !== deleteLabel) {
        return;
      }

      await profileManager.deleteProfile(pick.profileId);
      await refreshProfileUi();
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
            label: 'Login via Codex CLI...',
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
            label: 'Refresh rate limits',
            command: 'codex-ratelimit.refreshStats'
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
    manageProfilesCommand,
    refreshStatsCommand,
    showDetailsCommand,
    openSettingsCommand
  );
}

module.exports = {
  registerProfileCommands
};
