'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  RateLimitRefreshCoordinator
} = require('../../src/profiles/rateLimitRefreshCoordinator');

test('shared coordinator coalesces refreshes across extension hosts', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-refresh-coordinator-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const first = new RateLimitRefreshCoordinator(() => directory, 'window-a', null);
  const second = new RateLimitRefreshCoordinator(() => directory, 'window-b', null);
  const startedAt = 100_000;

  const firstClaim = first.claim('profile-a', { now: startedAt, minimumFreshMs: 10_000 });
  assert.equal(firstClaim.acquired, true);

  const overlappingClaim = second.claim('profile-a', {
    now: startedAt + 1,
    minimumFreshMs: 10_000
  });
  assert.equal(overlappingClaim.acquired, false);
  assert.equal(overlappingClaim.reason, 'in-flight');

  first.complete('profile-a', firstClaim, true, { now: startedAt + 100 });

  const recentClaim = second.claim('profile-a', {
    now: startedAt + 1000,
    minimumFreshMs: 10_000
  });
  assert.equal(recentClaim.acquired, false);
  assert.equal(recentClaim.reason, 'recent-success');

  const laterClaim = second.claim('profile-a', {
    now: startedAt + 11_000,
    minimumFreshMs: 10_000
  });
  assert.equal(laterClaim.acquired, true);
});

test('shared coordinator backs off after a failed refresh without blocking other profiles', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-refresh-backoff-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const first = new RateLimitRefreshCoordinator(() => directory, 'window-a', null);
  const second = new RateLimitRefreshCoordinator(() => directory, 'window-b', null);
  const startedAt = 200_000;

  const failedClaim = first.claim('profile-a', { now: startedAt });
  first.complete('profile-a', failedClaim, false, { now: startedAt + 100 });

  const backedOff = second.claim('profile-a', {
    now: startedAt + 1000,
    failureBackoffMs: 15_000
  });
  assert.equal(backedOff.acquired, false);
  assert.equal(backedOff.reason, 'failure-backoff');

  const otherProfile = second.claim('profile-b', { now: startedAt + 1000 });
  assert.equal(otherProfile.acquired, true);
});
