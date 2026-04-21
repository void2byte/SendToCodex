'use strict';

function normalizeTimestamp(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return null;
  }
  return Math.round(numeric);
}

function normalizeNumber(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function normalizePlanType(planType) {
  const normalized = String(planType || '').trim();
  if (!normalized) {
    return 'Unknown';
  }
  return normalized;
}

function formatPlanType(planType) {
  const normalized = normalizePlanType(planType);
  return normalized === 'Unknown' ? normalized : normalized.toUpperCase();
}

function formatDuration(durationMs) {
  const totalSeconds = Math.max(0, Math.ceil(normalizeNumber(durationMs, 0) / 1000));

  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }

  const totalMinutes = Math.ceil(totalSeconds / 60);
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = totalMinutes % 60;
  const parts = [];

  if (days > 0) {
    parts.push(`${days}d`);
  }
  if (hours > 0) {
    parts.push(`${hours}h`);
  }
  if (minutes > 0 && parts.length < 2) {
    parts.push(`${minutes}m`);
  }
  if (parts.length === 0) {
    parts.push('0m');
  }

  return parts.join(' ');
}

function formatWindowMinutes(windowMinutes) {
  const minutes = Math.max(0, Math.round(normalizeNumber(windowMinutes, 0)));
  if (!minutes) {
    return 'custom';
  }

  if (minutes % (24 * 60) === 0) {
    return `${minutes / (24 * 60)}d`;
  }

  if (minutes % 60 === 0) {
    return `${minutes / 60}h`;
  }

  if (minutes > 60) {
    const hours = Math.floor(minutes / 60);
    const remainingMinutes = minutes % 60;
    return `${hours}h ${remainingMinutes}m`;
  }

  return `${minutes}m`;
}

function getWindowLabel(windowState, fallbackLabel) {
  if (!windowState) {
    return fallbackLabel;
  }

  const windowLabel = formatWindowMinutes(windowState.windowMinutes);
  return `${fallbackLabel} (${windowLabel})`;
}

function getActiveLimitState(windowState, now) {
  if (!windowState || typeof windowState !== 'object') {
    return null;
  }

  const resetAt = normalizeTimestamp(windowState.resetAt);
  return {
    usedPercent: Math.max(0, Math.min(100, normalizeNumber(windowState.usedPercent, 0))),
    resetAt,
    active: Boolean(resetAt && resetAt > now),
    windowMinutes: Math.max(0, Math.round(normalizeNumber(windowState.windowMinutes, 0)))
  };
}

function getProfileRateStatus(profile, now = Date.now()) {
  const primary = getActiveLimitState(profile && profile.rateLimitState && profile.rateLimitState.primary, now);
  const secondary = getActiveLimitState(
    profile && profile.rateLimitState && profile.rateLimitState.secondary,
    now
  );
  const activeResetTimes = [primary, secondary]
    .filter((windowState) => Boolean(windowState && windowState.active && windowState.resetAt))
    .map((windowState) => windowState.resetAt);
  const storedCooldownUntil = normalizeTimestamp(profile && profile.cooldownUntil);
  const cooldownUntil =
    [storedCooldownUntil].concat(activeResetTimes).filter((value) => Boolean(value && value > now)).sort((a, b) => b - a)[0] ||
    null;
  const cooldownActive = Boolean(cooldownUntil && cooldownUntil > now);
  const maxUsedPercent = Math.max(
    primary && primary.active ? primary.usedPercent : 0,
    secondary && secondary.active ? secondary.usedPercent : 0
  );

  return {
    cooldownActive,
    cooldownUntil,
    compactText: cooldownActive ? `Reset in ${formatDuration(cooldownUntil - now)}` : 'Ready',
    quickPickText: cooldownActive
      ? `[Reset in: ${formatDuration(cooldownUntil - now)}]`
      : '[Ready]',
    tooltipText: cooldownActive ? `Reset in ${formatDuration(cooldownUntil - now)}` : 'Ready',
    icon: cooldownActive ? '$(error)' : '$(check)',
    maxUsedPercent,
    primary,
    secondary,
    planText: formatPlanType(profile && profile.planType)
  };
}

function formatAbsoluteTimestamp(timestamp) {
  const normalized = normalizeTimestamp(timestamp);
  if (!normalized) {
    return 'n/a';
  }
  return new Date(normalized).toLocaleString();
}

function formatResetText(timestamp, now = Date.now()) {
  const normalized = normalizeTimestamp(timestamp);
  if (!normalized || normalized <= now) {
    return 'Ready';
  }
  return `Reset in ${formatDuration(normalized - now)}`;
}

function formatWindowCountdown(windowState, now = Date.now()) {
  if (!windowState) {
    return 'n/a';
  }

  if (!windowState.resetAt || windowState.resetAt <= now) {
    return 'Ready';
  }

  return formatDuration(windowState.resetAt - now);
}

function formatCompactWindow(windowState, label, now = Date.now(), options = {}) {
  const includeCountdown = options.includeCountdown !== false;
  const percentageMode = options.percentageMode === 'remaining' ? 'remaining' : 'used';
  if (!windowState) {
    return `${label} n/a`;
  }

  const percentValue =
    percentageMode === 'remaining'
      ? Math.max(0, 100 - Math.round(windowState.usedPercent))
      : Math.round(windowState.usedPercent);
  const percentText = `${percentValue}%`;
  if (!includeCountdown) {
    return `${label} ${percentText}`;
  }

  return `${label} ${percentText} ${formatWindowCountdown(windowState, now)}`;
}

function formatCompactRateSummary(status, now = Date.now(), options = {}) {
  const primaryText = formatCompactWindow(status.primary, '5H', now, {
    includeCountdown: options.includePrimaryCountdown !== false,
    percentageMode: options.percentageMode
  });
  const secondaryText = formatCompactWindow(status.secondary, 'W', now, {
    includeCountdown: options.includeSecondaryCountdown !== false,
    percentageMode: options.percentageMode
  });

  return `${primaryText} | ${secondaryText}`;
}

module.exports = {
  formatAbsoluteTimestamp,
  formatCompactRateSummary,
  formatCompactWindow,
  formatDuration,
  formatPlanType,
  formatResetText,
  formatWindowCountdown,
  formatWindowMinutes,
  getProfileRateStatus,
  getWindowLabel,
  normalizeTimestamp
};
