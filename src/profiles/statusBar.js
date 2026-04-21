'use strict';

const vscode = require('vscode');
const { createProfileTooltip } = require('./tooltipBuilder');
const { formatCompactRateSummary, getProfileRateStatus } = require('./profileStatus');

function getStatusBarColor(percentage, cooldownActive) {
  const config = vscode.workspace.getConfiguration('codexRatelimit');
  const colorsEnabled = config.get('color.enable', true);
  if (!colorsEnabled) {
    return new vscode.ThemeColor('statusBarItem.foreground');
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

class ProfileStatusBarController {
  constructor() {
    this.statusBarItem = vscode.window.createStatusBarItem(
      'codex-switch.profile',
      vscode.StatusBarAlignment.Right,
      100
    );
    this.update(null, []);
    this.statusBarItem.show();
  }

  update(activeProfile, profiles) {
    const allProfiles = profiles || [];
    if (!activeProfile) {
      this.statusBarItem.text = '$(account) 5H n/a | W n/a';
      this.statusBarItem.command = 'codex-switch.profile.manage';
      this.statusBarItem.color = new vscode.ThemeColor('statusBarItem.foreground');
      this.statusBarItem.tooltip = createProfileTooltip(null, allProfiles);
      return;
    }

    const status = getProfileRateStatus(activeProfile);
    this.statusBarItem.text = `$(account) ${formatCompactRateSummary(status, Date.now(), {
      includePrimaryCountdown: true,
      includeSecondaryCountdown: false,
      percentageMode: 'remaining'
    })}`;
    this.statusBarItem.command =
      allProfiles.length === 0 ? 'codex-switch.profile.manage' : 'codex-switch.profile.switch';
    this.statusBarItem.color = getStatusBarColor(status.maxUsedPercent, status.cooldownActive);
    this.statusBarItem.tooltip = createProfileTooltip(activeProfile, allProfiles);
  }

  show() {
    this.statusBarItem.show();
  }

  dispose() {
    this.statusBarItem.dispose();
  }
}

module.exports = {
  ProfileStatusBarController,
  getStatusBarColor
};
