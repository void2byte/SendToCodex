'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { decideObservedAuthChange } = require('../../src/profiles/authChangePolicy');

test('focused window accepts an auth change initiated by the official Codex extension', () => {
  assert.deepEqual(
    decideObservedAuthChange({ windowFocused: true }),
    { accept: true, reason: 'focused-window' }
  );
});

test('background window ignores an auth change it did not initiate', () => {
  assert.deepEqual(
    decideObservedAuthChange({ windowFocused: false }),
    { accept: false, reason: 'background-unexpected' }
  );
});

test('background window accepts the login or profile change it initiated', () => {
  assert.deepEqual(
    decideObservedAuthChange({
      windowFocused: false,
      expectedChange: {}
    }),
    { accept: true, reason: 'expected-login' }
  );
  assert.deepEqual(
    decideObservedAuthChange({
      windowFocused: false,
      expectedChange: { profileId: 'profile-b' },
      actualProfileId: 'profile-b'
    }),
    { accept: true, reason: 'expected-profile' }
  );
});

test('background window rejects an unexpected account during a pending profile switch', () => {
  assert.deepEqual(
    decideObservedAuthChange({
      windowFocused: false,
      expectedChange: { profileId: 'profile-b' },
      actualProfileId: undefined
    }),
    { accept: false, reason: 'background-profile-mismatch' }
  );
});
