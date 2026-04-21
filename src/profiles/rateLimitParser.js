'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

function getSessionBasePath(customPath) {
  if (customPath) {
    return path.resolve(String(customPath).replace(/^~(?=$|[\\/])/, os.homedir()));
  }
  return path.join(os.homedir(), '.codex', 'sessions');
}

function createEmptyTokenUsage() {
  return {
    input_tokens: 0,
    cached_input_tokens: 0,
    output_tokens: 0,
    reasoning_output_tokens: 0,
    total_tokens: 0
  };
}

function normalizePlanType(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized && normalized !== 'unknown' ? normalized : null;
}

function normalizeComparablePath(value) {
  if (!value) {
    return null;
  }

  try {
    const resolved = path.resolve(String(value)).replace(/\\/g, '/');
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  } catch {
    return null;
  }
}

function isSameOrNestedPath(candidatePath, parentPath) {
  const candidate = normalizeComparablePath(candidatePath);
  const parent = normalizeComparablePath(parentPath);
  if (!candidate || !parent) {
    return false;
  }

  return candidate === parent || candidate.startsWith(`${parent}/`);
}

function formatTokenNumber(value) {
  const numeric = Number(value);
  const thousands = Math.round((Number.isFinite(numeric) ? numeric : 0) / 1000);
  return `${thousands.toLocaleString('en-US')} K`;
}

function formatTokenUsage(usage) {
  const safeUsage = usage || createEmptyTokenUsage();
  return `input ${formatTokenNumber(safeUsage.input_tokens)}, cached ${formatTokenNumber(
    safeUsage.cached_input_tokens
  )}, output ${formatTokenNumber(safeUsage.output_tokens)}, reasoning ${formatTokenNumber(
    safeUsage.reasoning_output_tokens
  )}`;
}

function calculateResetTime(recordTimestampMs, rateLimit) {
  const currentTimeMs = Date.now();
  let resetTimeMs = null;

  if (typeof rateLimit.resets_at === 'number' && !Number.isNaN(rateLimit.resets_at)) {
    resetTimeMs = Math.round(rateLimit.resets_at * 1000);
  } else if (
    typeof rateLimit.resets_in_seconds === 'number' &&
    !Number.isNaN(rateLimit.resets_in_seconds)
  ) {
    resetTimeMs = recordTimestampMs + Math.round(rateLimit.resets_in_seconds * 1000);
  }

  if (!resetTimeMs || !Number.isFinite(resetTimeMs)) {
    return {
      resetTimeMs: recordTimestampMs,
      isOutdated: true,
      secondsUntilReset: 0
    };
  }

  const secondsUntilReset = Math.max(0, Math.floor((resetTimeMs - currentTimeMs) / 1000));
  const isOutdated = resetTimeMs < currentTimeMs;
  return { resetTimeMs, isOutdated, secondsUntilReset };
}

function recordMatchesOptions(record, sessionMeta, options) {
  if (!record || !record.payload || record.payload.type !== 'token_count') {
    return false;
  }

  if (options.workspaceCwd && sessionMeta && sessionMeta.cwd) {
    if (!isSameOrNestedPath(sessionMeta.cwd, options.workspaceCwd)) {
      return false;
    }
  }

  const timestampMs = Date.parse(String(record.timestamp || '').replace('Z', '+00:00'));
  if (
    options.activeSinceMs &&
    Number.isFinite(timestampMs) &&
    timestampMs + 2000 < options.activeSinceMs
  ) {
    return false;
  }

  const expectedPlanType = normalizePlanType(options.expectedPlanType);
  const observedPlanType = normalizePlanType(
    record &&
      record.payload &&
      record.payload.rate_limits &&
      record.payload.rate_limits.plan_type
  );
  if (expectedPlanType && observedPlanType && expectedPlanType !== observedPlanType) {
    return false;
  }

  return true;
}

async function parseSessionFile(filePath, logger, options = {}) {
  try {
    const content = await fs.promises.readFile(filePath, 'utf8');
    const lines = content.split('\n').filter((line) => line.trim());

    let latestRecord = null;
    let latestTimestampMs = 0;
    let sessionMeta = null;

    for (const line of lines) {
      try {
        const record = JSON.parse(line);
        if (record && record.type === 'session_meta' && record.payload) {
          sessionMeta = record.payload;
          continue;
        }

        if (
          record &&
          record.type === 'event_msg' &&
          record.payload &&
          record.payload.type === 'token_count'
        ) {
          const timestampMs = Date.parse(String(record.timestamp || '').replace('Z', '+00:00'));
          if (
            Number.isFinite(timestampMs) &&
            recordMatchesOptions(record, sessionMeta, options) &&
            timestampMs >= latestTimestampMs
          ) {
            latestTimestampMs = timestampMs;
            latestRecord = record;
          }
        }
      } catch {
        // Ignore malformed lines.
      }
    }

    if (!latestRecord) {
      return null;
    }

    return {
      latestRecord,
      latestTimestampMs,
      sessionMeta
    };
  } catch (error) {
    if (logger) {
      logger.warn('Failed to read Codex session file.', {
        filePath,
        error: error && error.message ? error.message : String(error)
      });
    }
    return null;
  }
}

async function collectSessionFilesForDate(sessionPath, date, results, logger) {
  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const datePath = path.join(sessionPath, year, month, day);

  if (!fs.existsSync(datePath)) {
    return;
  }

  try {
    const entries = await fs.promises.readdir(datePath, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.startsWith('rollout-') || !entry.name.endsWith('.jsonl')) {
        continue;
      }

      const filePath = path.join(datePath, entry.name);
      try {
        const stats = await fs.promises.stat(filePath);
        results.push({ file: filePath, mtimeMs: stats.mtimeMs });
      } catch (error) {
        if (logger) {
          logger.warn('Failed to stat Codex session file.', {
            filePath,
            error: error && error.message ? error.message : String(error)
          });
        }
      }
    }
  } catch (error) {
    if (logger) {
      logger.warn('Failed to enumerate Codex session files for a date bucket.', {
        datePath,
        error: error && error.message ? error.message : String(error)
      });
    }
  }
}

async function getSessionFilesWithMtime(sessionPath, logger) {
  const sessionFiles = [];
  const currentDate = new Date();

  for (let daysBack = 0; daysBack < 7; daysBack += 1) {
    const searchDate = new Date(currentDate);
    searchDate.setDate(currentDate.getDate() - daysBack);
    await collectSessionFilesForDate(sessionPath, searchDate, sessionFiles, logger);
  }

  sessionFiles.sort((left, right) => right.mtimeMs - left.mtimeMs);
  return sessionFiles;
}

async function findLatestTokenCountRecord(basePath, logger, options = {}) {
  const sessionPath = getSessionBasePath(basePath);
  if (!fs.existsSync(sessionPath)) {
    return {
      found: false,
      error: `Session path does not exist: ${sessionPath}`
    };
  }

  const attemptedFiles = new Set();
  const tryFile = async (filePath) => {
    if (!filePath || attemptedFiles.has(filePath) || !fs.existsSync(filePath)) {
      return null;
    }

    attemptedFiles.add(filePath);
    const parsedSession = await parseSessionFile(filePath, logger, options);
    if (!parsedSession || !parsedSession.latestRecord) {
      return null;
    }

    return {
      found: true,
      file: filePath,
      record: parsedSession.latestRecord,
      sessionMeta: parsedSession.sessionMeta
    };
  };

  if (options.preferredFile) {
    const preferred = await tryFile(options.preferredFile);
    if (preferred) {
      return preferred;
    }
  }

  const oneHourAgoMs = Date.now() - 60 * 60 * 1000;
  const today = new Date();
  const todayFiles = [];
  await collectSessionFilesForDate(sessionPath, today, todayFiles, logger);

  const recentTodayFiles = todayFiles
    .filter((entry) => entry.mtimeMs >= oneHourAgoMs)
    .sort((left, right) => right.mtimeMs - left.mtimeMs);

  for (const entry of recentTodayFiles) {
    const result = await tryFile(entry.file);
    if (result) {
      return result;
    }
  }

  const sessionFiles = await getSessionFilesWithMtime(sessionPath, logger);
  for (const entry of sessionFiles) {
    const result = await tryFile(entry.file);
    if (result) {
      return result;
    }
  }

  return {
    found: false,
    error: 'No matching token_count events found in session files'
  };
}

async function getRateLimitData(customPath, logger, options = {}) {
  try {
    const lookup = await findLatestTokenCountRecord(customPath, logger, options);
    if (!lookup.found) {
      return {
        found: false,
        error: lookup.error
      };
    }

    const filePath = lookup.file;
    const record = lookup.record;
    const payload = record.payload || {};
    const rateLimits = payload.rate_limits || {};
    const info = payload.info || {};
    const recordTimestampMs = Date.parse(String(record.timestamp || '').replace('Z', '+00:00'));
    const currentTimeMs = Date.now();

    const totalUsage = info.total_token_usage || createEmptyTokenUsage();
    const lastUsage = info.last_token_usage || createEmptyTokenUsage();

    const data = {
      filePath,
      recordTimestampMs,
      currentTimeMs,
      planType: rateLimits.plan_type || null,
      sessionId: lookup.sessionMeta && lookup.sessionMeta.id ? lookup.sessionMeta.id : null,
      sessionCwd: lookup.sessionMeta && lookup.sessionMeta.cwd ? lookup.sessionMeta.cwd : null,
      totalUsage,
      lastUsage,
      primary: null,
      secondary: null
    };

    if (rateLimits.primary) {
      const primary = rateLimits.primary;
      const { resetTimeMs, isOutdated, secondsUntilReset } = calculateResetTime(
        recordTimestampMs,
        primary
      );
      const windowMinutes =
        typeof primary.window_minutes === 'number' && primary.window_minutes > 0
          ? primary.window_minutes
          : 0;
      const windowSeconds = windowMinutes * 60;
      const elapsedSeconds = Math.max(0, Math.min(windowSeconds, windowSeconds - secondsUntilReset));
      data.primary = {
        usedPercent: Number(primary.used_percent) || 0,
        timePercent:
          windowSeconds <= 0 ? 0 : isOutdated ? 100 : (elapsedSeconds / windowSeconds) * 100,
        resetAt: resetTimeMs,
        outdated: isOutdated,
        windowMinutes
      };
    }

    if (rateLimits.secondary) {
      const secondary = rateLimits.secondary;
      const { resetTimeMs, isOutdated, secondsUntilReset } = calculateResetTime(
        recordTimestampMs,
        secondary
      );
      const windowMinutes =
        typeof secondary.window_minutes === 'number' && secondary.window_minutes > 0
          ? secondary.window_minutes
          : 0;
      const windowSeconds = windowMinutes * 60;
      const elapsedSeconds = Math.max(0, Math.min(windowSeconds, windowSeconds - secondsUntilReset));
      data.secondary = {
        usedPercent: Number(secondary.used_percent) || 0,
        timePercent:
          windowSeconds <= 0 ? 0 : isOutdated ? 100 : (elapsedSeconds / windowSeconds) * 100,
        resetAt: resetTimeMs,
        outdated: isOutdated,
        windowMinutes
      };
    }

    return {
      found: true,
      data
    };
  } catch (error) {
    return {
      found: false,
      error: error && error.message ? error.message : String(error)
    };
  }
}

module.exports = {
  formatTokenUsage,
  getRateLimitData
};
