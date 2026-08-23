'use strict';

const vscode = require('vscode');
const path = require('path');
const {
  formatCompactRateSummary,
  getProfileRateStatus,
  formatPlanType,
  getWindowRemainingPercent,
  isProfileWeeklyTokensLow,
  sortProfilesForDisplay
} = require('./profileStatus');
const {
  formatLowRemainingPercentThreshold,
  getProfileQuickPickSettings
} = require('./quickPickSettings');
const { displayProfileName } = require('./privacy');

function escapeMarkdown(text) {
  return String(text || '').replace(/\\/g, '\\\\').replace(/([`*_{}[\]()#+\-.!|])/g, '\\$1');
}

function escapeHtml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeHtmlAttribute(text) {
  return escapeHtml(text);
}

const DIM_TOOLTIP_COLOR = '#858585';

function dimHtml(text) {
  return `<font color="${DIM_TOOLTIP_COLOR}">${text}</font>`;
}

function dimWindowUsageHtml(windowUsage) {
  const match = String(windowUsage || '').match(/^\$\(window\)(.*)$/);
  if (!match) {
    return dimHtml(windowUsage);
  }

  return `$(window)${match[1] ? ` ${dimHtml(match[1].trim())}` : ''}`;
}

function buildCommandUri(command, args) {
  return `command:${command}?${encodeURIComponent(JSON.stringify(args || []))}`;
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

function getCurrentWindowUsageLabel() {
  if (vscode.workspace.name) {
    return formatWindowUsageLabel(vscode.workspace.name) || 'This window';
  }

  const folder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
  if (folder && folder.uri && folder.uri.fsPath) {
    return formatWindowUsageLabel(path.basename(folder.uri.fsPath) || folder.uri.fsPath) ||
      'This window';
  }

  return 'This window';
}

function formatWindowUsage(entries, options = {}) {
  const includeCurrentWindow = options.includeCurrentWindow === true;
  if ((!entries || !entries.length) && !includeCurrentWindow) {
    return '';
  }

  const currentWindowLabel = includeCurrentWindow
    ? formatWindowUsageLabel(options.currentWindowLabel) || getCurrentWindowUsageLabel()
    : null;
  const labels = [...new Set(
    (currentWindowLabel ? [{ workspaceLabel: currentWindowLabel }] : [])
      .concat(entries || [])
      .map((entry) => formatWindowUsageLabel(entry && entry.workspaceLabel))
      .filter(Boolean)
  )];
  const visibleLabels = labels.slice(0, 2).map(escapeMarkdown);
  const hiddenCount = Math.max(0, labels.length - visibleLabels.length);
  const suffix = hiddenCount > 0 ? `, +${hiddenCount}` : '';
  return `$(window)${visibleLabels.length ? ` ${visibleLabels.join(', ')}${suffix}` : ''}`;
}

function hasZeroRemainingLimit(status, now) {
  return [status && status.primary, status && status.secondary].some((windowState) => {
    return getWindowRemainingPercent(windowState, now) === 0;
  });
}

function createProfileTooltip(activeProfile, profiles, otherWindowProfileUsageByProfileId) {
  const tooltip = new vscode.MarkdownString();
  tooltip.supportThemeIcons = true;
  tooltip.supportHtml = true;
  tooltip.isTrusted = {
    enabledCommands: [
      'codex-switch.profile.manage',
      'codex-switch.profile.activate',
      'codex-switch.profile.switch',
      'codexTerminalRecorder.openSettings'
    ]
  };

  if (!profiles || profiles.length === 0) {
    tooltip.appendMarkdown('No profiles yet.\n\n');
  } else {
    const activeId = activeProfile ? activeProfile.id : undefined;
    const now = Date.now();
    const quickPickSettings = getProfileQuickPickSettings();
    const lowWeeklyOptions = {
      activeProfileId: activeId,
      lowRemainingPercentThreshold: quickPickSettings.lowWeeklyRemainingZeroThreshold
    };
    const lowWeeklyThresholdText = formatLowRemainingPercentThreshold(
      quickPickSettings.lowWeeklyRemainingZeroThreshold
    );
    const sortedProfiles = sortProfilesForDisplay(profiles, activeId, now, lowWeeklyOptions);

    tooltip.appendMarkdown('| Account | Plan | Limits | Windows |\n');
    tooltip.appendMarkdown('| --- | --- | --- | --- |\n');

    sortedProfiles.forEach((profile) => {
      const status = getProfileRateStatus(profile, now, { activeProfileId: activeId });
      const switchUri = buildCommandUri('codex-switch.profile.activate', [profile.id]);
      const plan = escapeMarkdown(formatPlanType(profile.planType));
      const muted = hasZeroRemainingLimit(status, now);
      const profileName = displayProfileName(profile);
      const linkedName = muted
        ? `<a href="${escapeHtmlAttribute(switchUri)}">${dimHtml(escapeHtml(profileName))}</a>`
        : `[${escapeMarkdown(profileName)}](${switchUri})`;
      const weeklyTokensLow = isProfileWeeklyTokensLow(profile, now, lowWeeklyOptions);
      const lowWeeklyBadge = weeklyTokensLow
        ? muted
          ? ` ${dimHtml(`W &lt; ${lowWeeklyThresholdText}%`)}`
          : ` \`W < ${lowWeeklyThresholdText}%\``
        : '';
      const notStartedBadge = status.windowNotStarted
        ? ' `STARTS ON FIRST USE`'
        : '';
      const summary = formatCompactRateSummary(status, now, {
        includePrimaryCountdown: true,
        includeSecondaryCountdown: true,
        percentageMode: 'remaining',
        includePercentageLabel: true,
        roundLowWeeklyRemainingToZero: quickPickSettings.roundLowWeeklyRemainingToZero,
        lowRemainingPercentThreshold: quickPickSettings.lowWeeklyRemainingZeroThreshold
      })
        .split(' | ')
        .map((windowText) => escapeMarkdown(windowText))
        .join('<br>');
      const estimateSuffix = status.isEstimatedRateLimitData ? ' - estimate' : '';
      const windowUsage = formatWindowUsage(
        getOtherWindowUsageEntries(profile.id, otherWindowProfileUsageByProfileId),
        {
          includeCurrentWindow: activeId === profile.id
        }
      );
      const planCell = muted ? dimHtml(plan) : plan;
      const limitsCell = muted ? dimHtml(`${summary}${estimateSuffix}`) : `${summary}${estimateSuffix}`;
      const windowsCell = muted && windowUsage ? dimWindowUsageHtml(windowUsage) : windowUsage;

      tooltip.appendMarkdown(
        `| ${linkedName}${lowWeeklyBadge}${notStartedBadge} | ${planCell} | ${limitsCell} | ${windowsCell} |\n`
      );
    });

    tooltip.appendMarkdown('\n');
  }

  tooltip.appendMarkdown(formatReloadWarning());
  tooltip.appendMarkdown('\n');
  tooltip.appendMarkdown('---\n\n');
  tooltip.appendMarkdown(
    '[Switch profile](command:codex-switch.profile.switch) • [Manage profiles](command:codex-switch.profile.manage) • [Send to Codex settings](command:codexTerminalRecorder.openSettings)\n\n'
  );
  return tooltip;
}

function formatReloadWarning() {
  const reloadAfterSwitch = vscode.workspace
    .getConfiguration('codexSwitch')
    .get('reloadWindowAfterProfileSwitch', true);

  return reloadAfterSwitch
    ? '$(warning) VS Code window will reload after switching accounts.\n'
    : '$(warning) After switching accounts, a VS Code window reload may be required.\n';
}

module.exports = {
  createProfileTooltip
};
