'use strict';

const vscode = require('vscode');
const {
  formatCompactRateSummary,
  getProfileRateStatus,
  formatPlanType
} = require('./profileStatus');

function escapeMarkdown(text) {
  return String(text || '').replace(/\\/g, '\\\\').replace(/([`*_{}[\]()#+\-.!])/g, '\\$1');
}

function buildCommandUri(command, args) {
  return `command:${command}?${encodeURIComponent(JSON.stringify(args || []))}`;
}

function createProfileTooltip(activeProfile, profiles) {
  const tooltip = new vscode.MarkdownString();
  tooltip.supportThemeIcons = true;
  tooltip.supportHtml = true;
  tooltip.isTrusted = {
    enabledCommands: [
      'codex-switch.profile.manage',
      'codex-switch.profile.activate',
      'codex-switch.profile.switch',
      'codexTerminalRecorder.openSettings',
      'codex-ratelimit.refreshStats',
      'codex-ratelimit.showDetails'
    ]
  };

  if (!profiles || profiles.length === 0) {
    tooltip.appendMarkdown('No profiles yet.\n\n');
  } else {
    const activeId = activeProfile ? activeProfile.id : undefined;
    const now = Date.now();
    const sortedProfiles = [...profiles].sort((left, right) => {
      const leftActive = left.id === activeId;
      const rightActive = right.id === activeId;
      if (leftActive !== rightActive) {
        return leftActive ? -1 : 1;
      }
      return left.name.localeCompare(right.name);
    });

    for (const profile of sortedProfiles) {
      const status = getProfileRateStatus(profile);
      const switchUri = buildCommandUri('codex-switch.profile.activate', [profile.id]);
      const plan = escapeMarkdown(formatPlanType(profile.planType));
      const linkedName = `[${escapeMarkdown(profile.name)}](${switchUri})`;
      const email = profile.email && profile.email !== 'Unknown' ? ` - ${escapeMarkdown(profile.email)}` : '';
      const activePrefix = activeId === profile.id ? '**ACTIVE** ' : '';
      const summary = escapeMarkdown(
        formatCompactRateSummary(status, now, {
          includePrimaryCountdown: true,
          includeSecondaryCountdown: true,
          percentageMode: 'remaining'
        })
      );

      tooltip.appendMarkdown(
        `* ${activePrefix}${linkedName} - ${plan} - ${summary}${email}\n`
      );
    }

    tooltip.appendMarkdown('\n');
  }

  tooltip.appendMarkdown(formatReloadWarning());
  tooltip.appendMarkdown('\n');
  tooltip.appendMarkdown('---\n\n');
  tooltip.appendMarkdown(
    '[Switch profile](command:codex-switch.profile.switch) • [Manage profiles](command:codex-switch.profile.manage) • [Send to Codex settings](command:codexTerminalRecorder.openSettings) • [Rate limit details](command:codex-ratelimit.showDetails) • [Refresh limits](command:codex-ratelimit.refreshStats)\n\n'
  );
  return tooltip;
}

function formatReloadWarning() {
  const reloadAfterSwitch = vscode.workspace
    .getConfiguration('codexSwitch')
    .get('reloadWindowAfterProfileSwitch', false);

  return reloadAfterSwitch
    ? '$(warning) VS Code window will reload after switching accounts.\n'
    : '$(warning) After switching accounts, a VS Code window reload may be required.\n';
}

module.exports = {
  createProfileTooltip
};
