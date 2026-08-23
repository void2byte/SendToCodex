'use strict';

const DISPLAY_COLLATOR = new Intl.Collator('en', {
  numeric: true,
  sensitivity: 'base'
});

function padNumber(value, width = 2) {
  return String(value).padStart(width, '0');
}

function asValidDate(value) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatTimeZoneOffset(date) {
  const offsetMinutes = -date.getTimezoneOffset();
  if (offsetMinutes === 0) {
    return 'UTC';
  }

  const sign = offsetMinutes >= 0 ? '+' : '-';
  const absoluteMinutes = Math.abs(offsetMinutes);
  return `UTC${sign}${padNumber(Math.floor(absoluteMinutes / 60))}:${padNumber(
    absoluteMinutes % 60
  )}`;
}

function formatLocalDateTime(value, options = {}) {
  const date = asValidDate(value);
  if (!date) {
    return 'n/a';
  }

  const dateText = [
    padNumber(date.getFullYear(), 4),
    padNumber(date.getMonth() + 1),
    padNumber(date.getDate())
  ].join('-');
  const timeParts = [
    padNumber(date.getHours()),
    padNumber(date.getMinutes())
  ];
  if (options.includeSeconds !== false) {
    timeParts.push(padNumber(date.getSeconds()));
  }

  const timestamp = `${dateText} ${timeParts.join(':')}`;
  return options.includeTimeZone === false
    ? timestamp
    : `${timestamp} ${formatTimeZoneOffset(date)}`;
}

function formatInteger(value, locale) {
  const numeric = Number(value);
  const normalized = Number.isFinite(numeric) ? Math.round(numeric) : 0;
  if (locale) {
    return normalized.toLocaleString(locale);
  }

  const sign = normalized < 0 ? '-' : '';
  const digits = String(Math.abs(normalized));
  return `${sign}${digits.replace(/\B(?=(\d{3})+(?!\d))/g, '\u202f')}`;
}

function compareDisplayText(left, right) {
  return DISPLAY_COLLATOR.compare(String(left || ''), String(right || ''));
}

module.exports = {
  compareDisplayText,
  formatInteger,
  formatLocalDateTime,
  formatTimeZoneOffset
};
