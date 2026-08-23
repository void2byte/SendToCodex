'use strict';

const {
  compareDisplayText,
  formatLocalDateTime
} = require('../ui/userFormatting');

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

const DEFAULT_LOW_REMAINING_PERCENT_THRESHOLD = 1;
const DEFAULT_PRIMARY_WINDOW_MINUTES = 5 * 60;
const MINUTES_PER_DAY = 24 * 60;
const USAGE_API_SOURCE_PREFIX = 'https://chatgpt.com/backend-api/wham/usage';
const CODEX_APP_SERVER_RATE_LIMIT_SOURCE_PREFIX = 'codex-app-server://account/rateLimits/read';
const RATE_LIMIT_DISPLAY_FRESHNESS_MS = 60 * 60 * 1000;

function normalizeLowRemainingPercentThreshold(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return DEFAULT_LOW_REMAINING_PERCENT_THRESHOLD;
  }

  return Math.max(0, Math.min(100, numeric));
}

function getLowRemainingPercentThreshold(options = {}) {
  return normalizeLowRemainingPercentThreshold(
    options.lowRemainingPercentThreshold == null
      ? DEFAULT_LOW_REMAINING_PERCENT_THRESHOLD
      : options.lowRemainingPercentThreshold
  );
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

function getPlanSortRank(planType) {
  const normalized = normalizePlanType(planType).toLowerCase();
  if (normalized.includes('enterprise')) {
    return 60;
  }
  if (normalized.includes('team') || normalized.includes('business')) {
    return 50;
  }
  if (normalized.includes('pro')) {
    return 40;
  }
  if (normalized.includes('plus')) {
    return 30;
  }
  if (normalized.includes('go')) {
    return 20;
  }
  if (normalized.includes('free')) {
    return 10;
  }
  return 0;
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

  if (minutes >= MINUTES_PER_DAY) {
    const exactDays = minutes / MINUTES_PER_DAY;
    const roundedDays = Math.round(exactDays);
    if (roundedDays > 0 && Math.abs(minutes - roundedDays * MINUTES_PER_DAY) <= 1) {
      return `${roundedDays}d`;
    }

    if (minutes % MINUTES_PER_DAY === 0) {
      return `${minutes / MINUTES_PER_DAY}d`;
    }
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

function formatCompactWindowMinutes(windowMinutes) {
  const formatted = formatWindowMinutes(windowMinutes);
  return formatted === 'custom' ? null : formatted.replace(/\s+/g, '').toUpperCase();
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
  const usedPercent = Math.max(
    0,
    Math.min(100, normalizeNumber(windowState.usedPercent, 0))
  );
  return {
    usedPercent,
    resetAt,
    active: Boolean(resetAt && resetAt > now),
    unstarted: Boolean(!resetAt && usedPercent <= 0),
    windowMinutes: Math.max(0, Math.round(normalizeNumber(windowState.windowMinutes, 0)))
  };
}

function isUsageApiRateLimitState(rateLimitState) {
  return Boolean(
    rateLimitState &&
      typeof rateLimitState.sourceFile === 'string' &&
      (rateLimitState.sourceFile.startsWith(USAGE_API_SOURCE_PREFIX) ||
        rateLimitState.sourceFile.startsWith(CODEX_APP_SERVER_RATE_LIMIT_SOURCE_PREFIX))
  );
}

function isCodexAppServerRateLimitState(rateLimitState) {
  return Boolean(
    rateLimitState &&
      typeof rateLimitState.sourceFile === 'string' &&
      rateLimitState.sourceFile.startsWith(CODEX_APP_SERVER_RATE_LIMIT_SOURCE_PREFIX)
  );
}

function isFreshUsageApiRateLimitState(rateLimitState, now = Date.now()) {
  if (!isUsageApiRateLimitState(rateLimitState)) {
    return false;
  }

  const observedAt = normalizeTimestamp(rateLimitState.observedAt);
  const assumedResetAt = normalizeTimestamp(rateLimitState.assumedResetAt);
  return Boolean(
    observedAt &&
      (!assumedResetAt || assumedResetAt < observedAt) &&
      now - observedAt <= RATE_LIMIT_DISPLAY_FRESHNESS_MS
  );
}

function isActiveProfileForRateDisplay(profile, options = {}) {
  if (options.isActiveProfile === true) {
    return true;
  }

  if (options.isActiveProfile === false) {
    return false;
  }

  return Boolean(
    options.activeProfileId &&
      profile &&
      profile.id &&
      String(options.activeProfileId) === String(profile.id)
  );
}

function getRateLimitSourceType(rateLimitState) {
  if (!rateLimitState || !rateLimitState.sourceFile) {
    return null;
  }

  if (isCodexAppServerRateLimitState(rateLimitState)) {
    return 'codexAppServer';
  }

  return isUsageApiRateLimitState(rateLimitState) ? 'usageApi' : 'localSessions';
}

function getDisplayRateLimitState(profile, now = Date.now(), options = {}) {
  const rateLimitState = profile && profile.rateLimitState ? profile.rateLimitState : null;
  if (!rateLimitState) {
    return null;
  }

  if (isActiveProfileForRateDisplay(profile, options)) {
    // A temporary API/auth failure must not erase the last known exact values. Keep older
    // Usage API/app-server observations visible as estimates while still rejecting local
    // session data that may belong to another account in a different VS Code window.
    return isUsageApiRateLimitState(rateLimitState) ? rateLimitState : null;
  }

  return rateLimitState;
}

function getProfileRateStatus(profile, now = Date.now(), options = {}) {
  const rateLimitState = getDisplayRateLimitState(profile, now, options);
  const rawPrimary = getActiveLimitState(rateLimitState && rateLimitState.primary, now);
  const secondary = getActiveLimitState(
    rateLimitState && rateLimitState.secondary,
    now
  );
  if (!rateLimitState) {
    return {
      cooldownActive: false,
      cooldownUntil: null,
      windowNotStarted: false,
      compactText: 'n/a',
      quickPickText: '[n/a]',
      tooltipText: 'No fresh exact rate-limit data',
      maxUsedPercent: 0,
      primary: null,
      secondary: null,
      planText: formatPlanType(profile && profile.planType),
      observedAt: null,
      sourceFile: null,
      sourceType: null,
      isEstimatedRateLimitData: false,
      hasFreshUsageApiData: false
    };
  }

  const hasFreshUsageApiData = isFreshUsageApiRateLimitState(rateLimitState, now);
  const primary = applyWeeklyZeroToPrimary(rawPrimary, secondary, now);
  const exhaustedResetTimes = [primary, secondary]
    .filter((windowState) => {
      return Boolean(
        windowState &&
        windowState.active &&
        windowState.resetAt &&
        windowState.usedPercent >= 100
      );
    })
    .map((windowState) => windowState.resetAt);
  const cooldownUntil =
    exhaustedResetTimes.filter((value) => value > now).sort((a, b) => b - a)[0] ||
    null;
  const cooldownActive = Boolean(cooldownUntil && cooldownUntil > now);
  const windowNotStarted = [primary, secondary].some(
    (windowState) => windowState && windowState.unstarted
  );
  const maxUsedPercent = Math.max(
    primary && primary.active ? primary.usedPercent : 0,
    secondary && secondary.active ? secondary.usedPercent : 0
  );

  return {
    cooldownActive,
    cooldownUntil,
    windowNotStarted,
    compactText: cooldownActive
      ? `Limit exhausted - resets in ${formatDuration(cooldownUntil - now)}`
      : windowNotStarted
        ? 'Window not started - starts on first use'
        : 'Available',
    quickPickText: cooldownActive
      ? `[Limit exhausted - resets in ${formatDuration(cooldownUntil - now)}]`
      : windowNotStarted
        ? '[Window not started - starts on first use]'
        : '[Available]',
    tooltipText: cooldownActive
      ? `Limit exhausted - resets in ${formatDuration(cooldownUntil - now)}`
      : windowNotStarted
        ? 'Window not started - starts on first use'
        : 'Available',
    maxUsedPercent,
    primary,
    secondary,
    planText: formatPlanType(profile && profile.planType),
    observedAt: normalizeTimestamp(rateLimitState.observedAt),
    sourceFile: rateLimitState.sourceFile || null,
    sourceType: getRateLimitSourceType(rateLimitState),
    isEstimatedRateLimitData: !hasFreshUsageApiData,
    hasFreshUsageApiData
  };
}

function getRawWindowRemainingPercent(windowState, now = Date.now()) {
  if (!windowState) {
    return null;
  }

  if (!windowState.resetAt || windowState.resetAt <= now) {
    return 100;
  }

  return Math.max(0, Math.min(100, 100 - windowState.usedPercent));
}

function roundRemainingPercent(remainingPercent, options = {}) {
  if (remainingPercent == null) {
    return -1;
  }

  const normalized = Math.max(0, Math.min(100, normalizeNumber(remainingPercent, 0)));
  if (
    options.roundLowRemainingToZero === true &&
    normalized < getLowRemainingPercentThreshold(options)
  ) {
    return 0;
  }

  return Math.round(normalized);
}

function getWindowRemainingPercent(windowState, now = Date.now(), options = {}) {
  const remainingPercent = getRawWindowRemainingPercent(windowState, now);
  return roundRemainingPercent(remainingPercent, options);
}

function isWindowLowRemaining(windowState, now = Date.now(), options = {}) {
  const remainingPercent = getRawWindowRemainingPercent(windowState, now);
  return remainingPercent != null && remainingPercent < getLowRemainingPercentThreshold(options);
}

function isWindowZeroRemaining(windowState, now = Date.now()) {
  const remainingPercent = getRawWindowRemainingPercent(windowState, now);
  return remainingPercent === 0;
}

function applyWeeklyZeroToPrimary(primary, secondary, now = Date.now()) {
  if (!isWindowZeroRemaining(secondary, now)) {
    return primary;
  }

  return {
    usedPercent: 100,
    resetAt: secondary.resetAt,
    active: Boolean(secondary.resetAt && secondary.resetAt > now),
    unstarted: false,
    windowMinutes:
      primary && primary.windowMinutes
        ? primary.windowMinutes
        : DEFAULT_PRIMARY_WINDOW_MINUTES
  };
}

function isProfileWeeklyTokensLow(profile, now = Date.now(), options = {}) {
  const status = getProfileRateStatus(profile, now, options);
  return isWindowLowRemaining(status.secondary, now, options);
}

function getProfileDisplaySortKey(profile, now = Date.now(), options = {}) {
  const status = getProfileRateStatus(profile, now, options);
  const planType = normalizePlanType(profile && profile.planType);
  const weeklyTokensLow = isWindowLowRemaining(status.secondary, now, options);

  return {
    primaryRemainingPercent: weeklyTokensLow ? 0 : getWindowRemainingPercent(status.primary, now),
    secondaryRemainingPercent: getWindowRemainingPercent(status.secondary, now),
    planRank: getPlanSortRank(planType),
    planType: planType.toLowerCase(),
    name: String((profile && profile.name) || '').toLowerCase(),
    weeklyTokensLow
  };
}

function compareProfilesForDisplay(left, right, activeProfileId, now = Date.now(), options = {}) {
  if (activeProfileId) {
    const leftIsActive = String(left && left.id) === String(activeProfileId);
    const rightIsActive = String(right && right.id) === String(activeProfileId);
    if (leftIsActive !== rightIsActive) {
      return leftIsActive ? -1 : 1;
    }
  }

  const leftKey = getProfileDisplaySortKey(left, now, { ...options, activeProfileId });
  const rightKey = getProfileDisplaySortKey(right, now, { ...options, activeProfileId });
  const numericSorts = [
    rightKey.primaryRemainingPercent - leftKey.primaryRemainingPercent,
    rightKey.secondaryRemainingPercent - leftKey.secondaryRemainingPercent,
    rightKey.planRank - leftKey.planRank
  ];
  const numericSort = numericSorts.find((value) => value !== 0);
  if (numericSort) {
    return numericSort;
  }

  const planSort = compareDisplayText(leftKey.planType, rightKey.planType);
  if (planSort !== 0) {
    return planSort;
  }

  return compareDisplayText(leftKey.name, rightKey.name);
}

function sortProfilesForDisplay(profiles, activeProfileId, now = Date.now(), options = {}) {
  return [...(profiles || [])].sort((left, right) => {
    return compareProfilesForDisplay(left, right, activeProfileId, now, options);
  });
}

function formatAbsoluteTimestamp(timestamp) {
  const normalized = normalizeTimestamp(timestamp);
  if (!normalized) {
    return 'n/a';
  }
  return formatLocalDateTime(normalized);
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

  if (windowState.unstarted) {
    return 'Starts on first use';
  }

  if (!windowState.resetAt || windowState.resetAt <= now) {
    return 'Ready';
  }

  return formatDuration(windowState.resetAt - now);
}

function isFreePlanStatus(status) {
  return normalizePlanType(status && status.planText).toLowerCase().includes('free');
}

function getWindowMinutesUntilReset(windowState, now) {
  const resetAt = normalizeTimestamp(windowState && windowState.resetAt);
  if (!resetAt || resetAt <= now) {
    return 0;
  }

  return Math.ceil((resetAt - now) / (60 * 1000));
}

function getCompactPrimaryWindowLabel(status, now = Date.now()) {
  const primary = status && status.primary;
  const windowMinutes = Math.max(0, Math.round(normalizeNumber(primary && primary.windowMinutes, 0)));

  if (isFreePlanStatus(status)) {
    const resetWindowMinutes = getWindowMinutesUntilReset(primary, now);
    if (resetWindowMinutes > DEFAULT_PRIMARY_WINDOW_MINUTES) {
      return formatCompactWindowMinutes(resetWindowMinutes) || '5H';
    }
  }

  if (windowMinutes > 0) {
    return formatCompactWindowMinutes(windowMinutes) || '5H';
  }

  return '5H';
}

function shouldHideMissingSecondaryWindow(status, now = Date.now()) {
  if (status && status.secondary) {
    return false;
  }

  return isFreePlanStatus(status) && getWindowMinutesUntilReset(status && status.primary, now) > DEFAULT_PRIMARY_WINDOW_MINUTES;
}

function formatCompactWindow(windowState, label, now = Date.now(), options = {}) {
  const includeCountdown = options.includeCountdown !== false;
  const percentageMode = options.percentageMode === 'remaining' ? 'remaining' : 'used';
  if (!windowState) {
    return `${label} n/a`;
  }

  const isReady = !windowState.resetAt || windowState.resetAt <= now;
  const isUnstarted = windowState.unstarted === true;
  const percentValue =
    percentageMode === 'remaining'
      ? getWindowRemainingPercent(windowState, now, {
          roundLowRemainingToZero: options.roundLowRemainingToZero === true,
          lowRemainingPercentThreshold: options.lowRemainingPercentThreshold
        })
      : isReady
        ? 0
        : Math.round(windowState.usedPercent);
  const percentText = `${percentValue}%`;
  const percentageLabel = options.includePercentageLabel
    ? percentageMode === 'remaining'
      ? ' remaining'
      : ' used'
    : '';
  if (!includeCountdown || isReady) {
    return isUnstarted
      ? `${label} ${percentText}${percentageLabel} - starts on first use`
      : `${label} ${percentText}${percentageLabel}`;
  }

  const countdown = formatWindowCountdown(windowState, now);
  return options.includePercentageLabel
    ? `${label} ${percentText}${percentageLabel} - resets in ${countdown}`
    : `${label} ${percentText} ${countdown}`;
}

function formatCompactRateSummary(status, now = Date.now(), options = {}) {
  if (!status.primary && status.secondary) {
    return formatCompactWindow(status.secondary, 'W', now, {
      includeCountdown: options.includeSecondaryCountdown !== false,
      percentageMode: options.percentageMode,
      includePercentageLabel: options.includePercentageLabel,
      roundLowRemainingToZero: options.roundLowWeeklyRemainingToZero === true,
      lowRemainingPercentThreshold: options.lowRemainingPercentThreshold
    });
  }

  const primaryText = formatCompactWindow(status.primary, getCompactPrimaryWindowLabel(status, now), now, {
    includeCountdown: options.includePrimaryCountdown !== false,
    percentageMode: options.percentageMode,
    includePercentageLabel: options.includePercentageLabel
  });
  if (shouldHideMissingSecondaryWindow(status, now)) {
    return primaryText;
  }

  const secondaryText = formatCompactWindow(status.secondary, 'W', now, {
    includeCountdown: options.includeSecondaryCountdown !== false,
    percentageMode: options.percentageMode,
    includePercentageLabel: options.includePercentageLabel,
    roundLowRemainingToZero: options.roundLowWeeklyRemainingToZero === true,
    lowRemainingPercentThreshold: options.lowRemainingPercentThreshold
  });

  return `${primaryText} | ${secondaryText}`;
}

module.exports = {
  compareProfilesForDisplay,
  DEFAULT_LOW_REMAINING_PERCENT_THRESHOLD,
  formatAbsoluteTimestamp,
  formatCompactRateSummary,
  formatCompactWindow,
  formatDuration,
  formatPlanType,
  formatResetText,
  formatWindowCountdown,
  formatWindowMinutes,
  getDisplayRateLimitState,
  getCompactPrimaryWindowLabel,
  getPlanSortRank,
  getProfileDisplaySortKey,
  getProfileRateStatus,
  getWindowLabel,
  getWindowRemainingPercent,
  isFreshUsageApiRateLimitState,
  isUsageApiRateLimitState,
  isProfileWeeklyTokensLow,
  normalizeLowRemainingPercentThreshold,
  normalizeTimestamp,
  sortProfilesForDisplay
};
