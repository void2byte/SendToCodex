'use strict';

const fs = require('fs');
const path = require('path');
const vscode = require('vscode');
const {
  formatAbsoluteTimestamp,
  formatResetText,
  getCompactPrimaryWindowLabel,
  getPlanSortRank,
  getProfileRateStatus,
  getWindowRemainingPercent,
  getWindowLabel,
  isProfileWeeklyTokensLow,
  normalizeLowRemainingPercentThreshold,
  sortProfilesForDisplay
} = require('./profileStatus');
const { formatTokenUsage } = require('./rateLimitParser');
const { displayProfileEmail, displayProfileName } = require('./privacy');
const { ProfileNotePanel } = require('./profileNotePanel');
const {
  MIN_PORTABLE_PROFILE_VAULT_PASSWORD_LENGTH
} = require('./portableProfileVaultStore');
const { showPaidLimitResetPrompt } = require('./paidLimitResetPrompt');
const { generateDetectedTotpCodes } = require('./totp');
const {
  compareDisplayText,
  formatLocalDateTime
} = require('../ui/userFormatting');
const {
  PROFILE_QUICK_PICK_SECTIONS,
  PROFILE_QUICK_PICK_SECONDARY_SORT_OPTIONS,
  PROFILE_QUICK_PICK_SORT_OPTIONS,
  formatLowRemainingPercentThreshold,
  getProfileQuickPickSectionLabel,
  getProfileQuickPickSettings,
  isProfileQuickPickSectionVisible,
  normalizeHiddenSections,
  normalizeSecondaryProfileSort,
  normalizeProfileSort,
  normalizeSectionOrder
} = require('./quickPickSettings');

const UNGROUPED_PROFILE_GROUP = 'Ungrouped';
const CUSTOM_GROUP_VALUE = '__custom_group__';
const DEFAULT_PROFILE_GROUPS = [
  'Personal',
  'Work',
  'Pro',
  'Free',
  'Backup',
  'Test',
  'Broken',
  'Disposable',
  UNGROUPED_PROFILE_GROUP
];

const WEBVIEW_COMMANDS = {
  addCurrent: 'codex-switch.profile.addFromCodexAuthFile',
  addFromFile: 'codex-switch.profile.addFromFile',
  doctor: 'codex-switch.profile.doctor',
  exportProfiles: 'codex-switch.profile.exportSettings',
  importProfiles: 'codex-switch.profile.importSettings',
  login: 'codex-switch.profile.login',
  manageBackups: 'codex-switch.profile.manageBackups',
  refreshStats: 'codex-ratelimit.refreshStats',
  restoreBackup: 'codex-switch.profile.restoreAuthBackup',
  restoreStrategy: 'codex-switch.profile.restoreStrategy',
  settings: 'codex-ratelimit.openSettings',
  switchProfile: 'codex-switch.profile.switch'
};

function asNonEmptyString(value) {
  if (typeof value !== 'string') {
    return undefined;
  }

  const normalized = value.trim();
  return normalized ? normalized : undefined;
}

function normalizeProfileGroup(value) {
  return asNonEmptyString(value) || UNGROUPED_PROFILE_GROUP;
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeScriptJson(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function getErrorMessage(error) {
  return error && error.message ? error.message : String(error);
}

function formatRefreshResult(result) {
  if (!result) {
    return 'n/a';
  }

  const parts = [`${result.source || 'unknown'} / ${result.outcome || 'unknown'}`];
  if (result.sourceFile) {
    parts.push(String(result.sourceFile));
  }
  if (result.error) {
    parts.push(String(result.error));
  }
  if (result.timestamp) {
    parts.push(formatLocalDateTime(result.timestamp));
  }
  return parts.join(' - ');
}

function hasRequiredStoredTokens(tokens) {
  if (!tokens || typeof tokens !== 'object') {
    return false;
  }

  return ['idToken', 'accessToken', 'refreshToken'].every((key) => {
    return typeof tokens[key] === 'string' && tokens[key].trim();
  });
}

function isPaidProfileWithRateLimits(profile) {
  const planType = String((profile && profile.planType) || '').trim().toLowerCase();
  return Boolean(
    planType &&
      planType !== 'unknown' &&
      !planType.includes('free') &&
      profile &&
      profile.rateLimitState &&
      (profile.rateLimitState.primary || profile.rateLimitState.secondary)
  );
}

function formatWindowRemaining(windowState, now) {
  if (!windowState) {
    return 'n/a';
  }

  if (!windowState.resetAt || windowState.resetAt <= now) {
    return '100%';
  }

  const remaining = Math.max(0, Math.min(100, 100 - Number(windowState.usedPercent || 0)));
  return `${Math.round(remaining)}%`;
}

function formatWindowCell(windowState, now) {
  if (!windowState) {
    return 'n/a';
  }

  if (windowState.unstarted) {
    return '100% remaining - starts on first use';
  }

  const resetText = formatResetText(windowState.resetAt, now);
  return `${formatWindowRemaining(windowState, now)} remaining - ${
    resetText === 'Ready' ? 'window ready' : resetText.toLowerCase()
  }`;
}

function getOperationalStatus(profile, status, authState, weeklyTokensLow, activeProfileId) {
  if (authState.hasIssue) {
    return 'Auth required';
  }

  if (status.cooldownActive) {
    return 'Limit exhausted';
  }

  if (status.windowNotStarted) {
    return 'Window not started';
  }

  if (weeklyTokensLow) {
    return 'Weekly low';
  }

  if (profile.id === activeProfileId) {
    return 'Active';
  }

  if (!status.observedAt) {
    return 'No data';
  }

  if (status.isEstimatedRateLimitData) {
    return 'Stale / estimate';
  }

  return 'Available';
}

function isProblemAccount(viewModel) {
  return Boolean(
    viewModel.authIssue ||
      viewModel.weeklyLow ||
      viewModel.operationalStatus === 'Limit exhausted' ||
      viewModel.operationalStatus === 'No data' ||
      viewModel.operationalStatus === 'Stale / estimate'
  );
}

function sortUniqueStrings(values) {
  return [...new Set(values.map((value) => normalizeProfileGroup(value)))]
    .filter(Boolean)
    .sort(compareDisplayText);
}

function formatWindowChip(windowState, now) {
  if (!windowState) {
    return 'n/a';
  }
  const remaining = formatWindowRemaining(windowState, now);
  if (windowState.unstarted) {
    return `${remaining} · unused`;
  }
  const resetText = formatResetText(windowState.resetAt, now);
  const compactReset = resetText
    .replace(/^reset\s+in\s+/i, '')
    .replace(/^resets?\s+in\s+/i, '')
    .replace(/^ready$/i, 'ready');
  return `${remaining} · ${compactReset}`;
}

class RateLimitDetailsPanel {
  static createOrShow(extensionUri, profileManager, rateLimitMonitor) {
    const column = vscode.window.activeTextEditor
      ? vscode.window.activeTextEditor.viewColumn
      : vscode.ViewColumn.One;

    if (RateLimitDetailsPanel.currentPanel) {
      RateLimitDetailsPanel.currentPanel.panel.reveal(column);
      void RateLimitDetailsPanel.currentPanel.update();
      return RateLimitDetailsPanel.currentPanel;
    }

    const panel = vscode.window.createWebviewPanel(
      'codexRateLimitDetails',
      'Codex Accounts',
      column || vscode.ViewColumn.One,
      { enableScripts: true, localResourceRoots: [extensionUri] }
    );

    RateLimitDetailsPanel.currentPanel = new RateLimitDetailsPanel(
      panel,
      profileManager,
      rateLimitMonitor
    );
    return RateLimitDetailsPanel.currentPanel;
  }

  constructor(panel, profileManager, rateLimitMonitor) {
    this.panel = panel;
    this.profileManager = profileManager;
    this.rateLimitMonitor = rateLimitMonitor;
    this.disposables = [];
    this.hasRendered = false;
    this.updateRequested = false;
    this.updateInFlight = null;

    this.disposables.push(
      this.panel.onDidDispose(() => this.dispose()),
      this.panel.webview.onDidReceiveMessage((message) => {
        void this.handleMessage(message);
      }),
      this.profileManager.onDidChange(() => {
        void this.update();
      }),
      this.rateLimitMonitor.onDidChange(() => {
        void this.update();
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (
          event.affectsConfiguration('codexSwitch.profileQuickPick.hiddenSections') ||
          event.affectsConfiguration('codexSwitch.profileQuickPick.sectionOrder') ||
          event.affectsConfiguration('codexSwitch.profileQuickPick.profileSort') ||
          event.affectsConfiguration('codexSwitch.profileQuickPick.secondaryProfileSort') ||
          event.affectsConfiguration('codexSwitch.profileQuickPick.roundLowWeeklyRemainingToZero') ||
          event.affectsConfiguration('codexSwitch.profileQuickPick.lowWeeklyRemainingZeroThreshold')
        ) {
          void this.update();
        }
      })
    );

    void this.update();
  }

  dispose() {
    RateLimitDetailsPanel.currentPanel = undefined;
    while (this.disposables.length > 0) {
      const disposable = this.disposables.pop();
      if (disposable) {
        disposable.dispose();
      }
    }
  }

  log(level, message, data) {
    if (this.profileManager.logger && typeof this.profileManager.logger[level] === 'function') {
      this.profileManager.logger[level](message, data);
    }
  }

  reportOperationError(operation, error) {
    const message = getErrorMessage(error);
    this.log('error', `Codex Accounts: ${operation} failed.`, { error: message });
    void vscode.window.showErrorMessage(`Codex Accounts: ${operation} failed: ${message}`);
  }

  async handleMessage(message) {
    try {
      await this.dispatchMessage(message);
    } catch (error) {
      this.reportOperationError('webview action', error);
      await this.update();
    }
  }

  async dispatchMessage(message) {
    if (!message || typeof message !== 'object') {
      throw new Error('Received an invalid Codex Accounts webview message.');
    }

    switch (message.command) {
      case 'ready':
        await this.update();
        return;
      case 'refresh':
        await this.rateLimitMonitor.refresh(true);
        await this.update();
        return;
      case 'resetPaidProfileLimits':
        await this.resetPaidProfileLimits();
        return;
      case 'activateUnstartedCounters':
        await vscode.commands.executeCommand(
          'codex-switch.profile.activateUnstartedCounters',
          {
            skipConfirmation: true,
            source: 'account-manager'
          }
        );
        await this.update();
        return;
      case 'openCommand':
        await this.runWhitelistedCommand(message.action);
        await this.update();
        return;
      case 'activateProfile':
        await this.ensureProfileExists(message.profileId);
        await vscode.commands.executeCommand('codex-switch.profile.activate', message.profileId);
        await this.update();
        return;
      case 'openPrivateNote':
        await this.ensureProfileExists(message.profileId);
        await vscode.commands.executeCommand(
          'codex-switch.profile.openPrivateNote',
          message.profileId
        );
        return;
      case 'requestPrivateNotePreview':
        await this.sendPrivateNotePreview(message.profileId, message.requestId);
        return;
      case 'savePrivateNotePreview':
        await this.savePrivateNotePreview(
          message.profileId,
          message.value,
          message.requestId
        );
        return;
      case 'copyPrivateNoteLine':
        await this.copyPrivateNoteLine(
          message.profileId,
          message.value,
          message.requestId
        );
        return;
      case 'savePrivateNoteTotp':
        await this.savePrivateNoteTotp(
          message.profileId,
          message.value,
          message.requestId
        );
        return;
      case 'clearPrivateNoteTotp':
        await this.clearPrivateNoteTotp(message.profileId, message.requestId);
        return;
      case 'requestPrivateNoteTotp':
        await this.sendPrivateNoteTotp(message.profileId, message.requestId);
        return;
      case 'copyPrivateNoteTotp':
        await this.copyPrivateNoteTotp(message.profileId, message.requestId);
        return;
      case 'requestPrivateNoteDetectedTotp':
        await this.sendPrivateNoteDetectedTotp(
          message.profileId,
          message.value,
          message.requestId
        );
        return;
      case 'reauthenticateProfile':
        await this.ensureProfileExists(message.profileId);
        await vscode.commands.executeCommand(
          'codex-switch.profile.reauthenticate',
          message.profileId
        );
        await this.update();
        return;
      case 'renameProfile':
        await this.renameProfile(message.profileId);
        return;
      case 'setProfileGroup':
        await this.setProfileGroupForProfiles([message.profileId], message.group);
        return;
      case 'promptProfileGroup':
        await this.promptProfileGroup([message.profileId]);
        return;
      case 'promptSelectedGroup':
        await this.promptProfileGroup(message.profileIds);
        return;
      case 'deleteProfile':
        await this.deleteProfiles([message.profileId]);
        return;
      case 'deleteSelectedProfiles':
        await this.deleteProfiles(message.profileIds);
        return;
      case 'setQuickPickSectionVisibility':
        await this.setQuickPickSectionVisibility(message.sectionId, message.visible);
        return;
      case 'moveQuickPickSection':
        await this.moveQuickPickSection(message.sectionId, message.direction);
        return;
      case 'setQuickPickProfileSort':
        await this.setQuickPickProfileSort(message.sortMode);
        return;
      case 'setQuickPickSecondaryProfileSort':
        await this.setQuickPickSecondaryProfileSort(message.sortMode);
        return;
      case 'setRoundLowWeeklyRemainingToZero':
        await this.setRoundLowWeeklyRemainingToZero(message.enabled);
        return;
      case 'setLowWeeklyRemainingZeroThreshold':
        await this.setLowWeeklyRemainingZeroThreshold(message.threshold);
        return;
      case 'enablePortableProfileVault':
        await this.enablePortableProfileVault();
        return;
      case 'importPortableProfileVault':
        await this.importPortableProfileVault(message.keepSynchronized === true);
        return;
      case 'syncPortableProfileVault':
        await this.syncPortableProfileVault();
        return;
      case 'changePortableProfileVaultPassword':
        await this.changePortableProfileVaultPassword();
        return;
      case 'disablePortableProfileVault':
        await this.disablePortableProfileVault();
        return;
      case 'openPortableProfileVaultFolder':
        await this.openPortableProfileVaultFolder();
        return;
      default:
        throw new Error(`Unsupported Codex Accounts webview command: ${message.command}`);
    }
  }

  async updateCodexSwitchConfiguration(key, value) {
    await vscode.workspace
      .getConfiguration('codexSwitch')
      .update(key, value, vscode.ConfigurationTarget.Global);
  }

  async setQuickPickSectionVisibility(sectionId, visible) {
    const knownSectionIds = PROFILE_QUICK_PICK_SECTIONS.map((section) => section.id);
    if (!knownSectionIds.includes(sectionId)) {
      throw new Error(`Unsupported account switcher group: ${sectionId}`);
    }

    const settings = getProfileQuickPickSettings();
    const hiddenSections = new Set(settings.hiddenSections);
    if (visible === true) {
      hiddenSections.delete(sectionId);
    } else {
      hiddenSections.add(sectionId);
    }

    await this.updateCodexSwitchConfiguration(
      'profileQuickPick.hiddenSections',
      normalizeHiddenSections([...hiddenSections])
    );
    await this.update();
  }

  async moveQuickPickSection(sectionId, direction) {
    const settings = getProfileQuickPickSettings();
    const sectionOrder = normalizeSectionOrder(settings.sectionOrder);
    const index = sectionOrder.indexOf(sectionId);
    if (index === -1) {
      throw new Error(`Unsupported account switcher group: ${sectionId}`);
    }

    const delta = direction === 'up' ? -1 : direction === 'down' ? 1 : 0;
    if (!delta) {
      throw new Error(`Unsupported account switcher group move direction: ${direction}`);
    }

    const nextIndex = index + delta;
    if (nextIndex < 0 || nextIndex >= sectionOrder.length) {
      return;
    }

    const nextOrder = [...sectionOrder];
    const [item] = nextOrder.splice(index, 1);
    nextOrder.splice(nextIndex, 0, item);
    await this.updateCodexSwitchConfiguration('profileQuickPick.sectionOrder', nextOrder);
    await this.update();
  }

  async setQuickPickProfileSort(sortMode) {
    const normalized = normalizeProfileSort(sortMode);
    await this.updateCodexSwitchConfiguration('profileQuickPick.profileSort', normalized);
    await this.update();
  }

  async setQuickPickSecondaryProfileSort(sortMode) {
    const normalized = normalizeSecondaryProfileSort(sortMode);
    await this.updateCodexSwitchConfiguration(
      'profileQuickPick.secondaryProfileSort',
      normalized
    );
    await this.update();
  }

  async setRoundLowWeeklyRemainingToZero(enabled) {
    await this.updateCodexSwitchConfiguration(
      'profileQuickPick.roundLowWeeklyRemainingToZero',
      enabled === true
    );
    await this.update();
  }

  async setLowWeeklyRemainingZeroThreshold(threshold) {
    await this.updateCodexSwitchConfiguration(
      'profileQuickPick.lowWeeklyRemainingZeroThreshold',
      normalizeLowRemainingPercentThreshold(threshold)
    );
    await this.update();
  }

  async runWhitelistedCommand(action) {
    const command = WEBVIEW_COMMANDS[action];
    if (!command) {
      throw new Error(`Unsupported Codex Accounts action: ${action}`);
    }

    await vscode.commands.executeCommand(command);
  }

  async ensureProfileExists(profileId) {
    const normalizedProfileId = asNonEmptyString(profileId);
    if (!normalizedProfileId) {
      throw new Error('Profile id is required.');
    }

    const profile = await this.profileManager.getProfile(normalizedProfileId);
    if (!profile) {
      throw new Error('The selected Codex profile no longer exists.');
    }

    return profile;
  }

  async sendPrivateNotePreview(profileId, requestId) {
    await this.ensureProfileExists(profileId);
    const [note, totp] = await Promise.all([
      this.profileManager.readProfilePrivateNote(profileId),
      this.profileManager.getProfileTotpCode(profileId)
    ]);
    await this.panel.webview.postMessage({
      command: 'privateNotePreview',
      profileId,
      requestId,
      note,
      totp
    });
  }

  async savePrivateNotePreview(profileId, value, requestId) {
    await this.ensureProfileExists(profileId);
    if (typeof value !== 'string') {
      throw new Error('Private account note text is required.');
    }
    await this.profileManager.writeProfilePrivateNote(profileId, value);
    await this.panel.webview.postMessage({
      command: 'privateNoteSaved',
      profileId,
      requestId
    });
  }

  async copyPrivateNoteLine(profileId, value, requestId) {
    await this.ensureProfileExists(profileId);
    if (typeof value !== 'string') {
      throw new Error('Private account note line is required.');
    }
    if (value.length > 262144) {
      throw new Error('Private account note line is too large to copy.');
    }
    await vscode.env.clipboard.writeText(value);
    await this.panel.webview.postMessage({
      command: 'privateNoteLineCopied',
      profileId,
      requestId
    });
  }

  async savePrivateNoteTotp(profileId, value, requestId) {
    await this.ensureProfileExists(profileId);
    if (typeof value !== 'string') {
      throw new Error('A 2FA secret or otpauth:// URI is required.');
    }
    await this.profileManager.writeProfileTotpConfiguration(profileId, value);
    const totp = await this.profileManager.getProfileTotpCode(profileId);
    await this.panel.webview.postMessage({
      command: 'privateNoteTotpUpdated',
      profileId,
      requestId,
      totp
    });
  }

  async clearPrivateNoteTotp(profileId, requestId) {
    await this.ensureProfileExists(profileId);
    await this.profileManager.deleteProfileTotpConfiguration(profileId);
    await this.panel.webview.postMessage({
      command: 'privateNoteTotpUpdated',
      profileId,
      requestId,
      totp: { configured: false }
    });
  }

  async sendPrivateNoteTotp(profileId, requestId) {
    await this.ensureProfileExists(profileId);
    const totp = await this.profileManager.getProfileTotpCode(profileId);
    await this.panel.webview.postMessage({
      command: 'privateNoteTotpUpdated',
      profileId,
      requestId,
      totp
    });
  }

  async copyPrivateNoteTotp(profileId, requestId) {
    await this.ensureProfileExists(profileId);
    const totp = await this.profileManager.getProfileTotpCode(profileId);
    if (!totp.configured || !totp.code) {
      throw new Error('2FA is not configured for this account.');
    }
    await vscode.env.clipboard.writeText(totp.code);
    await this.panel.webview.postMessage({
      command: 'privateNoteTotpCopied',
      profileId,
      requestId,
      totp
    });
  }

  async sendPrivateNoteDetectedTotp(profileId, value, requestId) {
    await this.ensureProfileExists(profileId);
    if (typeof value !== 'string' || value.length > 262144) {
      throw new Error('Private account note text is invalid.');
    }
    await this.panel.webview.postMessage({
      command: 'privateNoteDetectedTotp',
      profileId,
      requestId,
      detections: generateDetectedTotpCodes(value)
    });
  }

  async getProfilesByIds(profileIds) {
    const ids = [...new Set((profileIds || []).map(asNonEmptyString).filter(Boolean))];
    if (!ids.length) {
      throw new Error('No Codex profiles were selected.');
    }

    const profiles = await this.profileManager.listProfiles();
    const byId = new Map(profiles.map((profile) => [profile.id, profile]));
    const missing = ids.filter((id) => !byId.has(id));
    if (missing.length) {
      throw new Error(`Selected Codex profile no longer exists: ${missing.join(', ')}`);
    }

    return ids.map((id) => byId.get(id));
  }

  async renameProfile(profileId) {
    const profile = await this.ensureProfileExists(profileId);
    const nextName = await vscode.window.showInputBox({
      prompt: 'New profile name',
      value: profile.name || '',
      validateInput: (value) => (asNonEmptyString(value) ? null : 'Profile name is required.')
    });

    if (nextName === undefined) {
      return;
    }

    const normalizedName = asNonEmptyString(nextName);
    if (!normalizedName) {
      throw new Error('Profile name is required.');
    }

    const updated = await this.profileManager.renameProfile(profile.id, normalizedName);
    if (!updated) {
      throw new Error(`Failed to rename profile "${displayProfileName(profile)}".`);
    }

    await this.profileManager.appendProfileActivity('renameProfile', {
      profileId: profile.id,
      oldName: profile.name,
      newName: normalizedName
    });
    void vscode.window.showInformationMessage(
      `Renamed Codex profile "${displayProfileName({ ...profile, name: normalizedName })}".`
    );
    await this.update();
  }

  getProfileGroupChoices(profiles) {
    return sortUniqueStrings([
      ...DEFAULT_PROFILE_GROUPS,
      ...profiles.map((profile) => profile.group)
    ]);
  }

  async promptProfileGroup(profileIds) {
    const selectedProfiles = await this.getProfilesByIds(profileIds);
    const allProfiles = await this.profileManager.listProfiles();
    const groupChoices = this.getProfileGroupChoices(allProfiles);

    const customLabel = 'Custom group...';
    const pick = await vscode.window.showQuickPick(
      [
        ...groupChoices.map((group) => ({
          label: selectedProfiles.every((profile) => normalizeProfileGroup(profile.group) === group)
            ? `$(check) ${group}`
            : group,
          group
        })),
        {
          label: customLabel,
          group: CUSTOM_GROUP_VALUE
        }
      ],
      {
        placeHolder:
          selectedProfiles.length === 1
            ? 'Set account group'
            : `Set group for ${selectedProfiles.length} accounts`
      }
    );

    if (!pick) {
      await this.update();
      return;
    }

    let group = pick.group;
    if (group === CUSTOM_GROUP_VALUE) {
      const value = await vscode.window.showInputBox({
        prompt: 'Group name',
        validateInput: (inputValue) => (asNonEmptyString(inputValue) ? null : 'Group name is required.')
      });
      if (value === undefined) {
        await this.update();
        return;
      }
      group = value;
    }

    await this.setProfileGroupForProfiles(
      selectedProfiles.map((profile) => profile.id),
      group
    );
  }

  async setProfileGroupForProfiles(profileIds, groupName) {
    const group = normalizeProfileGroup(groupName);
    const selectedProfiles = await this.getProfilesByIds(profileIds);

    for (const profile of selectedProfiles) {
      const updated = await this.profileManager.setProfileGroup(profile.id, group);
      if (!updated) {
        throw new Error(`Failed to set group for profile "${displayProfileName(profile)}".`);
      }
      await this.profileManager.appendProfileActivity('setProfileGroup', {
        profileId: profile.id,
        name: profile.name,
        group
      });
    }

    void vscode.window.showInformationMessage(
      selectedProfiles.length === 1
        ? `Moved "${displayProfileName(selectedProfiles[0])}" to group "${group}".`
        : `Moved ${selectedProfiles.length} Codex profiles to group "${group}".`
    );
    await this.update();
  }

  async deleteProfiles(profileIds) {
    const selectedProfiles = await this.getProfilesByIds(profileIds);
    const names = selectedProfiles.map((profile) => displayProfileName(profile));
    const deleteLabel =
      selectedProfiles.length === 1
        ? 'Delete account'
        : `Delete ${selectedProfiles.length} accounts`;
    const confirm = await vscode.window.showWarningMessage(
      `Delete ${selectedProfiles.length} Codex profile(s)? This removes profile metadata, stored tokens, and private notes. It does not delete the current ~/.codex/auth.json.\n\n${names.join('\n')}`,
      { modal: true },
      deleteLabel
    );

    if (confirm !== deleteLabel) {
      return;
    }

    if (selectedProfiles.length > 1) {
      const expected = `DELETE ${selectedProfiles.length} ACCOUNTS`;
      const typed = await vscode.window.showInputBox({
        prompt: `Type ${expected} to confirm bulk deletion`
      });
      if (typed === undefined) {
        return;
      }
      if (typed !== expected) {
        throw new Error('Bulk deletion confirmation did not match.');
      }
    }

    for (const profile of selectedProfiles) {
      const deleted = await this.profileManager.deleteProfile(profile.id);
      if (!deleted) {
        throw new Error(`Failed to delete profile "${displayProfileName(profile)}".`);
      }
      ProfileNotePanel.closeForProfile(profile.id);
      await this.profileManager.appendProfileActivity('deleteProfile', {
        profileId: profile.id,
        name: profile.name,
        group: profile.group
      });
    }

    void vscode.window.showInformationMessage(
      selectedProfiles.length === 1
        ? `Deleted Codex profile "${names[0]}".`
        : `Deleted ${selectedProfiles.length} Codex profiles.`
    );
    await this.update();
  }

  async promptPortableProfileVaultPassword(prompt) {
    return vscode.window.showInputBox({
      prompt,
      password: true,
      ignoreFocusOut: true,
      validateInput: (value) =>
        value && value.length >= MIN_PORTABLE_PROFILE_VAULT_PASSWORD_LENGTH
          ? undefined
          : `Use at least ${MIN_PORTABLE_PROFILE_VAULT_PASSWORD_LENGTH} characters.`
    });
  }

  async promptNewPortableProfileVaultPassword() {
    const password = await this.promptPortableProfileVaultPassword(
      'Password for the portable Codex profile vault'
    );
    if (password === undefined) {
      return undefined;
    }
    const confirmation = await this.promptPortableProfileVaultPassword(
      'Repeat the portable profile vault password'
    );
    if (confirmation === undefined) {
      return undefined;
    }
    if (password !== confirmation) {
      throw new Error('Portable profile vault passwords do not match.');
    }
    return password;
  }

  async enablePortableProfileVault() {
    const password = await this.promptNewPortableProfileVaultPassword();
    if (password === undefined) {
      return;
    }
    const result = await this.profileManager.enablePortableProfileVault(password);
    void vscode.window.showInformationMessage(
      `Automatic encrypted profile vault sync is enabled for ${result.profileCount} profile(s).`
    );
    await this.update();
  }

  async importPortableProfileVault(keepSynchronized) {
    const password = await this.promptPortableProfileVaultPassword(
      'Password for the detected portable Codex profile vault'
    );
    if (password === undefined) {
      return;
    }
    const result = await this.profileManager.importPortableProfileVault(password, {
      keepSynchronized
    });
    void vscode.window.showInformationMessage(
      `Portable vault import completed: created ${result.created}, updated ${result.updated}.` +
        (keepSynchronized ? ' Automatic sync is enabled.' : '')
    );
    await this.update();
  }

  async syncPortableProfileVault() {
    const result = await this.profileManager.syncPortableProfileVault('manual');
    if (!result.synced) {
      throw new Error(result.error || 'Portable profile vault was not synchronized.');
    }
    void vscode.window.showInformationMessage(
      `Synchronized ${result.profileCount} profile(s) to the encrypted portable vault.`
    );
    await this.update();
  }

  async changePortableProfileVaultPassword() {
    const password = await this.promptNewPortableProfileVaultPassword();
    if (password === undefined) {
      return;
    }
    const result = await this.profileManager.changePortableProfileVaultPassword(password);
    void vscode.window.showInformationMessage(
      `Changed the portable profile vault password for ${result.profileCount} profile(s).`
    );
    await this.update();
  }

  async disablePortableProfileVault() {
    const confirmation = await vscode.window.showWarningMessage(
      'Stop automatically synchronizing the encrypted portable profile vault? The vault file will be kept.',
      { modal: true },
      'Stop automatic sync'
    );
    if (confirmation !== 'Stop automatic sync') {
      return;
    }
    await this.profileManager.disablePortableProfileVault();
    void vscode.window.showInformationMessage(
      'Automatic portable profile vault sync is disabled. The encrypted file was kept.'
    );
    await this.update();
  }

  async openPortableProfileVaultFolder() {
    const vaultPath = this.profileManager.getPortableProfileVaultPath();
    const target = fs.existsSync(vaultPath) ? vaultPath : path.dirname(vaultPath);
    await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(target));
  }

  async resetPaidProfileLimits() {
    if (typeof this.profileManager.resetPaidProfileRateLimits !== 'function') {
      throw new Error('Paid-account rate-limit reset is not available.');
    }

    const profiles = await this.profileManager.listProfiles();
    const paidProfileCount = profiles.filter(isPaidProfileWithRateLimits).length;
    if (paidProfileCount === 0) {
      await this.update();
      return;
    }

    const prompt = await showPaidLimitResetPrompt({
      title: `Reset ${paidProfileCount} paid Codex account(s)`,
      placeHolder:
        'Optionally select automatic counter activation, then press Enter to clear usage and reset times. Esc cancels.'
    });
    if (!prompt.confirmed) {
      return;
    }

    const resetAt = Date.now();
    const resetProfileCount = await this.profileManager.resetPaidProfileRateLimits(resetAt);
    await this.profileManager.appendProfileActivity('resetPaidProfileRateLimits', {
      resetAt,
      profileCount: resetProfileCount,
      activateAfterReset: prompt.activateAfterReset
    });
    if (prompt.activateAfterReset) {
      await vscode.commands.executeCommand(
        'codex-switch.profile.activateUnstartedCounters',
        {
          skipConfirmation: true,
          source: 'manual-limit-reset'
        }
      );
    }
    await this.update();
  }

  renderWindow(windowState, fallbackLabel, now) {
    if (!windowState) {
      return '';
    }

    const label = getWindowLabel(windowState, fallbackLabel);
    const resetAt = windowState.resetAt ? formatAbsoluteTimestamp(windowState.resetAt) : 'n/a';
    const usedPercent = Math.max(0, Math.min(100, Number(windowState.usedPercent || 0)));
    const remainingPercent = Math.max(0, 100 - usedPercent);
    const resetText = windowState.resetAt ? formatResetText(windowState.resetAt, now) : 'Ready';
    const status =
      windowState.unstarted
        ? 'Window not started - starts on first use'
        : usedPercent >= 100 && resetText !== 'Ready'
        ? `Limit exhausted - ${resetText.toLowerCase()}`
        : resetText === 'Ready'
          ? 'Available'
          : `Available - window ${resetText.toLowerCase()}`;

    return `
      <div class="window-card">
        <div class="window-title">${escapeHtml(label)}</div>
        <div class="window-line"><strong>Used:</strong> ${usedPercent.toFixed(1)}%</div>
        <div class="window-line"><strong>Remaining:</strong> ${remainingPercent.toFixed(1)}%</div>
        <div class="window-line"><strong>Status:</strong> ${escapeHtml(status)}</div>
        <div class="window-line"><strong>Reset at:</strong> ${escapeHtml(
          windowState.unstarted ? 'Starts on first use' : resetAt
        )}</div>
      </div>
    `;
  }

  async buildProfileViewModels(profiles, activeProfileId, now) {
    const quickPickSettings = getProfileQuickPickSettings();
    const lowWeeklyOptions = {
      activeProfileId,
      lowRemainingPercentThreshold: quickPickSettings.lowWeeklyRemainingZeroThreshold
    };
    const sortedProfiles = sortProfilesForDisplay(profiles, activeProfileId, now, lowWeeklyOptions);

    return Promise.all(sortedProfiles.map(async (profile, index) => {
      const status = getProfileRateStatus(profile, now, { activeProfileId });
      const weeklyTokensLow = isProfileWeeklyTokensLow(profile, now, lowWeeklyOptions);
      const tokens = await this.profileManager.readStoredTokens(profile.id);
      const authState = hasRequiredStoredTokens(tokens)
        ? {
            hasIssue: false,
            description: 'Stored'
          }
        : {
            hasIssue: true,
            description: tokens ? 'Auth issue' : 'Auth required'
          };
      const operationalStatus = getOperationalStatus(
        profile,
        status,
        authState,
        weeklyTokensLow,
        activeProfileId
      );
      const viewModel = {
        id: profile.id,
        index,
        name: displayProfileName(profile),
        rawName: profile.name || '',
        email: displayProfileEmail(profile.email || 'Unknown'),
        plan: status.planText || 'Unknown',
        planRank: getPlanSortRank(status.planText),
        profileGroup: normalizeProfileGroup(profile.group),
        active: profile.id === activeProfileId,
        windowNotStarted: status.windowNotStarted,
        weeklyLow: weeklyTokensLow,
        authIssue: authState.hasIssue,
        authStatus: authState.description,
        operationalStatus,
        statusText: status.compactText,
        fiveHourText: formatWindowCell(status.primary, now),
        fiveHourCompactText: formatWindowChip(status.primary, now),
        primaryWindowLabel: getCompactPrimaryWindowLabel(status, now),
        weeklyText: formatWindowCell(status.secondary, now),
        weeklyCompactText: formatWindowChip(status.secondary, now),
        fiveHourRemaining: getWindowRemainingPercent(status.primary, now),
        weeklyRemaining: getWindowRemainingPercent(status.secondary, now),
        cooldownUntilText: status.cooldownUntil
          ? formatAbsoluteTimestamp(status.cooldownUntil)
          : 'n/a',
        observedAtText: status.observedAt ? formatAbsoluteTimestamp(status.observedAt) : 'n/a',
        observedAt: status.observedAt || 0,
        sourceText: status.isEstimatedRateLimitData
          ? `${status.sourceType || 'unknown'} estimate`
          : status.sourceType || 'n/a',
        isEstimatedRateLimitData: status.isEstimatedRateLimitData,
        hasFreshUsageApiData: status.hasFreshUsageApiData
      };
      viewModel.problem = isProblemAccount(viewModel);
      return viewModel;
    }));
  }

  renderCurrentAuthSummary(currentAuthData, currentMatch, profilesById) {
    if (!currentMatch || !currentMatch.hasAuth) {
      return `
        <div class="summary-card">
          <div class="section-title">Current auth.json</div>
          <div class="muted">No readable Codex auth.json account.</div>
          <div class="card-actions">
            <button data-action="open-command" data-command-action="login">Login</button>
            <button data-action="open-command" data-command-action="restoreBackup">Restore auth</button>
          </div>
        </div>
      `;
    }

    const matchedProfile = currentMatch.profileId ? profilesById.get(currentMatch.profileId) : null;
    const accountLabel = currentAuthData && currentAuthData.email
      ? displayProfileEmail(currentAuthData.email)
      : 'Unknown account';

    if (matchedProfile) {
      return `
        <div class="summary-card">
          <div class="section-title">Current auth.json</div>
          <div class="metric-main">${escapeHtml(displayProfileName(matchedProfile))}</div>
          <div class="muted">${escapeHtml(accountLabel)} - managed account</div>
        </div>
      `;
    }

    return `
      <div class="summary-card warning-card">
        <div class="section-title">Current auth.json</div>
        <div class="metric-main">Unmanaged account</div>
        <div class="muted">${escapeHtml(accountLabel)}</div>
        <div class="card-actions">
          <button data-action="open-command" data-command-action="addCurrent">Add current</button>
          <button data-action="open-command" data-command-action="doctor">Doctor</button>
        </div>
      </div>
    `;
  }

  renderStatsCards(profileViews) {
    const availableCount = profileViews.filter(
      (profile) => profile.operationalStatus === 'Available'
    ).length;
    const problemCount = profileViews.filter((profile) => profile.problem).length;
    const authIssueCount = profileViews.filter((profile) => profile.authIssue).length;
    const weeklyLowCount = profileViews.filter((profile) => profile.weeklyLow).length;

    return `
      <div class="stats-grid">
        <div class="stat-card">
          <div class="stat-value">${profileViews.length}</div>
          <div class="stat-label">Accounts</div>
        </div>
        <div class="stat-card">
          <div class="stat-value">${availableCount}</div>
          <div class="stat-label">Available</div>
        </div>
        <div class="stat-card${problemCount ? ' warning-card' : ''}">
          <div class="stat-value">${problemCount}</div>
          <div class="stat-label">Needs attention</div>
        </div>
        <div class="stat-card${authIssueCount ? ' danger-card' : ''}">
          <div class="stat-value">${authIssueCount}</div>
          <div class="stat-label">Auth issues</div>
        </div>
        <div class="stat-card${weeklyLowCount ? ' warning-card' : ''}">
          <div class="stat-value">${weeklyLowCount}</div>
          <div class="stat-label">Weekly low</div>
        </div>
      </div>
    `;
  }

  renderTokenUsage(lastObservation, lastRefreshResult, activeProfile) {
    if (!lastObservation || !activeProfile) {
      return '';
    }

    return `
      <div class="summary-card">
        <div class="section-title">Token usage</div>
        <div class="window-line"><strong>Total:</strong> ${escapeHtml(
          formatTokenUsage(lastObservation.totalUsage)
        )}</div>
        <div class="window-line"><strong>Last:</strong> ${escapeHtml(
          formatTokenUsage(lastObservation.lastUsage)
        )}</div>
        <div class="window-line"><strong>Source:</strong> ${escapeHtml(
          lastObservation.filePath ||
            (lastRefreshResult && lastRefreshResult.source === 'usageApi'
              ? 'Usage API'
              : 'n/a')
        )}</div>
      </div>
    `;
  }

  renderQuickPickSettings(quickPickSettings) {
    const sectionRows = quickPickSettings.sectionOrder.map((sectionId, index) => {
      const visible = isProfileQuickPickSectionVisible(quickPickSettings, sectionId);
      const label = getProfileQuickPickSectionLabel(sectionId);
      return `
        <div class="settings-row">
          <label class="checkbox-label">
            <input
              type="checkbox"
              data-quickpick-section="${escapeHtml(sectionId)}"
              ${visible ? 'checked' : ''}
            >
            ${escapeHtml(label)}
          </label>
          <div class="settings-row-actions">
            <button
              class="secondary"
              data-action="quickpick-section-up"
              data-section-id="${escapeHtml(sectionId)}"
              ${index === 0 ? 'disabled' : ''}
            >Up</button>
            <button
              class="secondary"
              data-action="quickpick-section-down"
              data-section-id="${escapeHtml(sectionId)}"
              ${index === quickPickSettings.sectionOrder.length - 1 ? 'disabled' : ''}
            >Down</button>
          </div>
        </div>
      `;
    });
    const sortOptions = PROFILE_QUICK_PICK_SORT_OPTIONS.map((option) => {
      return `<option value="${escapeHtml(option.id)}" ${
        quickPickSettings.profileSort === option.id ? 'selected' : ''
      }>${escapeHtml(option.label)}</option>`;
    });
    const secondarySortOptions = PROFILE_QUICK_PICK_SECONDARY_SORT_OPTIONS.map((option) => {
      return `<option value="${escapeHtml(option.id)}" ${
        quickPickSettings.secondaryProfileSort === option.id ? 'selected' : ''
      }>${escapeHtml(option.label)}</option>`;
    });
    const lowWeeklyThresholdText = formatLowRemainingPercentThreshold(
      quickPickSettings.lowWeeklyRemainingZeroThreshold
    );

    return `
      <div class="summary-card account-switcher-settings">
        <div class="section-title">Account switcher popup</div>
        <div class="settings-grid">
          <div class="settings-column">
            <div class="settings-label">Visible groups</div>
            <div class="settings-list">${sectionRows.join('')}</div>
          </div>
          <div class="settings-column">
            <label class="settings-label" for="quickPickSortSelect">Account sort</label>
            <select id="quickPickSortSelect">${sortOptions.join('')}</select>
            <label class="settings-label" for="quickPickSecondarySortSelect">Tie-break sort</label>
            <select id="quickPickSecondarySortSelect">${secondarySortOptions.join('')}</select>
            <div class="muted">Availability keeps the status groups. Other account sorts combine visible groups into one globally sorted list. The tie-break sort is used only when two accounts have the same primary value.</div>
            <label class="checkbox-label settings-toggle">
              <input id="roundLowWeeklyRemainingInput" type="checkbox" ${
                quickPickSettings.roundLowWeeklyRemainingToZero ? 'checked' : ''
              }>
              Show weekly remaining below threshold as 0%
            </label>
            <label class="settings-label" for="lowWeeklyRemainingZeroThresholdInput">Weekly zero threshold</label>
            <div class="inline-setting">
              <input
                id="lowWeeklyRemainingZeroThresholdInput"
                type="number"
                min="0"
                max="100"
                step="0.1"
                value="${escapeHtml(lowWeeklyThresholdText)}"
              >
              <span>%</span>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  renderPortableProfileVault(status) {
    const current = status && typeof status === 'object'
      ? status
      : {
          state: 'missing',
          enabled: false,
          exists: false,
          profileCount: 0,
          updatedAt: null,
          path: ''
        };
    const state = String(current.state || 'missing');
    const labels = {
      available: 'Vault found',
      conflict: 'Import required',
      error: 'Sync error',
      invalid: 'Invalid file',
      locked: 'Password required',
      missing: current.enabled ? 'File missing' : 'Off',
      synced: 'Automatic sync on'
    };
    const descriptions = {
      available:
        'An encrypted vault was detected in the extension storage folder. Import its profiles, tokens, private notes, 2FA settings, and saved limit records.',
      conflict:
        'The vault changed outside this VS Code window. Import and merge it before automatic writes can resume.',
      error:
        current.error || 'The last automatic vault synchronization failed.',
      invalid:
        current.error || 'The detected portable vault file is not readable.',
      locked:
        current.exists
          ? 'The vault is enabled, but its password is not available on this computer. Enter it to import and resume automatic sync.'
          : 'Automatic sync is enabled, but its password and vault file are not available on this computer.',
      missing: current.enabled
        ? 'The vault file is missing. Synchronize now to recreate it from the profiles on this computer.'
        : 'Keep every profile and its current tokens, private note, 2FA configuration, limit records, and account state in one password-encrypted file.',
      synced:
        'Every profile change is automatically written to this password-encrypted portable file.'
    };
    const action = (label, actionName, className = 'secondary') =>
      `<button class="${className}" data-action="${actionName}">${escapeHtml(label)}</button>`;
    const actions = [];

    if (state === 'available') {
      actions.push(action('Add profiles', 'portable-vault-import'));
      actions.push(action('Add and keep synced', 'portable-vault-import-sync', ''));
    } else if (state === 'synced') {
      actions.push(action('Sync now', 'portable-vault-sync', ''));
      actions.push(action('Change password', 'portable-vault-change-password'));
      actions.push(action('Stop automatic sync', 'portable-vault-disable'));
    } else if (state === 'conflict' || (state === 'error' && current.exists)) {
      actions.push(action('Import and resume', 'portable-vault-import-sync', ''));
      actions.push(action('Stop automatic sync', 'portable-vault-disable'));
    } else if (state === 'locked' && current.exists) {
      actions.push(action('Unlock, add, and sync', 'portable-vault-import-sync', ''));
      actions.push(action('Stop automatic sync', 'portable-vault-disable'));
    } else if (state === 'missing' && current.enabled) {
      actions.push(action('Recreate vault', 'portable-vault-sync', ''));
      actions.push(action('Stop automatic sync', 'portable-vault-disable'));
    } else if (state === 'missing') {
      actions.push(action('Enable encrypted vault', 'portable-vault-enable', ''));
    } else if (current.enabled) {
      actions.push(action('Stop automatic sync', 'portable-vault-disable'));
    }
    actions.push(action('Open folder', 'portable-vault-open-folder'));

    const metadata = [];
    if (current.exists) {
      metadata.push(
        `${Number(current.profileCount || 0)} profile${Number(current.profileCount || 0) === 1 ? '' : 's'}`
      );
    }
    if (current.updatedAt) {
      metadata.push(`updated ${formatLocalDateTime(current.updatedAt)}`);
    }

    return `
      <div class="summary-card portable-vault-card portable-vault-${escapeHtml(state)}">
        <div class="portable-vault-header">
          <div class="section-title">Portable encrypted profile vault</div>
          <span class="portable-vault-badge">${escapeHtml(labels[state] || labels.error)}</span>
        </div>
        <div class="muted">${escapeHtml(descriptions[state] || descriptions.error)}</div>
        ${metadata.length ? `<div class="portable-vault-meta">${escapeHtml(metadata.join(' · '))}</div>` : ''}
        ${current.path ? `<code class="portable-vault-path">${escapeHtml(current.path)}</code>` : ''}
        <div class="card-actions">${actions.join('')}</div>
      </div>
    `;
  }

  renderErrorPage(error) {
    const message = getErrorMessage(error);
    return `<!DOCTYPE html>
      <html lang="en">
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Codex Accounts</title>
          <style>
            body {
              margin: 0;
              padding: 20px;
              color: var(--vscode-editor-foreground);
              background: var(--vscode-editor-background);
              font-family: var(--vscode-font-family);
            }
            .error {
              color: var(--vscode-errorForeground);
              border: 1px solid var(--vscode-inputValidation-errorBorder);
              background: var(--vscode-inputValidation-errorBackground);
              padding: 14px;
              border-radius: 6px;
            }
          </style>
        </head>
        <body>
          <h1>Codex Accounts</h1>
          <div class="error">${escapeHtml(message)}</div>
        </body>
      </html>`;
  }

  update() {
    this.updateRequested = true;
    if (this.updateInFlight) {
      return this.updateInFlight;
    }

    this.updateInFlight = this.runUpdateLoop();
    return this.updateInFlight;
  }

  async runUpdateLoop() {
    try {
      while (this.updateRequested) {
        this.updateRequested = false;
        await this.performUpdate();
      }
    } finally {
      this.updateInFlight = null;
    }
  }

  async performUpdate() {
    try {
      const profiles = await this.profileManager.listProfiles();
      const activeProfileId = await this.profileManager.getActiveProfileId();
      const activeProfile = activeProfileId
        ? profiles.find((profile) => profile.id === activeProfileId) || null
        : null;
      const profilesById = new Map(profiles.map((profile) => [profile.id, profile]));
      const now = Date.now();
      const activeStatus = activeProfile
        ? getProfileRateStatus(activeProfile, now, { activeProfileId })
        : null;
      const profileViews = await this.buildProfileViewModels(profiles, activeProfileId, now);
      const currentAuthData = await this.profileManager.loadCurrentAuthData();
      const currentMatch = await this.profileManager.getCurrentAuthProfileMatch();
      const lastObservation = this.rateLimitMonitor.getLastObservation();
      const lastError = this.rateLimitMonitor.getLastError();
      const lastRefreshResult = this.rateLimitMonitor.getLastRefreshResult
        ? this.rateLimitMonitor.getLastRefreshResult()
        : null;

      const activeWindowsHtml = activeProfile
        ? [
            this.renderWindow(activeStatus.primary, 'Primary', now),
            this.renderWindow(activeStatus.secondary, 'Secondary', now)
          ]
            .filter(Boolean)
            .join('')
        : '';
      const groupChoices = this.getProfileGroupChoices(profiles);
      const quickPickSettings = getProfileQuickPickSettings();
      const paidRateLimitProfileCount = profiles.filter(isPaidProfileWithRateLimits).length;
      const windowNotStartedCount = profileViews.filter(
        (profileView) => profileView.windowNotStarted
      ).length;
      const portableProfileVaultStatus =
        typeof this.profileManager.getPortableProfileVaultStatus === 'function'
          ? await this.profileManager.getPortableProfileVaultStatus()
          : null;

      const data = {
        activeProfile,
        activeStatus,
        activeWindowsHtml,
        currentAuthData,
        currentMatch,
        groupChoices,
        lastError,
        lastObservation,
        lastRefreshResult,
        paidRateLimitProfileCount,
        windowNotStartedCount,
        profileViews,
        profilesById,
        quickPickSettings,
        portableProfileVaultStatus
      };

      if (!this.hasRendered) {
        this.panel.webview.html = this.renderHtml(data);
        this.hasRendered = true;
        return;
      }

      await this.panel.webview.postMessage({
        command: 'updateData',
        data: this.buildClientUpdateData(data)
      });
    } catch (error) {
      this.reportOperationError('render', error);
      if (!this.hasRendered) {
        this.panel.webview.html = this.renderErrorPage(error);
      } else {
        await this.panel.webview.postMessage({
          command: 'updateError',
          message: getErrorMessage(error)
        });
      }
    }
  }

  buildClientUpdateData(data) {
    const {
      activeProfile,
      activeStatus,
      activeWindowsHtml,
      groupChoices,
      lastObservation,
      lastRefreshResult,
      paidRateLimitProfileCount,
      windowNotStartedCount,
      profileViews,
      quickPickSettings,
      portableProfileVaultStatus: rawPortableProfileVaultStatus
    } = data;
    const portableProfileVaultStatus = rawPortableProfileVaultStatus ?? null;

    return {
      accounts: profileViews,
      groupChoices,
      headerSubtitle: activeProfile
        ? `${displayProfileName(activeProfile)} - ${activeStatus.compactText}`
        : 'No active profile selected',
      statsCardsHtml: this.renderStatsCards(profileViews),
      summaryGridHtml: this.renderSummaryGrid(data),
      activeWindowsHtml: this.renderActiveWindowsSummary(activeProfile, activeWindowsHtml),
      tokenUsageHtml: this.renderTokenUsage(
        lastObservation,
        lastRefreshResult,
        activeProfile
      ),
      paidRateLimitProfileCount,
      windowNotStartedCount,
      quickPickSettingsHtml: this.renderQuickPickSettings(quickPickSettings),
      quickPickSettingsVersion: JSON.stringify(quickPickSettings),
      portableProfileVaultHtml: this.renderPortableProfileVault(
        portableProfileVaultStatus
      ),
      portableProfileVaultVersion: JSON.stringify(portableProfileVaultStatus)
    };
  }

  renderSummaryGrid(data) {
    const {
      activeProfile,
      activeStatus,
      currentAuthData,
      currentMatch,
      lastError,
      lastRefreshResult,
      profilesById
    } = data;

    return `
      <div class="summary-grid">
        <div class="summary-card${activeProfile ? ' active-profile-card' : ''}">
          <div class="section-title">Active profile</div>
          ${
            activeProfile
              ? `
                <div class="metric-main">${escapeHtml(displayProfileName(activeProfile))}</div>
                <div class="muted">${escapeHtml(displayProfileEmail(activeProfile.email || 'Unknown'))}</div>
                <div class="window-line"><strong>Status:</strong> ${escapeHtml(activeStatus.compactText)}</div>
                <div class="window-line"><strong>Plan:</strong> ${escapeHtml(activeStatus.planText)}</div>
                <div class="card-actions">
                  <button class="secondary" data-action="open-command" data-command-action="manageBackups">Backups</button>
                </div>
              `
              : '<div class="muted">No active profile selected.</div>'
          }
        </div>

        ${this.renderCurrentAuthSummary(currentAuthData, currentMatch, profilesById)}

        <div class="summary-card${lastError ? ' danger-card' : ''}">
          <div class="section-title">Monitor</div>
          ${
            lastError
              ? `<div class="window-line error"><strong>Error:</strong> ${escapeHtml(lastError)}</div>`
              : '<div class="window-line"><strong>Error:</strong> none</div>'
          }
          <div class="window-line"><strong>Source:</strong> ${escapeHtml(
            formatRefreshResult(lastRefreshResult)
          )}</div>
        </div>
      </div>
    `;
  }

  renderActiveWindowsSummary(activeProfile, activeWindowsHtml) {
    if (activeWindowsHtml) {
      return `<div class="window-grid">${activeWindowsHtml}</div>`;
    }
    if (activeProfile) {
      return '<div class="summary-card"><div class="section-title">Current cooldown</div><div class="empty">No active cooldown windows for the selected profile.</div></div>';
    }
    return '';
  }

  renderHtml(data) {
    const {
      activeProfile,
      activeStatus,
      activeWindowsHtml,
      currentAuthData,
      currentMatch,
      groupChoices,
      lastError,
      lastObservation,
      lastRefreshResult,
      paidRateLimitProfileCount,
      windowNotStartedCount,
      profileViews,
      profilesById,
      quickPickSettings,
      portableProfileVaultStatus: rawPortableProfileVaultStatus
    } = data;
    const portableProfileVaultStatus = rawPortableProfileVaultStatus ?? null;
    const accountsJson = escapeScriptJson(profileViews);
    const groupChoicesJson = escapeScriptJson(groupChoices);
    const tokenUsageHtml = this.renderTokenUsage(
      lastObservation,
      lastRefreshResult,
      activeProfile
    );

    return `<!DOCTYPE html>
      <html lang="en">
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Codex Accounts</title>
          <style>
            :root {
              color-scheme: light dark;
            }
            body {
              font-family: var(--vscode-font-family);
              margin: 0;
              padding: 20px;
              color: var(--vscode-editor-foreground);
              background: var(--vscode-editor-background);
            }
            .layout {
              display: grid;
              gap: 16px;
              max-width: 1600px;
            }
            .page-header,
            .toolbar,
            .title-row,
            .control-row,
            .bulk-bar,
            .card-actions {
              display: flex;
              align-items: center;
              gap: 8px;
            }
            .page-header {
              justify-content: space-between;
              align-items: flex-start;
              gap: 16px;
            }
            .title {
              margin: 0;
              font-size: 22px;
              line-height: 1.2;
              font-weight: 650;
            }
            .subtitle,
            .muted,
            .empty,
            .stat-label {
              color: var(--vscode-descriptionForeground);
            }
            .subtitle {
              margin-top: 4px;
            }
            .toolbar,
            .control-row,
            .bulk-bar {
              flex-wrap: wrap;
            }
            button,
            select,
            input[type="search"] {
              font: inherit;
            }
            button {
              border: 0;
              border-radius: 5px;
              min-height: 30px;
              padding: 5px 10px;
              cursor: pointer;
              color: var(--vscode-button-foreground);
              background: var(--vscode-button-background);
            }
            button:hover {
              background: var(--vscode-button-hoverBackground);
            }
            button.secondary {
              color: var(--vscode-button-secondaryForeground);
              background: var(--vscode-button-secondaryBackground);
            }
            button.secondary:hover {
              background: var(--vscode-button-secondaryHoverBackground);
            }
            button.danger {
              color: var(--vscode-errorForeground);
              background: transparent;
              border: 1px solid var(--vscode-inputValidation-errorBorder);
            }
            button.profile-sort-button {
              min-height: 0;
              padding: 0;
              color: inherit;
              background: transparent;
              border-radius: 0;
              font-weight: inherit;
              text-align: left;
            }
            button.profile-sort-button:hover {
              color: var(--vscode-textLink-activeForeground);
              background: transparent;
            }
            button:disabled {
              cursor: default;
              opacity: 0.55;
            }
            input[type="search"],
            select {
              min-height: 30px;
              border: 1px solid var(--vscode-input-border);
              border-radius: 4px;
              padding: 4px 8px;
              color: var(--vscode-input-foreground);
              background: var(--vscode-input-background);
            }
            input[type="search"] {
              min-width: min(320px, 100%);
            }
            label.checkbox-label {
              display: inline-flex;
              align-items: center;
              gap: 6px;
              min-height: 30px;
            }
            .summary-grid {
              display: grid;
              grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
              gap: 12px;
            }
            .stats-grid {
              display: grid;
              grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
              gap: 12px;
            }
            .summary-card,
            .window-card,
            .stat-card,
            .accounts-panel {
              border: 1px solid var(--vscode-panel-border);
              border-radius: 8px;
              padding: 14px;
              background: var(--vscode-sideBar-background);
            }
            .summary-card.active-profile-card {
              border-color: var(--vscode-focusBorder);
              box-shadow: inset 0 0 0 1px var(--vscode-focusBorder);
            }
            .warning-card {
              border-color: var(--vscode-inputValidation-warningBorder);
            }
            .danger-card {
              border-color: var(--vscode-inputValidation-errorBorder);
            }
            .section-title,
            .window-title,
            .group-title {
              font-size: 15px;
              font-weight: 650;
              margin-bottom: 10px;
            }
            .metric-main {
              font-size: 16px;
              font-weight: 650;
              margin-bottom: 4px;
            }
            .stat-value {
              font-size: 22px;
              line-height: 1;
              font-weight: 700;
            }
            .stat-label {
              margin-top: 5px;
            }
            .window-grid {
              display: grid;
              grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
              gap: 12px;
            }
            .window-line {
              margin-top: 6px;
            }
            .card-actions {
              margin-top: 12px;
              flex-wrap: wrap;
            }
            .settings-grid {
              display: grid;
              grid-template-columns: minmax(260px, 1.2fr) minmax(220px, 0.8fr);
              gap: 18px;
            }
            .settings-column {
              display: grid;
              align-content: start;
              gap: 10px;
            }
            .settings-label {
              color: var(--vscode-descriptionForeground);
              font-weight: 650;
            }
            .settings-list {
              display: grid;
              gap: 8px;
            }
            .settings-row {
              display: flex;
              align-items: center;
              justify-content: space-between;
              gap: 12px;
              min-height: 34px;
              padding: 7px 9px;
              border: 1px solid var(--vscode-panel-border);
              border-radius: 6px;
              background: var(--vscode-editorWidget-background);
            }
            .settings-row-actions {
              display: flex;
              align-items: center;
              gap: 6px;
            }
            .settings-row-actions button {
              min-height: 24px;
              padding: 2px 7px;
            }
            .settings-toggle {
              margin-top: 4px;
            }
            .inline-setting {
              display: flex;
              align-items: center;
              gap: 6px;
            }
            .inline-setting input {
              max-width: 90px;
            }
            .portable-vault-card {
              display: grid;
              gap: 10px;
            }
            .portable-vault-header {
              display: flex;
              align-items: center;
              justify-content: space-between;
              gap: 12px;
            }
            .portable-vault-badge {
              flex: 0 0 auto;
              padding: 3px 8px;
              border-radius: 999px;
              color: var(--vscode-badge-foreground);
              background: var(--vscode-badge-background);
              font-size: 11px;
              font-weight: 650;
            }
            .portable-vault-conflict,
            .portable-vault-error,
            .portable-vault-invalid,
            .portable-vault-locked {
              border-color: var(--vscode-inputValidation-warningBorder);
            }
            .portable-vault-meta {
              color: var(--vscode-descriptionForeground);
              font-size: 12px;
              font-weight: 650;
            }
            .portable-vault-path {
              display: block;
              box-sizing: border-box;
              max-width: 100%;
              padding: 7px 9px;
              border: 1px solid var(--vscode-panel-border);
              border-radius: 5px;
              color: var(--vscode-textPreformat-foreground);
              background: var(--vscode-textCodeBlock-background);
              overflow-wrap: anywhere;
              white-space: normal;
            }
            .badge {
              display: inline-flex;
              align-items: center;
              margin-left: 6px;
              padding: 2px 6px;
              border-radius: 5px;
              background: var(--vscode-badge-background);
              color: var(--vscode-badge-foreground);
              font-size: 11px;
              font-weight: 650;
              white-space: nowrap;
            }
            .badge.warning {
              background: var(--vscode-inputValidation-warningBorder);
              color: var(--vscode-editor-background);
            }
            .badge.danger {
              background: var(--vscode-inputValidation-errorBorder);
              color: var(--vscode-editor-background);
            }
            .error {
              color: var(--vscode-errorForeground);
            }
            .accounts-panel {
              padding: 0;
              overflow: hidden;
            }
            .accounts-header {
              display: grid;
              gap: 12px;
              padding: 14px;
              border-bottom: 1px solid var(--vscode-panel-border);
            }
            .bulk-bar {
              min-height: 34px;
              padding: 8px 10px;
              border: 1px solid var(--vscode-panel-border);
              border-radius: 6px;
              background: var(--vscode-editorWidget-background);
            }
            .bulk-bar[hidden] {
              display: none;
            }
            .accounts-root {
              display: grid;
              min-width: 0;
              gap: 12px;
              padding: 14px;
            }
            .group-section {
              display: grid;
              min-width: 0;
              gap: 8px;
            }
            .group-title {
              display: flex;
              align-items: center;
              justify-content: space-between;
              margin: 0;
            }
            .profile-sort-bar {
              display: flex;
              align-items: center;
              flex-wrap: wrap;
              gap: 4px 10px;
              min-height: 24px;
              padding: 0 2px;
              font-size: 12px;
            }
            .profile-sort-bar .profile-sort-button.active {
              color: var(--vscode-textLink-foreground);
            }
            .profile-cards {
              display: grid;
              min-width: 0;
              gap: 5px;
            }
            .profile-card {
              box-sizing: border-box;
              display: grid;
              width: 100%;
              min-width: 0;
              gap: 4px;
              min-height: 32px;
              padding: 3px 5px 4px;
              border: 1px solid var(--vscode-panel-border);
              border-radius: 6px;
              background: var(--vscode-editorWidget-background);
            }
            .profile-card-main {
              display: grid;
              grid-template-columns: minmax(0, 1fr) max-content;
              align-items: center;
              gap: 5px;
              min-width: 0;
            }
            .profile-card .badge {
              margin-left: 2px;
              padding: 1px 4px;
              font-size: 10px;
            }
            .profile-card.active-profile {
              border-color: var(--vscode-focusBorder);
              background: color-mix(in srgb, var(--vscode-charts-green, #2ea043) 12%, var(--vscode-editorWidget-background));
            }
            .profile-card.problem-profile,
            .profile-card.not-started-profile {
              box-shadow: inset 3px 0 0 var(--vscode-inputValidation-warningBorder);
            }
            .profile-card.auth-problem-profile {
              box-shadow: inset 3px 0 0 var(--vscode-inputValidation-errorBorder);
            }
            .profile-card-checkbox {
              flex: 0 0 auto;
              margin: 0;
            }
            .profile-card-identity {
              display: grid;
              grid-template-columns: 16px minmax(0, 1fr) minmax(0, max-content);
              align-items: center;
              min-width: 0;
              gap: 5px;
            }
            .profile-card-name {
              display: flex;
              align-items: center;
              min-width: 0;
              gap: 3px;
              font-weight: 650;
              line-height: 1.1;
            }
            .profile-card-name-text {
              min-width: 0;
              overflow: hidden;
              text-overflow: ellipsis;
              white-space: nowrap;
            }
            .profile-card-limits {
              display: grid;
              grid-template-columns: repeat(2, minmax(0, max-content));
              min-width: 0;
              gap: 4px;
            }
            .limit-chip {
              box-sizing: border-box;
              min-width: 0;
              overflow: hidden;
              padding: 1px 4px;
              border-radius: 4px;
              color: var(--vscode-descriptionForeground);
              background: var(--vscode-badge-background);
              font-size: 10px;
              line-height: 1.2;
              text-overflow: ellipsis;
              white-space: nowrap;
            }
            .profile-card-details {
              display: grid;
              grid-template-columns: repeat(auto-fit, minmax(155px, 1fr));
              gap: 5px 12px;
              padding: 6px 2px 2px 21px;
              border-top: 1px solid var(--vscode-panel-border);
            }
            .profile-card-details[hidden] {
              display: none;
            }
            .profile-detail {
              display: grid;
              min-width: 0;
              gap: 1px;
            }
            .profile-detail-label {
              color: var(--vscode-descriptionForeground);
              font-size: 10px;
              font-weight: 650;
              line-height: 1.1;
            }
            .profile-detail-value {
              min-width: 0;
              overflow-wrap: anywhere;
              font-size: 11px;
              line-height: 1.25;
            }
            .profile-detail .group-select {
              box-sizing: border-box;
              width: 100%;
              max-width: none;
              min-height: 22px;
              padding: 1px 4px;
              font-size: 11px;
            }
            .profile-card-actions {
              display: grid;
              grid-template-columns: repeat(6, 22px);
              align-items: center;
              justify-content: end;
              min-width: 0;
              gap: 3px;
            }
            button.compact-action {
              box-sizing: border-box;
              width: 22px;
              min-width: 22px;
              min-height: 22px;
              padding: 1px 4px;
              font-size: 11px;
            }
            button.compact-delete {
              width: 22px;
              padding: 0;
              font-size: 17px;
              line-height: 1;
            }
            button.profile-details-toggle {
              width: 22px;
              padding: 0;
              color: var(--vscode-descriptionForeground);
              font-size: 15px;
              line-height: 1;
            }
            .private-note-trigger {
              font-family: "Segoe UI Emoji", var(--vscode-font-family);
            }
            .private-note-popover {
              position: fixed;
              z-index: 100;
              width: min(440px, calc(100vw - 24px));
              max-height: min(620px, calc(100vh - 24px));
              overflow: auto;
              padding: 12px;
              border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border));
              border-radius: 8px;
              color: var(--vscode-editorWidget-foreground);
              background: var(--vscode-editorWidget-background);
              box-shadow: 0 8px 24px var(--vscode-widget-shadow);
            }
            .private-note-popover[hidden] {
              display: none;
            }
            .private-note-popover-header,
            .private-note-popover-actions {
              display: flex;
              align-items: center;
              gap: 8px;
            }
            .private-note-popover-header {
              justify-content: space-between;
              margin-bottom: 8px;
            }
            .private-note-popover-title {
              min-width: 0;
              overflow: hidden;
              font-weight: 650;
              text-overflow: ellipsis;
              white-space: nowrap;
            }
            .private-note-popover-status {
              min-height: 18px;
              margin-bottom: 6px;
              color: var(--vscode-descriptionForeground);
              font-size: 12px;
            }
            .private-note-totp {
              display: grid;
              gap: 7px;
              margin-bottom: 10px;
              padding: 9px;
              border: 1px solid var(--vscode-panel-border);
              border-radius: 6px;
              background: var(--vscode-sideBar-background);
            }
            .private-note-totp-row {
              display: flex;
              align-items: center;
              gap: 7px;
              flex-wrap: wrap;
            }
            .private-note-totp-code {
              min-width: 112px;
              font-family: var(--vscode-editor-font-family);
              font-size: 18px;
              font-weight: 700;
              letter-spacing: 2px;
            }
            .private-note-totp-input {
              box-sizing: border-box;
              flex: 1 1 220px;
              min-height: 30px;
              min-width: 0;
              border: 1px solid var(--vscode-input-border);
              border-radius: 4px;
              padding: 4px 8px;
              color: var(--vscode-input-foreground);
              background: var(--vscode-input-background);
              font: inherit;
            }
            .private-note-lines {
              display: grid;
              gap: 4px;
              max-height: 180px;
              margin-bottom: 8px;
              overflow: auto;
            }
            .private-note-line-row {
              display: flex;
              align-items: center;
              gap: 5px;
              min-width: 0;
            }
            button.private-note-line {
              display: flex;
              flex: 1 1 auto;
              justify-content: space-between;
              gap: 8px;
              min-height: 26px;
              padding: 3px 7px;
              text-align: left;
            }
            button.private-note-detected-code {
              flex: 0 0 auto;
              min-height: 26px;
              padding: 3px 7px;
              font-family: var(--vscode-editor-font-family);
              font-weight: 700;
              letter-spacing: 1px;
            }
            .private-note-line-text {
              min-width: 0;
              overflow: hidden;
              text-overflow: ellipsis;
              white-space: nowrap;
            }
            .private-note-copy-glyph {
              flex: 0 0 auto;
            }
            .private-note-editor {
              box-sizing: border-box;
              width: 100%;
              min-height: 120px;
              resize: vertical;
              border: 1px solid var(--vscode-input-border);
              border-radius: 4px;
              padding: 8px;
              color: var(--vscode-input-foreground);
              background: var(--vscode-input-background);
              font: inherit;
              line-height: 1.4;
            }
            .private-note-editor:focus {
              border-color: var(--vscode-focusBorder);
              outline: 1px solid var(--vscode-focusBorder);
              outline-offset: -1px;
            }
            .private-note-popover-actions {
              justify-content: flex-end;
              flex-wrap: wrap;
              margin-top: 8px;
            }
            .group-select {
              max-width: 150px;
            }
            .empty {
              padding: 18px;
              border: 1px dashed var(--vscode-panel-border);
              border-radius: 6px;
            }
            @media (max-width: 720px) {
              body {
                padding: 12px;
              }
              .page-header {
                display: grid;
              }
              .toolbar button,
              .control-row select,
              .control-row input[type="search"] {
                width: 100%;
              }
              .control-row {
                display: grid;
              }
              .settings-grid {
                grid-template-columns: 1fr;
              }
              .settings-row {
                align-items: flex-start;
              }
              .portable-vault-header {
                display: grid;
                justify-content: stretch;
              }
              .portable-vault-badge {
                justify-self: start;
              }
            }
            @media (max-width: 1150px) {
              .profile-card-limits .limit-chip {
                max-width: 96px;
              }
            }
            @media (max-width: 760px) {
              .profile-card-limits {
                gap: 2px;
              }
              .profile-card-limits .limit-chip {
                max-width: 68px;
              }
            }
            @media (max-width: 520px) {
              .profile-card-actions {
                grid-template-columns: repeat(3, 22px);
              }
            }
            @media (max-width: 390px) {
              .profile-card-main {
                grid-template-columns: minmax(0, 1fr);
              }
              .profile-card-actions {
                grid-template-columns: repeat(6, 22px);
                justify-content: start;
                padding-left: 21px;
              }
            }
          </style>
        </head>
        <body>
          <div class="layout">
            <div class="page-header">
              <div>
                <h1 class="title">Codex Accounts</h1>
                <div id="headerSubtitle" class="subtitle">${
                  activeProfile
                    ? `${escapeHtml(displayProfileName(activeProfile))} - ${escapeHtml(activeStatus.compactText)}`
                    : 'No active profile selected'
                }</div>
              </div>
              <div class="toolbar">
                <button data-action="refresh">Refresh</button>
                <button
                  id="resetPaidLimitsButton"
                  class="secondary"
                  data-action="reset-paid-limits"
                  ${paidRateLimitProfileCount > 0 ? '' : 'disabled'}
                  title="Set locally stored usage to 0% for all paid accounts"
                >Reset paid limits</button>
                <button
                  id="activateUnstartedCountersButton"
                  data-action="activate-unstarted-counters"
                  ${windowNotStartedCount > 0 ? '' : 'disabled'}
                  title="Choose the official Codex extension UI or app-server-only method, then activate every unused counter in an isolated VS Code window"
                >Activate unused counters (${windowNotStartedCount})</button>
                <button data-action="open-command" data-command-action="login">Login</button>
                <button data-action="open-command" data-command-action="addCurrent">Add current</button>
                <button class="secondary" data-action="open-command" data-command-action="addFromFile">Import auth.json</button>
                <button class="secondary" data-action="open-command" data-command-action="importProfiles">Import profiles</button>
                <button class="secondary" data-action="open-command" data-command-action="exportProfiles">Export profiles</button>
                <button class="secondary" data-action="open-command" data-command-action="manageBackups">Backups</button>
                <button class="secondary" data-action="open-command" data-command-action="restoreBackup">Restore auth</button>
                <button data-action="open-command" data-command-action="doctor">Doctor</button>
                <button class="secondary" data-action="open-command" data-command-action="settings">Settings</button>
              </div>
            </div>
            <div id="liveUpdateError" class="summary-card danger-card" hidden></div>

            <div id="statsCardsRoot">${this.renderStatsCards(profileViews)}</div>

            <div id="summaryGridRoot">${this.renderSummaryGrid(data)}</div>

            <div id="activeWindowsRoot">${this.renderActiveWindowsSummary(
              activeProfile,
              activeWindowsHtml
            )}</div>

            <div id="tokenUsageRoot">${tokenUsageHtml}</div>

            <div class="accounts-panel">
              <div class="accounts-header">
                <div class="title-row">
                  <div class="section-title" style="margin: 0;">Accounts</div>
                  <span id="visibleCount" class="muted"></span>
                </div>
                <div class="control-row">
                  <input id="searchInput" type="search" placeholder="Search name, email, group">
                  <select id="groupBySelect">
                    <option value="status">By status</option>
                    <option value="plan">By plan</option>
                    <option value="group">By group</option>
                    <option value="all">All accounts</option>
                  </select>
                  <select id="statusFilter"></select>
                  <select id="planFilter"></select>
                  <select id="sortSelect">
                    <option value="default">Best available</option>
                    <option value="name">Name</option>
                    <option value="plan">Plan tier</option>
                    <option value="observed">Newest observation</option>
                  </select>
                  <label class="checkbox-label">
                    <input id="problemFilter" type="checkbox">
                    Only problems
                  </label>
                </div>
                <div id="sortScopeHint" class="muted">
                  Choosing an explicit sort switches grouping to All accounts so the order is global.
                </div>
                <div id="bulkBar" class="bulk-bar" hidden>
                  <strong id="selectedCount">0 selected</strong>
                  <button class="secondary" data-action="bulk-group">Set group</button>
                  <button class="danger" data-action="bulk-delete">Delete selected</button>
                </div>
              </div>
              <div id="accountsRoot" class="accounts-root"></div>
            </div>

            <div id="quickPickSettingsRoot">${this.renderQuickPickSettings(quickPickSettings)}</div>
            <div id="portableProfileVaultRoot">${this.renderPortableProfileVault(
              portableProfileVaultStatus
            )}</div>
          </div>

          <div
            id="privateNotePopover"
            class="private-note-popover"
            role="dialog"
            aria-label="Private account note"
            hidden
          >
            <div class="private-note-popover-header">
              <div id="privateNoteTitle" class="private-note-popover-title">Private note</div>
              <button
                class="secondary"
                data-action="private-note-close"
                aria-label="Close private note"
                title="Close"
              >×</button>
            </div>
            <div id="privateNoteStatus" class="private-note-popover-status"></div>
            <div class="private-note-totp">
              <div class="private-note-totp-row">
                <strong>2FA code</strong>
                <button
                  id="privateNoteTotpCode"
                  class="secondary private-note-totp-code"
                  data-action="private-note-copy-totp"
                  hidden
                ></button>
                <span id="privateNoteTotpCountdown" class="muted">Not configured</span>
              </div>
              <div class="private-note-totp-row">
                <input
                  id="privateNoteTotpInput"
                  class="private-note-totp-input"
                  type="password"
                  autocomplete="off"
                  spellcheck="false"
                  aria-label="New TOTP secret or otpauth URI"
                  placeholder="Base32 secret or otpauth:// URI"
                >
                <button class="secondary" data-action="private-note-save-totp">Save 2FA</button>
                <button
                  id="privateNoteTotpClear"
                  class="secondary"
                  data-action="private-note-clear-totp"
                  disabled
                >Remove</button>
              </div>
              <div id="privateNoteTotpStatus" class="muted">
                The secret is stored separately in VS Code SecretStorage.
              </div>
            </div>
            <div id="privateNoteLines" class="private-note-lines"></div>
            <textarea
              id="privateNoteEditor"
              class="private-note-editor"
              maxlength="262144"
              spellcheck="true"
              aria-label="Private account note text"
              placeholder="Write a private note for this account"
            ></textarea>
            <div class="private-note-popover-actions">
              <button class="secondary" data-action="private-note-open-full">Open full editor</button>
              <button data-action="private-note-save">Save now</button>
            </div>
          </div>

          <script>
            const vscode = acquireVsCodeApi();
            let accounts = ${accountsJson};
            let groupChoices = ${groupChoicesJson};
            const customGroupValue = ${JSON.stringify(CUSTOM_GROUP_VALUE)};
            const savedState = vscode.getState() || {};
            let accountIds = new Set(accounts.map((account) => account.id));
            let quickPickSettingsVersion = ${escapeScriptJson(JSON.stringify(quickPickSettings))};
            let portableProfileVaultVersion = ${escapeScriptJson(
              JSON.stringify(portableProfileVaultStatus)
            )};
            let pendingDataUpdate = null;
            let privateNoteProfileId = null;
            let privateNoteAnchor = null;
            let privateNoteHoverTimer = null;
            let privateNoteHideTimer = null;
            let privateNoteSaveTimer = null;
            let privateNoteTotpTimer = null;
            let privateNoteTotpValidUntil = 0;
            let privateNoteTotpRefreshRequested = false;
            let privateNoteDetectionTimer = null;
            let privateNoteDetectionRequestTimer = null;
            let privateNoteDetectionRefreshRequested = false;
            let privateNoteDetectedTotp = [];
            let privateNoteDetectionLatestRequestId = null;
            let privateNoteRequestSequence = 0;
            const privateNoteHoverDelayMs = 650;
            let privateNoteEditVersion = 0;
            let privateNoteSavedVersion = 0;
            let privateNoteRequestedVersion = -1;
            const privateNoteSaveRequests = new Map();
            const displayCollator = new Intl.Collator('en', {
              numeric: true,
              sensitivity: 'base'
            });
            const descendingDefaultSortKeys = new Set([
              'observedAt',
              'fiveHourRemaining',
              'weeklyRemaining'
            ]);
            const sortableColumnKeys = new Set([
              'name',
              'profileGroup',
              'plan',
              'operationalStatus',
              'fiveHourRemaining',
              'weeklyRemaining',
              'observedAt',
              'sourceText'
            ]);
            let profileSortKey = sortableColumnKeys.has(savedState.profileSortKey)
              ? savedState.profileSortKey
              : null;
            let profileSortDirection = savedState.profileSortDirection === 'desc' ? 'desc' : 'asc';
            const selectedIds = new Set(
              Array.isArray(savedState.selectedIds)
                ? savedState.selectedIds.filter((profileId) => accountIds.has(profileId))
                : []
            );
            const expandedProfileIds = new Set(
              Array.isArray(savedState.expandedProfileIds)
                ? savedState.expandedProfileIds.filter((profileId) => accountIds.has(profileId))
                : []
            );

            const elements = {
              activeWindowsRoot: document.getElementById('activeWindowsRoot'),
              accountsRoot: document.getElementById('accountsRoot'),
              bulkBar: document.getElementById('bulkBar'),
              groupBySelect: document.getElementById('groupBySelect'),
              headerSubtitle: document.getElementById('headerSubtitle'),
              liveUpdateError: document.getElementById('liveUpdateError'),
              planFilter: document.getElementById('planFilter'),
              privateNoteEditor: document.getElementById('privateNoteEditor'),
              privateNoteLines: document.getElementById('privateNoteLines'),
              privateNotePopover: document.getElementById('privateNotePopover'),
              privateNoteStatus: document.getElementById('privateNoteStatus'),
              privateNoteTitle: document.getElementById('privateNoteTitle'),
              privateNoteTotpClear: document.getElementById('privateNoteTotpClear'),
              privateNoteTotpCode: document.getElementById('privateNoteTotpCode'),
              privateNoteTotpCountdown: document.getElementById('privateNoteTotpCountdown'),
              privateNoteTotpInput: document.getElementById('privateNoteTotpInput'),
              privateNoteTotpStatus: document.getElementById('privateNoteTotpStatus'),
              problemFilter: document.getElementById('problemFilter'),
              portableProfileVaultRoot: document.getElementById('portableProfileVaultRoot'),
              quickPickSettingsRoot: document.getElementById('quickPickSettingsRoot'),
              quickPickSecondarySortSelect: document.getElementById('quickPickSecondarySortSelect'),
              quickPickSortSelect: document.getElementById('quickPickSortSelect'),
              lowWeeklyRemainingZeroThresholdInput: document.getElementById('lowWeeklyRemainingZeroThresholdInput'),
              resetPaidLimitsButton: document.getElementById('resetPaidLimitsButton'),
              activateUnstartedCountersButton: document.getElementById(
                'activateUnstartedCountersButton'
              ),
              roundLowWeeklyRemainingInput: document.getElementById('roundLowWeeklyRemainingInput'),
              searchInput: document.getElementById('searchInput'),
              selectedCount: document.getElementById('selectedCount'),
              sortSelect: document.getElementById('sortSelect'),
              statsCardsRoot: document.getElementById('statsCardsRoot'),
              statusFilter: document.getElementById('statusFilter'),
              summaryGridRoot: document.getElementById('summaryGridRoot'),
              tokenUsageRoot: document.getElementById('tokenUsageRoot'),
              visibleCount: document.getElementById('visibleCount')
            };

            function post(command, payload = {}) {
              vscode.postMessage({ command, ...payload });
            }

            function refreshQuickPickSettingElements() {
              elements.quickPickSecondarySortSelect =
                document.getElementById('quickPickSecondarySortSelect');
              elements.quickPickSortSelect = document.getElementById('quickPickSortSelect');
              elements.lowWeeklyRemainingZeroThresholdInput =
                document.getElementById('lowWeeklyRemainingZeroThresholdInput');
              elements.roundLowWeeklyRemainingInput =
                document.getElementById('roundLowWeeklyRemainingInput');
            }

            function hasActiveControlInteraction() {
              const active = document.activeElement;
              return Boolean(
                !elements.privateNotePopover.hidden ||
                active &&
                active !== document.body &&
                (
                  active.matches('input, select, textarea') ||
                  active.isContentEditable
                )
              );
            }

            function clearPrivateNoteTimer(timerName) {
              const timer = timerName === 'hover'
                ? privateNoteHoverTimer
                : timerName === 'hide'
                  ? privateNoteHideTimer
                  : privateNoteSaveTimer;
              if (timer) {
                clearTimeout(timer);
              }
              if (timerName === 'hover') {
                privateNoteHoverTimer = null;
              } else if (timerName === 'hide') {
                privateNoteHideTimer = null;
              } else {
                privateNoteSaveTimer = null;
              }
            }

            function positionPrivateNotePopover() {
              if (
                elements.privateNotePopover.hidden ||
                !privateNoteAnchor ||
                !privateNoteAnchor.isConnected
              ) {
                return;
              }
              const margin = 12;
              const gap = 6;
              const anchorRect = privateNoteAnchor.getBoundingClientRect();
              const popoverRect = elements.privateNotePopover.getBoundingClientRect();
              const maxLeft = Math.max(margin, window.innerWidth - popoverRect.width - margin);
              const left = Math.min(Math.max(margin, anchorRect.right - popoverRect.width), maxLeft);
              let top = anchorRect.bottom + gap;
              if (top + popoverRect.height > window.innerHeight - margin) {
                top = Math.max(margin, anchorRect.top - popoverRect.height - gap);
              }
              elements.privateNotePopover.style.left = left + 'px';
              elements.privateNotePopover.style.top = top + 'px';
              elements.privateNotePopover.style.visibility = 'visible';
            }

            function setPrivateNoteStatus(text) {
              elements.privateNoteStatus.textContent = text || '';
            }

            function stopPrivateNoteTotpTimer() {
              if (privateNoteTotpTimer) {
                clearInterval(privateNoteTotpTimer);
                privateNoteTotpTimer = null;
              }
            }

            function updatePrivateNoteTotpCountdown() {
              if (!privateNoteTotpValidUntil) {
                return;
              }
              const remaining = Math.max(
                0,
                Math.ceil((privateNoteTotpValidUntil - Date.now()) / 1000)
              );
              elements.privateNoteTotpCountdown.textContent =
                remaining > 0 ? remaining + 's remaining' : 'Refreshing…';
              if (
                remaining <= 0 &&
                !privateNoteTotpRefreshRequested &&
                privateNoteProfileId
              ) {
                privateNoteTotpRefreshRequested = true;
                post('requestPrivateNoteTotp', {
                  profileId: privateNoteProfileId,
                  requestId: 'note-totp-refresh-' + (++privateNoteRequestSequence)
                });
              }
            }

            function applyPrivateNoteTotp(totp) {
              stopPrivateNoteTotpTimer();
              privateNoteTotpRefreshRequested = false;
              const configured = Boolean(totp && totp.configured && totp.code);
              elements.privateNoteTotpCode.hidden = !configured;
              elements.privateNoteTotpClear.disabled = !configured;
              if (!configured) {
                elements.privateNoteTotpCode.textContent = '';
                elements.privateNoteTotpCountdown.textContent = 'Not configured';
                privateNoteTotpValidUntil = 0;
                return;
              }
              elements.privateNoteTotpCode.textContent = totp.code;
              elements.privateNoteTotpCode.title = 'Copy current 2FA code';
              privateNoteTotpValidUntil = Number(totp.validUntil) || 0;
              updatePrivateNoteTotpCountdown();
              privateNoteTotpTimer = setInterval(updatePrivateNoteTotpCountdown, 1000);
            }

            function getPrivateNoteLines() {
              return elements.privateNoteEditor.value.split(/\\r?\\n/);
            }

            function stopPrivateNoteDetectionTimers() {
              if (privateNoteDetectionTimer) {
                clearInterval(privateNoteDetectionTimer);
                privateNoteDetectionTimer = null;
              }
              if (privateNoteDetectionRequestTimer) {
                clearTimeout(privateNoteDetectionRequestTimer);
                privateNoteDetectionRequestTimer = null;
              }
            }

            function getDetectedTotpButtonText(detection) {
              const remaining = Math.max(
                0,
                Math.ceil((Number(detection.validUntil) - Date.now()) / 1000)
              );
              return detection.code + ' · ' + remaining + 's';
            }

            function refreshDetectedTotpButtons() {
              const buttons = elements.privateNoteLines.querySelectorAll(
                'button[data-detected-totp-id]'
              );
              for (const button of buttons) {
                const detection = privateNoteDetectedTotp.find(
                  (item) => item.id === button.dataset.detectedTotpId
                );
                if (detection) {
                  button.textContent = getDetectedTotpButtonText(detection);
                }
              }
              if (
                privateNoteDetectedTotp.some(
                  (item) => Number(item.validUntil) <= Date.now()
                ) &&
                !privateNoteDetectionRefreshRequested
              ) {
                requestPrivateNoteDetectedTotp();
              }
            }

            function requestPrivateNoteDetectedTotp() {
              if (!privateNoteProfileId || elements.privateNoteEditor.disabled) {
                return;
              }
              privateNoteDetectionRefreshRequested = true;
              const requestId =
                'note-detected-totp-' + (++privateNoteRequestSequence);
              privateNoteDetectionLatestRequestId = requestId;
              post('requestPrivateNoteDetectedTotp', {
                profileId: privateNoteProfileId,
                requestId,
                value: elements.privateNoteEditor.value
              });
            }

            function schedulePrivateNoteDetectedTotp() {
              if (privateNoteDetectionRequestTimer) {
                clearTimeout(privateNoteDetectionRequestTimer);
              }
              privateNoteDetectionRequestTimer = setTimeout(
                requestPrivateNoteDetectedTotp,
                300
              );
            }

            function renderPrivateNoteLines() {
              const lines = getPrivateNoteLines();
              elements.privateNoteLines.textContent = '';
              const visibleLines = lines.slice(0, 100);
              for (let index = 0; index < visibleLines.length; index += 1) {
                const line = visibleLines[index];
                const row = document.createElement('div');
                row.className = 'private-note-line-row';
                const button = document.createElement('button');
                button.className = 'secondary private-note-line';
                button.dataset.action = 'private-note-copy-line';
                button.dataset.lineIndex = String(index);
                button.title = 'Copy line ' + (index + 1);
                button.setAttribute('aria-label', 'Copy note line ' + (index + 1));
                const text = document.createElement('span');
                text.className = 'private-note-line-text';
                text.textContent = line || '(empty line)';
                const glyph = document.createElement('span');
                glyph.className = 'private-note-copy-glyph';
                glyph.textContent = '⧉';
                button.appendChild(text);
                button.appendChild(glyph);
                row.appendChild(button);
                const detections = privateNoteDetectedTotp.filter(
                  (item) => item.lineIndex === index
                );
                for (const detection of detections) {
                  const codeButton = document.createElement('button');
                  codeButton.className = 'secondary private-note-detected-code';
                  codeButton.dataset.action = 'private-note-copy-detected-totp';
                  codeButton.dataset.detectedTotpId = detection.id;
                  codeButton.textContent = getDetectedTotpButtonText(detection);
                  codeButton.title = 'Detected 2FA — copy current code';
                  row.appendChild(codeButton);
                }
                elements.privateNoteLines.appendChild(row);
              }
              if (lines.length > visibleLines.length) {
                const more = document.createElement('div');
                more.className = 'muted';
                more.textContent =
                  (lines.length - visibleLines.length) + ' more lines are available in the editor.';
                elements.privateNoteLines.appendChild(more);
              }
            }

            function savePrivateNoteDraft() {
              clearPrivateNoteTimer('save');
              if (
                !privateNoteProfileId ||
                privateNoteEditVersion === privateNoteSavedVersion ||
                privateNoteRequestedVersion === privateNoteEditVersion
              ) {
                return;
              }
              const requestId = 'note-save-' + (++privateNoteRequestSequence);
              const version = privateNoteEditVersion;
              privateNoteRequestedVersion = version;
              privateNoteSaveRequests.set(requestId, version);
              setPrivateNoteStatus('Saving securely…');
              post('savePrivateNotePreview', {
                profileId: privateNoteProfileId,
                requestId,
                value: elements.privateNoteEditor.value
              });
            }

            function hidePrivateNotePopover() {
              clearPrivateNoteTimer('hover');
              clearPrivateNoteTimer('hide');
              savePrivateNoteDraft();
              stopPrivateNoteTotpTimer();
              stopPrivateNoteDetectionTimers();
              elements.privateNotePopover.hidden = true;
              elements.privateNotePopover.style.visibility = '';
              privateNoteAnchor = null;
              setTimeout(flushPendingDataUpdate, 0);
            }

            function requestPrivateNotePreview(button) {
              clearPrivateNoteTimer('hover');
              clearPrivateNoteTimer('hide');
              const profileId = button && button.dataset.profileId;
              if (!profileId || !accountIds.has(profileId)) {
                return;
              }
              if (privateNoteProfileId && privateNoteProfileId !== profileId) {
                savePrivateNoteDraft();
              }
              const account = accounts.find((item) => item.id === profileId);
              privateNoteProfileId = profileId;
              privateNoteAnchor = button;
              privateNoteEditVersion = 0;
              privateNoteSavedVersion = 0;
              privateNoteRequestedVersion = -1;
              elements.privateNoteTitle.textContent =
                'Private note — ' + (account ? account.name : 'Account');
              elements.privateNoteEditor.value = '';
              elements.privateNoteEditor.disabled = true;
              elements.privateNoteTotpInput.value = '';
              elements.privateNoteTotpCode.hidden = true;
              elements.privateNoteTotpClear.disabled = true;
              elements.privateNoteTotpCountdown.textContent = 'Loading…';
              elements.privateNoteTotpStatus.textContent =
                'The secret is stored separately in VS Code SecretStorage.';
              stopPrivateNoteTotpTimer();
              stopPrivateNoteDetectionTimers();
              privateNoteDetectedTotp = [];
              privateNoteDetectionRefreshRequested = false;
              elements.privateNoteLines.textContent = '';
              setPrivateNoteStatus('Loading from protected storage…');
              elements.privateNotePopover.hidden = false;
              elements.privateNotePopover.style.visibility = 'hidden';
              positionPrivateNotePopover();
              const requestId = 'note-load-' + (++privateNoteRequestSequence);
              post('requestPrivateNotePreview', { profileId, requestId });
            }

            function schedulePrivateNotePreview(button) {
              clearPrivateNoteTimer('hover');
              clearPrivateNoteTimer('hide');
              if (
                !elements.privateNotePopover.hidden &&
                privateNoteProfileId === button.dataset.profileId
              ) {
                privateNoteAnchor = button;
                positionPrivateNotePopover();
                return;
              }
              privateNoteHoverTimer = setTimeout(
                () => requestPrivateNotePreview(button),
                privateNoteHoverDelayMs
              );
            }

            function schedulePrivateNoteHide() {
              clearPrivateNoteTimer('hide');
              privateNoteHideTimer = setTimeout(hidePrivateNotePopover, 280);
            }

            function applyNonInteractiveUpdate(data) {
              if (!data || typeof data !== 'object') {
                return;
              }
              if (typeof data.headerSubtitle === 'string') {
                elements.headerSubtitle.textContent = data.headerSubtitle;
              }
              if (typeof data.statsCardsHtml === 'string') {
                elements.statsCardsRoot.innerHTML = data.statsCardsHtml;
              }
              if (typeof data.summaryGridHtml === 'string') {
                elements.summaryGridRoot.innerHTML = data.summaryGridHtml;
              }
              if (typeof data.activeWindowsHtml === 'string') {
                elements.activeWindowsRoot.innerHTML = data.activeWindowsHtml;
              }
              if (typeof data.tokenUsageHtml === 'string') {
                elements.tokenUsageRoot.innerHTML = data.tokenUsageHtml;
              }
              elements.resetPaidLimitsButton.disabled =
                Number(data.paidRateLimitProfileCount) <= 0;
              elements.activateUnstartedCountersButton.disabled =
                Number(data.windowNotStartedCount) <= 0;
              elements.liveUpdateError.hidden = true;
              elements.liveUpdateError.textContent = '';
            }

            function applyInteractiveUpdate(data) {
              const scrollX = window.scrollX;
              const scrollY = window.scrollY;
              accounts = Array.isArray(data.accounts) ? data.accounts : [];
              groupChoices = Array.isArray(data.groupChoices) ? data.groupChoices : [];
              accountIds = new Set(accounts.map((account) => account.id));
              for (const profileId of [...selectedIds]) {
                if (!accountIds.has(profileId)) {
                  selectedIds.delete(profileId);
                }
              }
              for (const profileId of [...expandedProfileIds]) {
                if (!accountIds.has(profileId)) {
                  expandedProfileIds.delete(profileId);
                }
              }

              if (
                typeof data.quickPickSettingsHtml === 'string' &&
                typeof data.quickPickSettingsVersion === 'string' &&
                data.quickPickSettingsVersion !== quickPickSettingsVersion
              ) {
                elements.quickPickSettingsRoot.innerHTML = data.quickPickSettingsHtml;
                quickPickSettingsVersion = data.quickPickSettingsVersion;
                refreshQuickPickSettingElements();
              }

              if (
                typeof data.portableProfileVaultHtml === 'string' &&
                typeof data.portableProfileVaultVersion === 'string' &&
                data.portableProfileVaultVersion !== portableProfileVaultVersion
              ) {
                elements.portableProfileVaultRoot.innerHTML =
                  data.portableProfileVaultHtml;
                portableProfileVaultVersion = data.portableProfileVaultVersion;
              }

              setupFilters();
              renderAccounts();
              saveState();
              requestAnimationFrame(() => window.scrollTo(scrollX, scrollY));
            }

            function flushPendingDataUpdate() {
              if (!pendingDataUpdate || hasActiveControlInteraction()) {
                return;
              }
              const data = pendingDataUpdate;
              pendingDataUpdate = null;
              applyInteractiveUpdate(data);
            }

            function queueDataUpdate(data) {
              applyNonInteractiveUpdate(data);
              pendingDataUpdate = data;
              flushPendingDataUpdate();
            }

            function selectHasValue(select, value) {
              return [...select.options].some((option) => option.value === value);
            }

            function setSelectValue(select, value) {
              if (typeof value === 'string' && selectHasValue(select, value)) {
                select.value = value;
              }
            }

            function saveState() {
              vscode.setState({
                search: elements.searchInput.value,
                groupBy: elements.groupBySelect.value,
                statusFilter: elements.statusFilter.value,
                planFilter: elements.planFilter.value,
                sort: elements.sortSelect.value,
                profileSortKey,
                profileSortDirection,
                onlyProblems: elements.problemFilter.checked,
                selectedIds: [...selectedIds].filter((profileId) => accountIds.has(profileId)),
                expandedProfileIds: [...expandedProfileIds].filter((profileId) =>
                  accountIds.has(profileId)
                )
              });
            }

            function restoreState() {
              if (typeof savedState.search === 'string') {
                elements.searchInput.value = savedState.search;
              }
              setSelectValue(elements.groupBySelect, savedState.groupBy);
              setSelectValue(elements.statusFilter, savedState.statusFilter);
              setSelectValue(elements.planFilter, savedState.planFilter);
              setSelectValue(elements.sortSelect, savedState.sort);
              if (profileSortKey || elements.sortSelect.value !== 'default') {
                elements.groupBySelect.value = 'all';
              }
              elements.problemFilter.checked = savedState.onlyProblems === true;
              saveState();
            }

            function unique(values) {
              return [...new Set(values.filter(Boolean))].sort(displayCollator.compare);
            }

            function populateFilter(select, label, values) {
              const current = select.value;
              select.textContent = '';
              const allOption = document.createElement('option');
              allOption.value = '';
              allOption.textContent = label;
              select.appendChild(allOption);
              for (const value of values) {
                const option = document.createElement('option');
                option.value = value;
                option.textContent = value;
                select.appendChild(option);
              }
              select.value = [...select.options].some((option) => option.value === current) ? current : '';
            }

            function setupFilters() {
              populateFilter(elements.statusFilter, 'Any status', unique(accounts.map((account) => account.operationalStatus)));
              populateFilter(elements.planFilter, 'Any plan', unique(accounts.map((account) => account.plan)));
            }

            function accountSearchText(account) {
              return [
                account.name,
                account.email,
                account.plan,
                account.profileGroup,
                account.operationalStatus,
                account.authStatus,
                account.sourceText
              ].join(' ').toLowerCase();
            }

            function getFilteredAccounts() {
              const query = elements.searchInput.value.trim().toLowerCase();
              const status = elements.statusFilter.value;
              const plan = elements.planFilter.value;
              const onlyProblems = elements.problemFilter.checked;
              return accounts.filter((account) => {
                if (query && !accountSearchText(account).includes(query)) {
                  return false;
                }
                if (status && account.operationalStatus !== status) {
                  return false;
                }
                if (plan && account.plan !== plan) {
                  return false;
                }
                if (onlyProblems && !account.problem) {
                  return false;
                }
                return true;
              });
            }

            function getSortedAccounts(filteredAccounts) {
              if (profileSortKey) {
                const direction = profileSortDirection === 'desc' ? -1 : 1;
                return [...filteredAccounts].sort((left, right) => {
                  if (left.active !== right.active) {
                    return left.active ? -1 : 1;
                  }
                  const leftValue = left[profileSortKey];
                  const rightValue = right[profileSortKey];
                  const leftMissing = leftValue == null || leftValue === '' || leftValue === -1;
                  const rightMissing = rightValue == null || rightValue === '' || rightValue === -1;
                  if (leftMissing !== rightMissing) {
                    return leftMissing ? 1 : -1;
                  }

                  let comparison = 0;
                  if (typeof leftValue === 'number' && typeof rightValue === 'number') {
                    comparison = leftValue - rightValue;
                  } else if (profileSortKey === 'plan') {
                    comparison =
                      Number(left.planRank || 0) - Number(right.planRank || 0) ||
                      displayCollator.compare(left.plan, right.plan);
                  } else {
                    comparison = displayCollator.compare(leftValue, rightValue);
                  }
                  return comparison * direction || displayCollator.compare(left.name, right.name);
                });
              }

              const sortMode = elements.sortSelect.value;
              const sorted = [...filteredAccounts];
              const activeFirst = (left, right) => {
                return left.active === right.active ? 0 : left.active ? -1 : 1;
              };
              if (sortMode === 'name') {
                sorted.sort((left, right) => {
                  return activeFirst(left, right) || displayCollator.compare(left.name, right.name);
                });
              } else if (sortMode === 'plan') {
                sorted.sort((left, right) => {
                  return (
                    activeFirst(left, right) ||
                    Number(left.planRank || 0) - Number(right.planRank || 0) ||
                    displayCollator.compare(left.plan, right.plan) ||
                    displayCollator.compare(left.name, right.name)
                  );
                });
              } else if (sortMode === 'observed') {
                sorted.sort((left, right) => {
                  const activeComparison = activeFirst(left, right);
                  if (activeComparison) {
                    return activeComparison;
                  }
                  const leftMissing = !Number(left.observedAt);
                  const rightMissing = !Number(right.observedAt);
                  if (leftMissing !== rightMissing) {
                    return leftMissing ? 1 : -1;
                  }
                  return (
                    right.observedAt - left.observedAt ||
                    displayCollator.compare(left.name, right.name)
                  );
                });
              } else {
                sorted.sort((left, right) => {
                  return activeFirst(left, right) || left.index - right.index;
                });
              }
              return sorted;
            }

            function setProfileSort(sortKey) {
              if (!sortableColumnKeys.has(sortKey)) {
                return;
              }
              if (profileSortKey === sortKey) {
                profileSortDirection = profileSortDirection === 'asc' ? 'desc' : 'asc';
              } else {
                profileSortKey = sortKey;
                profileSortDirection = descendingDefaultSortKeys.has(sortKey) ? 'desc' : 'asc';
              }
              elements.sortSelect.value = 'default';
              elements.groupBySelect.value = 'all';
              saveState();
              renderAccounts();
            }

            function getGroupLabel(account) {
              const groupBy = elements.groupBySelect.value;
              if (groupBy === 'plan') {
                return account.plan || 'Unknown';
              }
              if (groupBy === 'group') {
                return account.profileGroup || 'Ungrouped';
              }
              if (groupBy === 'all') {
                return 'All accounts';
              }
              return account.operationalStatus || 'Unknown';
            }

            function addBadge(container, text, className) {
              const badge = document.createElement('span');
              badge.className = className ? 'badge ' + className : 'badge';
              badge.textContent = text;
              container.appendChild(badge);
            }

            function createProfileLimits(account) {
              const limits = document.createElement('div');
              limits.className = 'profile-card-limits';
              const primary = document.createElement('span');
              primary.className = 'limit-chip';
              primary.textContent = 'P ' + account.fiveHourCompactText;
              primary.title =
                'Primary ' +
                (account.primaryWindowLabel || 'limit') +
                ': ' +
                account.fiveHourText;
              limits.appendChild(primary);
              const weekly = document.createElement('span');
              weekly.className = 'limit-chip';
              weekly.textContent = 'W ' + account.weeklyCompactText;
              weekly.title = 'Weekly remaining: ' + account.weeklyText;
              limits.appendChild(weekly);
              return limits;
            }

            function createProfileIdentity(account) {
              const identity = document.createElement('div');
              identity.className = 'profile-card-identity';
              identity.appendChild(createProfileCheckbox(account));
              const name = document.createElement('div');
              name.className = 'profile-card-name';
              const nameText = document.createElement('span');
              nameText.className = 'profile-card-name-text';
              nameText.textContent = account.name;
              name.appendChild(nameText);
              if (account.active) {
                addBadge(name, 'ACTIVE');
              }
              if (account.weeklyLow) {
                addBadge(name, 'LOW', 'warning');
              }
              if (account.authIssue) {
                addBadge(name, 'AUTH', 'danger');
              }
              identity.appendChild(name);
              identity.appendChild(createProfileLimits(account));
              return identity;
            }

            function createProfileCheckbox(account) {
              const checkbox = document.createElement('input');
              checkbox.type = 'checkbox';
              checkbox.className = 'profile-card-checkbox';
              checkbox.dataset.profileId = account.id;
              checkbox.checked = selectedIds.has(account.id);
              checkbox.setAttribute('aria-label', 'Select ' + account.name);
              return checkbox;
            }

            function createGroupSelect(account) {
              const select = document.createElement('select');
              select.className = 'group-select';
              select.dataset.profileId = account.id;
              for (const group of groupChoices) {
                const option = document.createElement('option');
                option.value = group;
                option.textContent = group;
                select.appendChild(option);
              }
              const customOption = document.createElement('option');
              customOption.value = customGroupValue;
              customOption.textContent = 'Custom...';
              select.appendChild(customOption);
              select.value = groupChoices.includes(account.profileGroup) ? account.profileGroup : 'Ungrouped';
              select.title = 'Profile group';
              select.setAttribute('aria-label', 'Group for ' + account.name);
              return select;
            }

            function createProfileDetail(labelText, value) {
              const detail = document.createElement('div');
              detail.className = 'profile-detail';
              const label = document.createElement('span');
              label.className = 'profile-detail-label';
              label.textContent = labelText;
              detail.appendChild(label);
              const content = document.createElement('div');
              content.className = 'profile-detail-value';
              if (value instanceof Node) {
                content.appendChild(value);
              } else {
                content.textContent = value || 'n/a';
              }
              detail.appendChild(content);
              return detail;
            }

            function createProfileDetails(account) {
              const details = document.createElement('div');
              details.className = 'profile-card-details';
              details.id = 'profile-details-' + account.id;
              details.hidden = !expandedProfileIds.has(account.id);
              details.appendChild(createProfileDetail('Email', account.email));
              details.appendChild(createProfileDetail('Group', createGroupSelect(account)));
              details.appendChild(createProfileDetail('Plan', account.plan));
              details.appendChild(createProfileDetail('Status', account.operationalStatus));
              details.appendChild(
                createProfileDetail('Primary remaining', account.fiveHourText)
              );
              details.appendChild(
                createProfileDetail('Weekly remaining', account.weeklyText)
              );
              details.appendChild(createProfileDetail('Observed at', account.observedAtText));
              details.appendChild(createProfileDetail('Source', account.sourceText));
              return details;
            }

            function createProfileActions(account) {
              const actions = document.createElement('div');
              actions.className = 'profile-card-actions';

              const privateNote = document.createElement('button');
              privateNote.className = 'secondary compact-action private-note-trigger';
              privateNote.dataset.action = 'private-note';
              privateNote.dataset.profileId = account.id;
              privateNote.textContent = '🗒️';
              privateNote.setAttribute('aria-label', 'Open private note for ' + account.name);
              privateNote.title = 'Private note and 2FA';
              actions.appendChild(privateNote);

              const activate = document.createElement('button');
              activate.className = 'secondary compact-action';
              activate.dataset.action = 'activate';
              activate.dataset.profileId = account.id;
              activate.textContent = account.active ? '✓' : '▶';
              activate.disabled = account.active;
              activate.title = account.active ? 'Active in this window' : 'Activate profile';
              activate.setAttribute(
                'aria-label',
                account.active ? account.name + ' is active' : 'Activate ' + account.name
              );
              actions.appendChild(activate);

              const rename = document.createElement('button');
              rename.className = 'secondary compact-action';
              rename.dataset.action = 'rename';
              rename.dataset.profileId = account.id;
              rename.textContent = '✎';
              rename.title = 'Rename profile';
              rename.setAttribute('aria-label', 'Rename ' + account.name);
              actions.appendChild(rename);

              const reauth = document.createElement('button');
              reauth.className = 'secondary compact-action';
              reauth.dataset.action = 'reauth';
              reauth.dataset.profileId = account.id;
              reauth.textContent = '↻';
              reauth.title = 'Re-authenticate profile';
              reauth.setAttribute('aria-label', 'Re-authenticate ' + account.name);
              actions.appendChild(reauth);

              const remove = document.createElement('button');
              remove.className = 'danger compact-action compact-delete';
              remove.dataset.action = 'delete';
              remove.dataset.profileId = account.id;
              remove.textContent = '×';
              remove.title = 'Delete profile';
              remove.setAttribute('aria-label', 'Delete ' + account.name);
              actions.appendChild(remove);

              const details = document.createElement('button');
              const expanded = expandedProfileIds.has(account.id);
              details.className = 'secondary compact-action profile-details-toggle';
              details.dataset.action = 'toggle-profile-details';
              details.dataset.profileId = account.id;
              details.textContent = expanded ? '▾' : '▸';
              details.title = expanded ? 'Hide profile details' : 'Show profile details';
              details.setAttribute('aria-label', details.title + ' for ' + account.name);
              details.setAttribute('aria-expanded', expanded ? 'true' : 'false');
              details.setAttribute('aria-controls', 'profile-details-' + account.id);
              actions.appendChild(details);

              return actions;
            }

            function createSortBar() {
              const sortBar = document.createElement('div');
              sortBar.className = 'profile-sort-bar';
              const label = document.createElement('span');
              label.className = 'muted';
              label.textContent = 'Sort:';
              sortBar.appendChild(label);
              [
                { label: 'Name', sortKey: 'name' },
                { label: 'Group', sortKey: 'profileGroup' },
                { label: 'Plan', sortKey: 'plan' },
                { label: 'Status', sortKey: 'operationalStatus' },
                { label: 'Primary remaining', shortLabel: 'Primary', sortKey: 'fiveHourRemaining' },
                { label: 'Weekly remaining', shortLabel: 'Weekly', sortKey: 'weeklyRemaining' },
                { label: 'Observed at', shortLabel: 'Observed', sortKey: 'observedAt' },
                { label: 'Source', sortKey: 'sourceText' }
              ].forEach(({ label: fullLabel, shortLabel, sortKey }) => {
                const button = document.createElement('button');
                const active = profileSortKey === sortKey;
                button.className = active ? 'profile-sort-button active' : 'profile-sort-button';
                button.dataset.action = 'sort-profile';
                button.dataset.sortKey = sortKey;
                button.textContent =
                  (shortLabel || fullLabel) +
                  (active ? (profileSortDirection === 'asc' ? ' ▲' : ' ▼') : '');
                button.title = active ? 'Reverse sort direction' : 'Sort by ' + fullLabel;
                button.setAttribute(
                  'aria-sort',
                  active
                    ? profileSortDirection === 'asc'
                      ? 'ascending'
                      : 'descending'
                    : 'none'
                );
                sortBar.appendChild(button);
              });
              return sortBar;
            }

            function createProfileCards(accountsInGroup) {
              const cards = document.createElement('div');
              cards.className = 'profile-cards';
              for (const account of accountsInGroup) {
                const card = document.createElement('article');
                card.className = [
                  'profile-card',
                  account.active ? 'active-profile' : '',
                  account.windowNotStarted ? 'not-started-profile' : '',
                  account.problem ? 'problem-profile' : '',
                  account.authIssue ? 'auth-problem-profile' : ''
                ].filter(Boolean).join(' ');
                card.title = [account.operationalStatus, account.observedAtText, account.sourceText]
                  .filter(Boolean)
                  .join(' · ');
                const main = document.createElement('div');
                main.className = 'profile-card-main';
                main.appendChild(createProfileIdentity(account));
                main.appendChild(createProfileActions(account));
                card.appendChild(main);
                card.appendChild(createProfileDetails(account));
                cards.appendChild(card);
              }
              return cards;
            }

            function renderAccounts() {
              const filtered = getSortedAccounts(getFilteredAccounts());
              elements.visibleCount.textContent = filtered.length === accounts.length
                ? accounts.length + ' shown'
                : filtered.length + ' of ' + accounts.length + ' shown';
              elements.accountsRoot.textContent = '';

              if (!accounts.length) {
                const empty = document.createElement('div');
                empty.className = 'empty';
                empty.textContent = 'No saved accounts.';
                elements.accountsRoot.appendChild(empty);
                updateBulkBar();
                return;
              }

              if (!filtered.length) {
                const empty = document.createElement('div');
                empty.className = 'empty';
                empty.textContent = 'No accounts match the current filters.';
                elements.accountsRoot.appendChild(empty);
                updateBulkBar();
                return;
              }

              const grouped = new Map();
              for (const account of filtered) {
                const group = getGroupLabel(account);
                if (!grouped.has(group)) {
                  grouped.set(group, []);
                }
                grouped.get(group).push(account);
              }

              elements.accountsRoot.appendChild(createSortBar());

              for (const [group, accountsInGroup] of grouped) {
                const section = document.createElement('section');
                section.className = 'group-section';
                const title = document.createElement('div');
                title.className = 'group-title';
                const name = document.createElement('span');
                name.textContent = group;
                const count = document.createElement('span');
                count.className = 'muted';
                count.textContent = accountsInGroup.length + ' account' + (accountsInGroup.length === 1 ? '' : 's');
                title.appendChild(name);
                title.appendChild(count);
                section.appendChild(title);
                section.appendChild(createProfileCards(accountsInGroup));
                elements.accountsRoot.appendChild(section);
              }

              updateBulkBar();
            }

            function updateBulkBar() {
              const count = selectedIds.size;
              elements.bulkBar.hidden = count === 0;
              elements.selectedCount.textContent = count + ' selected';
            }

            document.addEventListener('click', (event) => {
              const button = event.target.closest('button[data-action]');
              if (!button) {
                return;
              }

              const action = button.dataset.action;
              const profileId = button.dataset.profileId;
              if (action === 'refresh') {
                post('refresh');
              } else if (action === 'reset-paid-limits') {
                post('resetPaidProfileLimits');
              } else if (action === 'activate-unstarted-counters') {
                post('activateUnstartedCounters');
              } else if (action === 'sort-profile') {
                setProfileSort(button.dataset.sortKey);
              } else if (action === 'open-command') {
                post('openCommand', { action: button.dataset.commandAction });
              } else if (action === 'portable-vault-enable') {
                post('enablePortableProfileVault');
              } else if (action === 'portable-vault-import') {
                post('importPortableProfileVault', { keepSynchronized: false });
              } else if (action === 'portable-vault-import-sync') {
                post('importPortableProfileVault', { keepSynchronized: true });
              } else if (action === 'portable-vault-sync') {
                post('syncPortableProfileVault');
              } else if (action === 'portable-vault-change-password') {
                post('changePortableProfileVaultPassword');
              } else if (action === 'portable-vault-disable') {
                post('disablePortableProfileVault');
              } else if (action === 'portable-vault-open-folder') {
                post('openPortableProfileVaultFolder');
              } else if (action === 'private-note') {
                hidePrivateNotePopover();
                post('openPrivateNote', { profileId });
              } else if (action === 'private-note-close') {
                hidePrivateNotePopover();
              } else if (action === 'private-note-save') {
                savePrivateNoteDraft();
              } else if (action === 'private-note-open-full') {
                const noteProfileId = privateNoteProfileId;
                hidePrivateNotePopover();
                if (noteProfileId) {
                  post('openPrivateNote', { profileId: noteProfileId });
                }
              } else if (action === 'private-note-copy-line') {
                const lineIndex = Number(button.dataset.lineIndex);
                const lines = getPrivateNoteLines();
                if (
                  privateNoteProfileId &&
                  Number.isInteger(lineIndex) &&
                  lineIndex >= 0 &&
                  lineIndex < lines.length
                ) {
                  setPrivateNoteStatus('Copying line…');
                  post('copyPrivateNoteLine', {
                    profileId: privateNoteProfileId,
                    requestId: 'note-copy-' + (++privateNoteRequestSequence),
                    value: lines[lineIndex]
                  });
                }
              } else if (action === 'private-note-copy-detected-totp') {
                const detection = privateNoteDetectedTotp.find(
                  (item) => item.id === button.dataset.detectedTotpId
                );
                if (privateNoteProfileId && detection) {
                  setPrivateNoteStatus('Copying detected 2FA code…');
                  post('copyPrivateNoteLine', {
                    profileId: privateNoteProfileId,
                    requestId: 'note-copy-detected-' + (++privateNoteRequestSequence),
                    value: detection.code
                  });
                }
              } else if (action === 'private-note-save-totp') {
                const value = elements.privateNoteTotpInput.value.trim();
                if (!value) {
                  elements.privateNoteTotpStatus.textContent =
                    'Enter a Base32 secret or otpauth:// URI first.';
                } else if (privateNoteProfileId) {
                  elements.privateNoteTotpStatus.textContent = 'Saving 2FA securely…';
                  post('savePrivateNoteTotp', {
                    profileId: privateNoteProfileId,
                    requestId: 'note-totp-save-' + (++privateNoteRequestSequence),
                    value
                  });
                }
              } else if (action === 'private-note-clear-totp') {
                if (privateNoteProfileId) {
                  elements.privateNoteTotpStatus.textContent = 'Removing 2FA…';
                  post('clearPrivateNoteTotp', {
                    profileId: privateNoteProfileId,
                    requestId: 'note-totp-clear-' + (++privateNoteRequestSequence)
                  });
                }
              } else if (action === 'private-note-copy-totp') {
                if (privateNoteProfileId) {
                  elements.privateNoteTotpStatus.textContent = 'Copying current code…';
                  post('copyPrivateNoteTotp', {
                    profileId: privateNoteProfileId,
                    requestId: 'note-totp-copy-' + (++privateNoteRequestSequence)
                  });
                }
              } else if (action === 'activate') {
                post('activateProfile', { profileId });
              } else if (action === 'rename') {
                post('renameProfile', { profileId });
              } else if (action === 'reauth') {
                post('reauthenticateProfile', { profileId });
              } else if (action === 'delete') {
                post('deleteProfile', { profileId });
              } else if (action === 'toggle-profile-details') {
                if (expandedProfileIds.has(profileId)) {
                  expandedProfileIds.delete(profileId);
                } else {
                  expandedProfileIds.add(profileId);
                }
                saveState();
                renderAccounts();
              } else if (action === 'bulk-delete') {
                post('deleteSelectedProfiles', { profileIds: [...selectedIds] });
              } else if (action === 'bulk-group') {
                post('promptSelectedGroup', { profileIds: [...selectedIds] });
              } else if (action === 'quickpick-section-up') {
                post('moveQuickPickSection', {
                  sectionId: button.dataset.sectionId,
                  direction: 'up'
                });
              } else if (action === 'quickpick-section-down') {
                post('moveQuickPickSection', {
                  sectionId: button.dataset.sectionId,
                  direction: 'down'
                });
              }
            });

            document.addEventListener('change', (event) => {
              const target = event.target;
              if (target.matches('input[type="checkbox"][data-profile-id]')) {
                if (target.checked) {
                  selectedIds.add(target.dataset.profileId);
                } else {
                  selectedIds.delete(target.dataset.profileId);
                }
                saveState();
                updateBulkBar();
                return;
              }

              if (target.matches('select.group-select')) {
                if (target.value === customGroupValue) {
                  post('promptProfileGroup', { profileId: target.dataset.profileId });
                } else {
                  post('setProfileGroup', {
                    profileId: target.dataset.profileId,
                    group: target.value
                  });
                }
                return;
              }

              if (target.matches('input[data-quickpick-section]')) {
                post('setQuickPickSectionVisibility', {
                  sectionId: target.dataset.quickpickSection,
                  visible: target.checked
                });
                return;
              }

              if (target === elements.quickPickSortSelect) {
                post('setQuickPickProfileSort', { sortMode: target.value });
                return;
              }

              if (target === elements.quickPickSecondarySortSelect) {
                post('setQuickPickSecondaryProfileSort', { sortMode: target.value });
                return;
              }

              if (target === elements.roundLowWeeklyRemainingInput) {
                post('setRoundLowWeeklyRemainingToZero', { enabled: target.checked });
                return;
              }

              if (target === elements.lowWeeklyRemainingZeroThresholdInput) {
                post('setLowWeeklyRemainingZeroThreshold', { threshold: Number(target.value) });
                return;
              }

              if (
                target === elements.groupBySelect ||
                target === elements.statusFilter ||
                target === elements.planFilter ||
                target === elements.sortSelect ||
                target === elements.problemFilter
              ) {
                if (target === elements.sortSelect) {
                  profileSortKey = null;
                  profileSortDirection = 'asc';
                  if (target.value !== 'default') {
                    elements.groupBySelect.value = 'all';
                  }
                } else if (
                  target === elements.groupBySelect &&
                  target.value !== 'all'
                ) {
                  profileSortKey = null;
                  profileSortDirection = 'asc';
                  elements.sortSelect.value = 'default';
                }
                saveState();
                renderAccounts();
              }
            });

            elements.searchInput.addEventListener('input', () => {
              saveState();
              renderAccounts();
            });

            elements.privateNoteEditor.addEventListener('input', () => {
              privateNoteEditVersion += 1;
              setPrivateNoteStatus('Unsaved changes');
              renderPrivateNoteLines();
              schedulePrivateNoteDetectedTotp();
              clearPrivateNoteTimer('save');
              privateNoteSaveTimer = setTimeout(savePrivateNoteDraft, 800);
              positionPrivateNotePopover();
            });

            elements.privateNoteEditor.addEventListener('keydown', (event) => {
              if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
                event.preventDefault();
                savePrivateNoteDraft();
              }
            });

            document.addEventListener('pointerover', (event) => {
              const trigger = event.target.closest('.private-note-trigger');
              if (trigger) {
                if (event.relatedTarget && trigger.contains(event.relatedTarget)) {
                  return;
                }
                schedulePrivateNotePreview(trigger);
                return;
              }
              if (event.target.closest('#privateNotePopover')) {
                clearPrivateNoteTimer('hide');
              }
            });

            document.addEventListener('pointerout', (event) => {
              const fromTrigger = event.target.closest('.private-note-trigger');
              const fromPopover = event.target.closest('#privateNotePopover');
              if (!fromTrigger && !fromPopover) {
                return;
              }
              const destination = event.relatedTarget;
              if (
                destination &&
                (
                  destination.closest('.private-note-trigger') ||
                  destination.closest('#privateNotePopover')
                )
              ) {
                return;
              }
              schedulePrivateNoteHide();
            });

            document.addEventListener('focusin', (event) => {
              const trigger = event.target.closest('.private-note-trigger');
              if (trigger) {
                schedulePrivateNotePreview(trigger);
              } else if (event.target.closest('#privateNotePopover')) {
                clearPrivateNoteTimer('hide');
              }
            });

            document.addEventListener('focusout', (event) => {
              if (
                !event.target.closest('.private-note-trigger') &&
                !event.target.closest('#privateNotePopover')
              ) {
                return;
              }
              const destination = event.relatedTarget;
              if (
                destination &&
                (
                  destination.closest('.private-note-trigger') ||
                  destination.closest('#privateNotePopover')
                )
              ) {
                return;
              }
              schedulePrivateNoteHide();
            });

            document.addEventListener('focusout', () => {
              setTimeout(flushPendingDataUpdate, 0);
            });

            window.addEventListener('resize', positionPrivateNotePopover);
            document.addEventListener('scroll', positionPrivateNotePopover, true);
            document.addEventListener('keydown', (event) => {
              if (event.key === 'Escape' && !elements.privateNotePopover.hidden) {
                hidePrivateNotePopover();
              }
            });

            window.addEventListener('message', (event) => {
              const message = event.data;
              if (!message || typeof message !== 'object') {
                return;
              }
              if (message.command === 'updateData') {
                queueDataUpdate(message.data);
              } else if (message.command === 'updateError') {
                elements.liveUpdateError.textContent =
                  'Failed to update account data: ' + (message.message || 'Unknown error');
                elements.liveUpdateError.hidden = false;
              } else if (
                message.command === 'privateNotePreview' &&
                message.profileId === privateNoteProfileId
              ) {
                elements.privateNoteEditor.disabled = false;
                elements.privateNoteEditor.value =
                  typeof message.note === 'string' ? message.note : '';
                privateNoteEditVersion = 0;
                privateNoteSavedVersion = 0;
                privateNoteRequestedVersion = -1;
                renderPrivateNoteLines();
                applyPrivateNoteTotp(message.totp);
                requestPrivateNoteDetectedTotp();
                setPrivateNoteStatus('Stored with VS Code SecretStorage');
                positionPrivateNotePopover();
              } else if (message.command === 'privateNoteSaved') {
                const savedVersion = privateNoteSaveRequests.get(message.requestId);
                privateNoteSaveRequests.delete(message.requestId);
                if (message.profileId === privateNoteProfileId && savedVersion != null) {
                  privateNoteSavedVersion = Math.max(privateNoteSavedVersion, savedVersion);
                  if (privateNoteSavedVersion === privateNoteEditVersion) {
                    setPrivateNoteStatus('Saved securely');
                  } else {
                    setPrivateNoteStatus('Unsaved changes');
                    clearPrivateNoteTimer('save');
                    privateNoteSaveTimer = setTimeout(savePrivateNoteDraft, 800);
                  }
                }
              } else if (
                message.command === 'privateNoteLineCopied' &&
                message.profileId === privateNoteProfileId
              ) {
                setPrivateNoteStatus('Line copied');
              } else if (
                message.command === 'privateNoteTotpUpdated' &&
                message.profileId === privateNoteProfileId
              ) {
                elements.privateNoteTotpInput.value = '';
                applyPrivateNoteTotp(message.totp);
                elements.privateNoteTotpStatus.textContent =
                  message.totp && message.totp.configured
                    ? '2FA is stored securely. The secret is hidden.'
                    : '2FA removed from protected storage.';
                positionPrivateNotePopover();
              } else if (
                message.command === 'privateNoteTotpCopied' &&
                message.profileId === privateNoteProfileId
              ) {
                applyPrivateNoteTotp(message.totp);
                elements.privateNoteTotpStatus.textContent = 'Current 2FA code copied';
              } else if (
                message.command === 'privateNoteDetectedTotp' &&
                message.profileId === privateNoteProfileId &&
                message.requestId === privateNoteDetectionLatestRequestId
              ) {
                stopPrivateNoteDetectionTimers();
                privateNoteDetectionRefreshRequested = false;
                privateNoteDetectedTotp = Array.isArray(message.detections)
                  ? message.detections
                  : [];
                renderPrivateNoteLines();
                if (privateNoteDetectedTotp.length) {
                  privateNoteDetectionTimer = setInterval(
                    refreshDetectedTotpButtons,
                    1000
                  );
                }
                positionPrivateNotePopover();
              }
            });

            setupFilters();
            restoreState();
            renderAccounts();
            post('ready');
          </script>
        </body>
      </html>`;
  }
}

module.exports = {
  RateLimitDetailsPanel
};
