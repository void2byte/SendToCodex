'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { formatTokenUsage } = require('../../src/profiles/rateLimitParser');

test('token usage keeps exact small values and does not force K units', () => {
  const formatted = formatTokenUsage({
    input_tokens: 499,
    cached_input_tokens: 1200,
    output_tokens: 25,
    reasoning_output_tokens: 0
  });

  assert.match(formatted, /input 499/);
  assert.match(formatted, /output 25/);
  assert.doesNotMatch(formatted, /\b0 K\b|\b1 K\b/);
});
