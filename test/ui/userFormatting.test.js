'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  compareDisplayText,
  formatInteger,
  formatLocalDateTime
} = require('../../src/ui/userFormatting');

test('local date-time formatting is year-first and includes an explicit time zone', () => {
  const value = formatLocalDateTime(new Date(2026, 6, 24, 13, 5, 9));

  assert.match(value, /^2026-07-24 13:05:09 UTC(?:[+-]\d{2}:\d{2})?$/);
});

test('invalid date-time values are displayed as unavailable', () => {
  assert.equal(formatLocalDateTime('not-a-date'), 'n/a');
});

test('integer formatting keeps small token counts instead of rounding them to zero thousands', () => {
  assert.equal(formatInteger(499, 'en-US'), '499');
  assert.equal(formatInteger(12345, 'en-US'), '12,345');
  assert.equal(formatInteger(12345), '12\u202f345');
});

test('display text comparison is deterministic and numeric-aware', () => {
  assert.ok(compareDisplayText('Account 2', 'Account 10') < 0);
});
