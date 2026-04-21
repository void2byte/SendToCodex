'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const vscode = require('vscode');
const {
  getDefaultCodexAuthPath,
  loadAuthDataFromFile,
  shouldUseWslAuthPath
} = require('./authManager');
const { formatCompactRateSummary, getProfileRateStatus } = require('./profileStatus');
const { RateLimitDetailsPanel } = require('./webview');

async function buildProfileQuickPickItems(profiles, activeProfileId, profileManager) {
  return Promise.all(profiles.map(async (profile) => {
    const status = getProfileRateStatus(profile);
    const descriptionParts = [];
    const hasTokens = await profileManager.hasStoredTokens(profile.id);

    if (profile.email && profile.email !== 'Unknown') {
      descriptionParts.push(profile.email);
    }
    if (profile.id === activeProfileId) {
      descriptionParts.push('Active');
    }
    if (!hasTokens) {
      descriptionParts.push('Auth required');
    }

    return {
      label: `${profile.name} ${hasTokens ? status.icon : '$(warning)'}`,
      description: descriptionParts.length ? descriptionParts.join(' • ') : undefined,
      detail: hasTokens
        ? formatCompactRateSummary(status, Date.now(), {
            includePrimaryCountdown: true,
            includeSecondaryCountdown: true,
            percentageMode: 'remaining'
          })
        : 'Restore the matching auth.json for this account',
      profileId: profile.id
    };
  }));
}

async function buildAddCurrentProfileItem(profileManager) {
  const authData = await profileManager.loadCurrentAuthData();
  if (!authData) {
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

function buildSwitchQuickPickItems(profileItems, addCurrentProfileItem, reloadEnabled) {
  const items = [...profileItems];

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
      label: 'Apply changes',
      kind: vscode.QuickPickItemKind.Separator
    },
    buildReloadWindowToggleItem(reloadEnabled)
  );

  return items;
}

function showProfileSwitchQuickPick(
  profileItems,
  addCurrentProfileItem,
  getReloadEnabled,
  setReloadEnabled
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
      quickPick.items = buildSwitchQuickPickItems(
        profileItems,
        addCurrentProfileItem,
        getReloadEnabled()
      );
    };

    quickPick.title = 'Codex Switch';
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
  refreshProfileUi
) {
  const getReloadWindowAfterProfileSwitch = () => Boolean(
    vscode.workspace
      .getConfiguration('codexSwitch')
      .get('reloadWindowAfterProfileSwitch', false)
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

  const maybeReloadWindowAfterProfileSwitch = async () => {
    if (getReloadWindowAfterProfileSwitch()) {
      await vscode.commands.executeCommand('workbench.action.reloadWindow');
    }
  };

  const afterProfileSwitch = async () => {
    await rateLimitMonitor.refresh(true);
    await refreshProfileUi();
    await maybeReloadWindowAfterProfileSwitch();
  };

  const getLoginCommandText = () => (shouldUseWslAuthPath() ? 'wsl codex login' : 'codex login');

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
    const loginCommandText = getLoginCommandText();
    const manageLabel = 'Manage profiles';
    const openTerminalLabel = 'Open terminal';
    const copyCommandLabel = 'Copy command';

    const selection = await vscode.window.showInformationMessage(
      `Authentication required. Add a profile or run "${loginCommandText}".`,
      manageLabel,
      openTerminalLabel,
      copyCommandLabel
    );

    if (selection === manageLabel) {
      await vscode.commands.executeCommand('codex-switch.profile.manage');
      return;
    }

    if (selection === openTerminalLabel) {
      await vscode.commands.executeCommand('workbench.action.terminal.new');
      setTimeout(() => {
        void vscode.commands.executeCommand('workbench.action.terminal.sendSequence', {
          text: `${loginCommandText}\n`
        });
      }, 500);
      return;
    }

    if (selection === copyCommandLabel) {
      await vscode.env.clipboard.writeText(loginCommandText);
      void vscode.window.showInformationMessage(`Command "${loginCommandText}" copied to clipboard.`);
    }
  });

  const switchProfileCommand = vscode.commands.registerCommand(
    'codex-switch.profile.switch',
    async () => {
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
        setReloadWindowAfterProfileSwitch
      );

      if (!selection) {
        return;
      }

      if (selection.command) {
        await vscode.commands.executeCommand(selection.command);
        return;
      }

      const switched = await profileManager.setActiveProfileId(selection.profileId);
      if (!switched) {
        return;
      }

      await afterProfileSwitch();
    }
  );

  const activateProfileCommand = vscode.commands.registerCommand(
    'codex-switch.profile.activate',
    async (profileId) => {
      if (!profileId) {
        await vscode.commands.executeCommand('codex-switch.profile.switch');
        return;
      }

      const switched = await profileManager.setActiveProfileId(profileId);
      if (!switched) {
        return;
      }

      await afterProfileSwitch();
    }
  );

  const toggleLastProfileCommand = vscode.commands.registerCommand(
    'codex-switch.profile.toggleLast',
    async () => {
      if (getStatusBarClickBehavior() === 'toggleLast') {
        const toggledProfileId = await profileManager.toggleLastProfileId();
        if (!toggledProfileId) {
          await vscode.commands.executeCommand('codex-switch.profile.switch');
          return;
        }
        await afterProfileSwitch();
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
      const switched = await profileManager.setActiveProfileId(profiles[nextIndex].id);
      if (!switched) {
        return;
      }
      await afterProfileSwitch();
    }
  );

  const addFromCodexAuthFileCommand = vscode.commands.registerCommand(
    'codex-switch.profile.addFromCodexAuthFile',
    async () => {
      const authPath = getDefaultCodexAuthPath(profileManager.logger);
      const loginCommandText = getLoginCommandText();
      const authData = await loadAuthDataFromFile(authPath, profileManager.logger);
      if (!authData) {
        void vscode.window.showErrorMessage(
          `Could not read auth from ${authPath}. Run "${loginCommandText}" first.`
        );
        return;
      }

      const existing = await profileManager.findDuplicateProfile(authData);
      if (existing) {
        const existingHasTokens = await profileManager.hasStoredTokens(existing.id);
        if (!existingHasTokens) {
          await profileManager.replaceProfileAuth(existing.id, authData);
          await profileManager.setActiveProfileId(existing.id);
          await afterProfileSwitch();
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
        await profileManager.setActiveProfileId(existing.id);
        await afterProfileSwitch();
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
      await profileManager.setActiveProfileId(profile.id);
      await afterProfileSwitch();
    }
  );

  const loginViaCliCommand = vscode.commands.registerCommand(
    'codex-switch.profile.login',
    async () => {
      const authPath = getDefaultCodexAuthPath(profileManager.logger);
      const loginSequence = `${getLoginCommandText()}\n`;

      await vscode.commands.executeCommand('workbench.action.terminal.new');
      setTimeout(() => {
        void vscode.commands.executeCommand('workbench.action.terminal.sendSequence', {
          text: loginSequence
        });
      }, 500);

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
        cleanup();
        const importLabel = 'Import';
        const pick = await vscode.window.showInformationMessage(
          `Codex auth file detected at ${authPath}. Import it as a profile?`,
          importLabel
        );
        if (pick === importLabel) {
          await vscode.commands.executeCommand('codex-switch.profile.addFromCodexAuthFile');
        }
      };

      try {
        const authDirectory = path.dirname(authPath);
        if (fs.existsSync(authDirectory)) {
          watcher = fs.watch(authDirectory, { persistent: false }, async (_event, filename) => {
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

      const importNowLabel = 'Import now';
      const manageLabel = 'Manage profiles';
      const followUp = await vscode.window.showInformationMessage(
        `After completing the login flow, import the current environment auth.json from ${authPath} as a profile.`,
        importNowLabel,
        manageLabel
      );

      if (followUp === importNowLabel) {
        cleanup();
        await vscode.commands.executeCommand('codex-switch.profile.addFromCodexAuthFile');
      } else if (followUp === manageLabel) {
        cleanup();
        await vscode.commands.executeCommand('codex-switch.profile.manage');
      } else {
        setTimeout(() => cleanup(), maxWaitMs);
      }
    }
  );

  const addFromFileCommand = vscode.commands.registerCommand(
    'codex-switch.profile.addFromFile',
    async () => {
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
          await profileManager.setActiveProfileId(existing.id);
          await afterProfileSwitch();
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
        await profileManager.setActiveProfileId(existing.id);
        await afterProfileSwitch();
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
      await profileManager.setActiveProfileId(profile.id);
      await afterProfileSwitch();
    }
  );

  const exportSettingsCommand = vscode.commands.registerCommand(
    'codex-switch.profile.exportSettings',
    async () => {
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
      const authPath = getDefaultCodexAuthPath(profileManager.logger);
      const profiles = await profileManager.listProfiles();
      const hasProfiles = profiles.length > 0;
      const addCurrentProfileItem = await buildAddCurrentProfileItem(profileManager);

      const action = await vscode.window.showQuickPick(
        [
          {
            label: 'Login via Codex CLI...',
            command: 'codex-switch.profile.login'
          },
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

      await vscode.commands.executeCommand(action.command);
    }
  );

  const refreshStatsCommand = vscode.commands.registerCommand(
    'codex-ratelimit.refreshStats',
    async () => {
      await rateLimitMonitor.refresh(true);
      await refreshProfileUi();
    }
  );

  const showDetailsCommand = vscode.commands.registerCommand(
    'codex-ratelimit.showDetails',
    async () => {
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
