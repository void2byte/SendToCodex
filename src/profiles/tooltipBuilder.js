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
      'codex-ratelimit.refreshStats',
      'codex-ratelimit.showDetails'
    ]
  };

  tooltip.appendMarkdown('Codex accounts\n\n');

  if (!profiles || profiles.length === 0) {
    tooltip.appendMarkdown('No profiles yet.\n\n');
  } else {
    const activeId = activeProfile ? activeProfile.id : undefined;
    const now = Date.now();
    for (const profile of profiles) {
      const status = getProfileRateStatus(profile);
      const switchUri = buildCommandUri('codex-switch.profile.activate', [profile.id]);
      const plan = escapeMarkdown(formatPlanType(profile.planType));
      const linkedName = `[${escapeMarkdown(profile.name)}](${switchUri})`;
      const email = profile.email && profile.email !== 'Unknown' ? ` - ${escapeMarkdown(profile.email)}` : '';
      const activeSuffix = activeId === profile.id ? ' **(Active)**' : '';
      const summary = escapeMarkdown(
        formatCompactRateSummary(status, now, {
          includePrimaryCountdown: true,
          includeSecondaryCountdown: true,
          percentageMode: 'remaining'
        })
      );

      tooltip.appendMarkdown(
        `* ${linkedName} - ${plan} - ${summary}${email}${activeSuffix}\n`
      );
    }

    tooltip.appendMarkdown('\n');
  }

  tooltip.appendMarkdown('---\n\n');
  tooltip.appendMarkdown(
    '[Switch profile](command:codex-switch.profile.switch) • [Manage profiles](command:codex-switch.profile.manage) • [Rate limit details](command:codex-ratelimit.showDetails) • [Refresh limits](command:codex-ratelimit.refreshStats)\n\n'
  );
  return tooltip;
}

module.exports = {
  createProfileTooltip
};
