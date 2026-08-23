'use strict';

const vscode = require('vscode');
const {
  DEFAULT_LOW_REMAINING_PERCENT_THRESHOLD,
  getPlanSortRank,
  normalizeLowRemainingPercentThreshold
} = require('./profileStatus');
const { compareDisplayText } = require('../ui/userFormatting');

const PROFILE_QUICK_PICK_SECTIONS = [
  { id: 'needsAuth', label: 'Needs auth' },
  { id: 'weeklyLow', label: 'Weekly low' },
  { id: 'coolingDown', label: 'Limit exhausted' },
  { id: 'notStarted', label: 'Window not started' },
  { id: 'ready', label: 'Available' },
  { id: 'staleEstimate', label: 'Stale / estimate' },
  { id: 'otherProfiles', label: 'Other profiles' }
];

const DEFAULT_PROFILE_QUICK_PICK_SECTION_ORDER = PROFILE_QUICK_PICK_SECTIONS.map(
  (section) => section.id
);
const DEFAULT_PROFILE_QUICK_PICK_SORT = 'availability';
const DEFAULT_PROFILE_QUICK_PICK_SECONDARY_SORT = 'weeklyResetSoon';

const PROFILE_QUICK_PICK_SORT_OPTIONS = [
  {
    id: 'availability',
    label: 'Availability'
  },
  {
    id: 'nextResetSoon',
    label: 'Next reset soon'
  },
  {
    id: 'nextResetLate',
    label: 'Next reset late'
  },
  {
    id: 'fiveHourResetSoon',
    label: 'Primary reset soon'
  },
  {
    id: 'weeklyResetSoon',
    label: 'Weekly reset soon'
  },
  {
    id: 'mostRemaining',
    label: 'Most remaining'
  },
  {
    id: 'leastRemaining',
    label: 'Least remaining'
  },
  {
    id: 'freshestObservation',
    label: 'Freshest data'
  },
  {
    id: 'stalestObservation',
    label: 'Stalest data'
  },
  {
    id: 'name',
    label: 'Name'
  },
  {
    id: 'plan',
    label: 'Plan'
  },
  {
    id: 'group',
    label: 'Group'
  }
];

const PROFILE_QUICK_PICK_SECONDARY_SORT_OPTIONS = [
  {
    id: 'none',
    label: 'None'
  },
  ...PROFILE_QUICK_PICK_SORT_OPTIONS
];

function getCodexSwitchConfiguration() {
  return vscode.workspace.getConfiguration('codexSwitch');
}

function normalizeSectionOrder(value) {
  const knownIds = new Set(PROFILE_QUICK_PICK_SECTIONS.map((section) => section.id));
  const normalized = Array.isArray(value)
    ? value.filter((sectionId) => knownIds.has(sectionId))
    : [];
  if (
    normalized.length > 0 &&
    !normalized.includes('notStarted') &&
    normalized.includes('ready')
  ) {
    normalized.splice(normalized.indexOf('ready'), 0, 'notStarted');
  }
  for (const sectionId of DEFAULT_PROFILE_QUICK_PICK_SECTION_ORDER) {
    if (!normalized.includes(sectionId)) {
      normalized.push(sectionId);
    }
  }
  return normalized;
}

function normalizeHiddenSections(value) {
  const knownIds = new Set(PROFILE_QUICK_PICK_SECTIONS.map((section) => section.id));
  return Array.isArray(value)
    ? value.filter((sectionId, index, source) => {
        return knownIds.has(sectionId) && source.indexOf(sectionId) === index;
      })
    : [];
}

function normalizeProfileSort(value) {
  return PROFILE_QUICK_PICK_SORT_OPTIONS.some((option) => option.id === value)
    ? value
    : DEFAULT_PROFILE_QUICK_PICK_SORT;
}

function normalizeSecondaryProfileSort(value) {
  if (value === 'none') {
    return 'none';
  }

  return PROFILE_QUICK_PICK_SORT_OPTIONS.some((option) => option.id === value)
    ? value
    : DEFAULT_PROFILE_QUICK_PICK_SECONDARY_SORT;
}

function formatLowRemainingPercentThreshold(value) {
  const normalized = normalizeLowRemainingPercentThreshold(value);
  if (Number.isInteger(normalized)) {
    return String(normalized);
  }

  return String(normalized).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
}

function getProfileQuickPickSectionLabel(sectionId) {
  const section = PROFILE_QUICK_PICK_SECTIONS.find((candidate) => candidate.id === sectionId);
  return section ? section.label : 'Other profiles';
}

function getProfileQuickPickSettings() {
  const config = getCodexSwitchConfiguration();
  return {
    hiddenSections: normalizeHiddenSections(
      config.get('profileQuickPick.hiddenSections', [])
    ),
    sectionOrder: normalizeSectionOrder(
      config.get('profileQuickPick.sectionOrder', DEFAULT_PROFILE_QUICK_PICK_SECTION_ORDER)
    ),
    profileSort: normalizeProfileSort(
      config.get('profileQuickPick.profileSort', DEFAULT_PROFILE_QUICK_PICK_SORT)
    ),
    secondaryProfileSort: normalizeSecondaryProfileSort(
      config.get(
        'profileQuickPick.secondaryProfileSort',
        DEFAULT_PROFILE_QUICK_PICK_SECONDARY_SORT
      )
    ),
    roundLowWeeklyRemainingToZero: Boolean(
      config.get('profileQuickPick.roundLowWeeklyRemainingToZero', false)
    ),
    lowWeeklyRemainingZeroThreshold: normalizeLowRemainingPercentThreshold(
      config.get(
        'profileQuickPick.lowWeeklyRemainingZeroThreshold',
        DEFAULT_LOW_REMAINING_PERCENT_THRESHOLD
      )
    )
  };
}

function isProfileQuickPickSectionVisible(settings, sectionId) {
  return !(settings.hiddenSections || []).includes(sectionId);
}

function getProfileName(value) {
  return String((value && (value.profileDisplayName || value.label)) || '');
}

function getFiniteSortNumber(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function getOptionalTimestamp(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

function compareText(left, right) {
  return compareDisplayText(left, right);
}

function compareByName(left, right) {
  return compareDisplayText(getProfileName(left), getProfileName(right));
}

function compareByOriginalIndex(left, right) {
  return Number(left.quickPickSortIndex || 0) - Number(right.quickPickSortIndex || 0);
}

function compareOptionalNumberAsc(leftValue, rightValue) {
  const left = getOptionalTimestamp(leftValue);
  const right = getOptionalTimestamp(rightValue);
  if (left == null && right == null) {
    return 0;
  }
  if (left == null) {
    return 1;
  }
  if (right == null) {
    return -1;
  }
  return left - right;
}

function compareOptionalNumberDesc(leftValue, rightValue) {
  const left = getOptionalTimestamp(leftValue);
  const right = getOptionalTimestamp(rightValue);
  if (left == null && right == null) {
    return 0;
  }
  if (left == null) {
    return 1;
  }
  if (right == null) {
    return -1;
  }
  return right - left;
}

function compareRemainingDesc(left, right) {
  return (
    getFiniteSortNumber(right.lowestRemainingPercent, -1) -
      getFiniteSortNumber(left.lowestRemainingPercent, -1) ||
    getFiniteSortNumber(right.primaryRemainingPercent, -1) -
      getFiniteSortNumber(left.primaryRemainingPercent, -1) ||
    getFiniteSortNumber(right.weeklyRemainingPercent, -1) -
      getFiniteSortNumber(left.weeklyRemainingPercent, -1)
  );
}

function compareRemainingAsc(left, right) {
  return (
    getFiniteSortNumber(left.lowestRemainingPercent, 101) -
      getFiniteSortNumber(right.lowestRemainingPercent, 101) ||
    getFiniteSortNumber(left.primaryRemainingPercent, 101) -
      getFiniteSortNumber(right.primaryRemainingPercent, 101) ||
    getFiniteSortNumber(left.weeklyRemainingPercent, 101) -
      getFiniteSortNumber(right.weeklyRemainingPercent, 101)
  );
}

function getWeeklyResetSortTimestamp(value) {
  return value && value.weeklyResetAt;
}

function compareProfileQuickPickItemsBySortMode(left, right, sortMode) {
  const normalizedSortMode = normalizeProfileSort(sortMode);

  if (normalizedSortMode === 'name') {
    return compareByName(left, right);
  }

  if (normalizedSortMode === 'plan') {
    const leftRank = Number.isFinite(Number(left.planRank))
      ? Number(left.planRank)
      : getPlanSortRank(left.planText);
    const rightRank = Number.isFinite(Number(right.planRank))
      ? Number(right.planRank)
      : getPlanSortRank(right.planText);
    return leftRank - rightRank || compareText(left.planText, right.planText);
  }

  if (normalizedSortMode === 'group') {
    return compareText(left.profileGroup, right.profileGroup);
  }

  if (normalizedSortMode === 'nextResetSoon') {
    return compareOptionalNumberAsc(left.nextResetAt, right.nextResetAt);
  }

  if (normalizedSortMode === 'nextResetLate') {
    return compareOptionalNumberDesc(left.nextResetAt, right.nextResetAt);
  }

  if (normalizedSortMode === 'fiveHourResetSoon') {
    return compareOptionalNumberAsc(left.primaryResetAt, right.primaryResetAt);
  }

  if (normalizedSortMode === 'weeklyResetSoon') {
    return compareOptionalNumberAsc(
      getWeeklyResetSortTimestamp(left),
      getWeeklyResetSortTimestamp(right)
    );
  }

  if (normalizedSortMode === 'mostRemaining') {
    return compareRemainingDesc(left, right);
  }

  if (normalizedSortMode === 'leastRemaining') {
    return compareRemainingAsc(left, right);
  }

  if (normalizedSortMode === 'freshestObservation') {
    return compareOptionalNumberDesc(left.observedAt, right.observedAt);
  }

  if (normalizedSortMode === 'stalestObservation') {
    return compareOptionalNumberAsc(left.observedAt, right.observedAt);
  }

  return compareByOriginalIndex(left, right);
}

function compareProfileQuickPickItems(left, right, primarySortMode, secondarySortMode) {
  const leftIsActive = left && left.isActive === true;
  const rightIsActive = right && right.isActive === true;
  if (leftIsActive !== rightIsActive) {
    return leftIsActive ? -1 : 1;
  }

  const primarySort = compareProfileQuickPickItemsBySortMode(left, right, primarySortMode);
  if (primarySort) {
    return primarySort;
  }

  const normalizedSecondarySort = normalizeSecondaryProfileSort(secondarySortMode);
  if (normalizedSecondarySort !== 'none') {
    const secondarySort = compareProfileQuickPickItemsBySortMode(
      left,
      right,
      normalizedSecondarySort
    );
    if (secondarySort) {
      return secondarySort;
    }
  }

  return compareByName(left, right) || compareByOriginalIndex(left, right);
}

function sortProfileQuickPickItems(items, primarySortMode, secondarySortMode) {
  return [...(items || [])].sort((left, right) => {
    return compareProfileQuickPickItems(left, right, primarySortMode, secondarySortMode);
  });
}

module.exports = {
  DEFAULT_PROFILE_QUICK_PICK_SECTION_ORDER,
  DEFAULT_PROFILE_QUICK_PICK_SECONDARY_SORT,
  DEFAULT_PROFILE_QUICK_PICK_SORT,
  formatLowRemainingPercentThreshold,
  PROFILE_QUICK_PICK_SECTIONS,
  PROFILE_QUICK_PICK_SECONDARY_SORT_OPTIONS,
  PROFILE_QUICK_PICK_SORT_OPTIONS,
  getProfileQuickPickSectionLabel,
  getProfileQuickPickSettings,
  isProfileQuickPickSectionVisible,
  normalizeHiddenSections,
  normalizeProfileSort,
  normalizeSecondaryProfileSort,
  normalizeSectionOrder,
  sortProfileQuickPickItems
};
