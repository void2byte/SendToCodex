'use strict';

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { mutateJsonFileSync } = require('./atomicJsonStore');

const COORDINATOR_VERSION = 1;
const DEFAULT_LEASE_TIMEOUT_MS = 60 * 1000;
const DEFAULT_MINIMUM_FRESH_MS = 10 * 1000;
const DEFAULT_FAILURE_BACKOFF_MS = 15 * 1000;

function asTimestamp(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.round(numeric) : null;
}

function normalizeState(value) {
  let source = value;
  if (typeof source === 'string') {
    source = JSON.parse(source);
  }
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    source = {};
  }

  return {
    version: COORDINATOR_VERSION,
    claimId: typeof source.claimId === 'string' ? source.claimId : null,
    ownerId: typeof source.ownerId === 'string' ? source.ownerId : null,
    inFlight: source.inFlight === true,
    claimedAt: asTimestamp(source.claimedAt),
    completedAt: asTimestamp(source.completedAt),
    failedAt: asTimestamp(source.failedAt)
  };
}

function sanitizeProfileId(profileId) {
  return String(profileId || '')
    .trim()
    .replace(/[^a-zA-Z0-9_.-]+/g, '-');
}

class RateLimitRefreshCoordinator {
  constructor(rootDirectoryProvider, ownerId, logger) {
    this.rootDirectoryProvider = rootDirectoryProvider;
    this.ownerId = ownerId || randomUUID();
    this.logger = logger;
  }

  getStatePath(profileId) {
    const safeProfileId = sanitizeProfileId(profileId);
    if (!safeProfileId) {
      throw new Error('Cannot coordinate a rate-limit refresh without a profile id.');
    }
    return path.join(this.rootDirectoryProvider(), 'rate-limit-refresh', `${safeProfileId}.json`);
  }

  claim(profileId, options = {}) {
    const now = Number(options.now) || Date.now();
    const leaseTimeoutMs = Math.max(
      1000,
      Number(options.leaseTimeoutMs) || DEFAULT_LEASE_TIMEOUT_MS
    );
    const minimumFreshMs = Math.max(
      0,
      Number(options.minimumFreshMs) || DEFAULT_MINIMUM_FRESH_MS
    );
    const failureBackoffMs = Math.max(
      0,
      Number(options.failureBackoffMs) || DEFAULT_FAILURE_BACKOFF_MS
    );
    const filePath = this.getStatePath(profileId);
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });

    const claimId = randomUUID();
    let acquired = false;
    let reason = 'unknown';

    try {
      mutateJsonFileSync(
        filePath,
        normalizeState(null),
        normalizeState,
        (state) => {
          if (
            state.inFlight &&
            state.claimedAt &&
            now - state.claimedAt >= 0 &&
            now - state.claimedAt < leaseTimeoutMs
          ) {
            reason = 'in-flight';
            return state;
          }

          if (
            state.completedAt &&
            now - state.completedAt >= 0 &&
            now - state.completedAt < minimumFreshMs
          ) {
            reason = 'recent-success';
            return state;
          }

          if (
            state.failedAt &&
            now - state.failedAt >= 0 &&
            now - state.failedAt < failureBackoffMs
          ) {
            reason = 'failure-backoff';
            return state;
          }

          acquired = true;
          reason = 'acquired';
          return {
            ...state,
            claimId,
            ownerId: this.ownerId,
            inFlight: true,
            claimedAt: now
          };
        },
        { skipWriteIfUnchanged: true }
      );
    } catch (error) {
      if (this.logger) {
        this.logger.warn('Rate-limit refresh coordination failed; continuing without a lease.', {
          profileId,
          error: error && error.message ? error.message : String(error)
        });
      }
      return { acquired: true, coordinated: false, claimId: null, reason: 'uncoordinated' };
    }

    return { acquired, coordinated: true, claimId: acquired ? claimId : null, reason };
  }

  complete(profileId, claim, succeeded, options = {}) {
    if (!claim || !claim.coordinated || !claim.claimId) {
      return;
    }

    const now = Number(options.now) || Date.now();
    const filePath = this.getStatePath(profileId);
    mutateJsonFileSync(
      filePath,
      normalizeState(null),
      normalizeState,
      (state) => {
        if (state.claimId !== claim.claimId) {
          return state;
        }

        return {
          ...state,
          claimId: null,
          ownerId: null,
          inFlight: false,
          completedAt: succeeded ? now : state.completedAt,
          failedAt: succeeded ? null : now
        };
      },
      { skipWriteIfUnchanged: true }
    );
  }
}

module.exports = {
  RateLimitRefreshCoordinator,
  normalizeState
};
