'use strict';

const vscode = require('vscode');
const { areProfileFeaturesEnabled } = require('./featureFlags');
const { createProfileTooltip } = require('./tooltipBuilder');
const {
  formatCompactRateSummary,
  getProfileRateStatus,
  isProfileWeeklyTokensLow
} = require('./profileStatus');
const { getProfileQuickPickSettings } = require('./quickPickSettings');
const { displayProfileName } = require('./privacy');

function getStatusBarColor(percentage, cooldownActive, weeklyTokensLow = false) {
  const config = vscode.workspace.getConfiguration('codexRatelimit');
  const colorsEnabled = config.get('color.enable', true);
  if (!colorsEnabled) {
    return new vscode.ThemeColor('statusBarItem.foreground');
  }

  if (weeklyTokensLow) {
    return new vscode.ThemeColor('disabledForeground');
  }

  const warningThreshold = config.get('color.warningThreshold', 70);
  const warningColor = config.get('color.warningColor', '#f3d898');
  const criticalThreshold = config.get('color.criticalThreshold', 90);
  const criticalColor = config.get('color.criticalColor', '#eca7a7');

  if (cooldownActive || percentage >= criticalThreshold) {
    return criticalColor;
  }
  if (percentage >= warningThreshold) {
    return warningColor;
  }
  return new vscode.ThemeColor('statusBarItem.foreground');
}

function formatStatusBarProfileName(profileOrName) {
  const normalized =
    typeof profileOrName === 'object'
      ? displayProfileName(profileOrName)
      : String(profileOrName || '').trim();
  if (!normalized) {
    return 'profile';
  }

  const maxLength = 16;
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 3)}...`;
}

function getStatusBarColorIdentity(color) {
  if (typeof color === 'string') {
    return `string:${color}`;
  }
  if (color && typeof color.id === 'string') {
    return `theme:${color.id}`;
  }
  return color;
}

function getStableTooltipValue(tooltip) {
  return String((tooltip && tooltip.value) || '').replace(
    /(resets in )[^\r\n<|]+/gi,
    '$1<countdown>'
  );
}

class ProfileStatusBarController {
  constructor() {
    this.statusBarItem = vscode.window.createStatusBarItem(
      'codex-switch.profile',
      vscode.StatusBarAlignment.Right,
      100
    );
    this.isVisible = false;
    this.update(null, []);
  }

  setVisible(visible) {
    if (this.isVisible === visible) {
      return;
    }

    this.isVisible = visible;
    if (visible) {
      this.statusBarItem.show();
      return;
    }
    this.statusBarItem.hide();
  }

  updateTooltip(tooltip) {
    if (
      getStableTooltipValue(this.statusBarItem.tooltip) ===
      getStableTooltipValue(tooltip)
    ) {
      return;
    }
    this.statusBarItem.tooltip = tooltip;
  }

  update(activeProfile, profiles, otherWindowProfileUsageByProfileId) {
    if (!areProfileFeaturesEnabled()) {
      this.setVisible(false);
      return;
    }

    const allProfiles = profiles || [];
    if (!activeProfile) {
      const text = '$(account) Primary n/a | W n/a';
      const command = 'codex-switch.profile.manage';
      const color = new vscode.ThemeColor('statusBarItem.foreground');
      const tooltip = createProfileTooltip(
        null,
        allProfiles,
        otherWindowProfileUsageByProfileId
      );
      if (this.statusBarItem.text !== text) {
        this.statusBarItem.text = text;
      }
      if (this.statusBarItem.command !== command) {
        this.statusBarItem.command = command;
      }
      if (
        getStatusBarColorIdentity(this.statusBarItem.color) !==
        getStatusBarColorIdentity(color)
      ) {
        this.statusBarItem.color = color;
      }
      this.updateTooltip(tooltip);
      this.setVisible(true);
      return;
    }

    const now = Date.now();
    const quickPickSettings = getProfileQuickPickSettings();
    const lowWeeklyOptions = {
      activeProfileId: activeProfile.id,
      lowRemainingPercentThreshold: quickPickSettings.lowWeeklyRemainingZeroThreshold
    };
    const status = getProfileRateStatus(activeProfile, now, {
      activeProfileId: activeProfile.id
    });
    const text = `$(account) ${formatStatusBarProfileName(activeProfile)}: ${formatCompactRateSummary(status, now, {
      includePrimaryCountdown: false,
      includeSecondaryCountdown: false,
      percentageMode: 'remaining',
      roundLowWeeklyRemainingToZero: quickPickSettings.roundLowWeeklyRemainingToZero,
      lowRemainingPercentThreshold: quickPickSettings.lowWeeklyRemainingZeroThreshold
    })}`;
    const command =
      allProfiles.length === 0 ? 'codex-switch.profile.manage' : 'codex-switch.profile.switch';
    const color = getStatusBarColor(
      status.maxUsedPercent,
      status.cooldownActive,
      isProfileWeeklyTokensLow(activeProfile, now, lowWeeklyOptions)
    );
    const tooltip = createProfileTooltip(
      activeProfile,
      allProfiles,
      otherWindowProfileUsageByProfileId
    );

    if (this.statusBarItem.text !== text) {
      this.statusBarItem.text = text;
    }
    if (this.statusBarItem.command !== command) {
      this.statusBarItem.command = command;
    }
    if (
      getStatusBarColorIdentity(this.statusBarItem.color) !==
      getStatusBarColorIdentity(color)
    ) {
      this.statusBarItem.color = color;
    }
    this.updateTooltip(tooltip);
    this.setVisible(true);
  }

  show() {
    this.setVisible(areProfileFeaturesEnabled());
  }

  dispose() {
    this.isVisible = false;
    this.statusBarItem.dispose();
  }
}

module.exports = {
  ProfileStatusBarController,
  getStatusBarColor
};
