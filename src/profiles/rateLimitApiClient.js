'use strict';

const USAGE_API_URL = 'https://chatgpt.com/backend-api/wham/usage';
const REQUEST_TIMEOUT_MS = 10000;
const WINDOW_SECONDS_TO_MINUTES = 60;

function createEmptyTokenUsage() {
  return {
    input_tokens: 0,
    cached_input_tokens: 0,
    output_tokens: 0,
    reasoning_output_tokens: 0,
    total_tokens: 0
  };
}

function parseJwtPayload(token) {
  try {
    const parts = String(token || '').split('.');
    if (parts.length !== 3) {
      return {};
    }

    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return {};
  }
}

function asNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function clampPercent(value) {
  const numeric = asNumber(value);
  if (numeric == null) {
    return 0;
  }
  return Math.max(0, Math.min(100, numeric));
}

function normalizePlanType(value) {
  const normalized = String(value || '').trim();
  return normalized || null;
}

function getChatGptAccountId(authData) {
  const accessPayload = parseJwtPayload(authData && authData.accessToken);
  const idPayload = parseJwtPayload(authData && authData.idToken);
  const accessAuth = accessPayload['https://api.openai.com/auth'] || {};
  const idAuth = idPayload['https://api.openai.com/auth'] || {};

  return (
    accessAuth.chatgpt_account_id ||
    idAuth.chatgpt_account_id ||
    authData.accountId ||
    (authData.authJson && authData.authJson.tokens && authData.authJson.tokens.account_id) ||
    null
  );
}

function normalizeUsageWindow(windowData, nowMs) {
  if (!windowData || typeof windowData !== 'object') {
    return null;
  }

  const resetAtSeconds = asNumber(windowData.reset_at);
  const windowSeconds = asNumber(windowData.limit_window_seconds);
  const resetAt = resetAtSeconds ? Math.round(resetAtSeconds * 1000) : null;
  const windowMinutes =
    windowSeconds && windowSeconds > 0 ? windowSeconds / WINDOW_SECONDS_TO_MINUTES : 0;
  const windowMs = windowMinutes * WINDOW_SECONDS_TO_MINUTES * 1000;
  const elapsedMs = resetAt && windowMs > 0 ? Math.max(0, windowMs - Math.max(0, resetAt - nowMs)) : 0;

  return {
    usedPercent: clampPercent(windowData.used_percent),
    timePercent: windowMs > 0 ? Math.max(0, Math.min(100, (elapsedMs / windowMs) * 100)) : 0,
    resetAt,
    outdated: Boolean(resetAt && resetAt <= nowMs),
    windowMinutes
  };
}

function getCoreUsageSnapshot(payload) {
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  if (payload.rate_limit && typeof payload.rate_limit === 'object') {
    return payload;
  }

  if (payload.codex && payload.codex.rate_limit && typeof payload.codex.rate_limit === 'object') {
    return payload.codex;
  }

  return null;
}

function normalizeUsageApiPayload(payload) {
  const snapshot = getCoreUsageSnapshot(payload);
  if (!snapshot || !snapshot.rate_limit) {
    return null;
  }

  const nowMs = Date.now();
  const rateLimit = snapshot.rate_limit;

  return {
    filePath: USAGE_API_URL,
    recordTimestampMs: nowMs,
    currentTimeMs: nowMs,
    planType: normalizePlanType(snapshot.plan_type),
    sessionId: null,
    sessionCwd: null,
    totalUsage: createEmptyTokenUsage(),
    lastUsage: createEmptyTokenUsage(),
    primary: normalizeUsageWindow(rateLimit.primary_window, nowMs),
    secondary: normalizeUsageWindow(rateLimit.secondary_window, nowMs)
  };
}

async function requestUsagePayload(authData) {
  if (!authData || !authData.accessToken) {
    return {
      found: false,
      error: 'No Codex access token available for usage API'
    };
  }

  if (typeof fetch !== 'function') {
    return {
      found: false,
      error: 'Fetch API is not available in this VS Code runtime'
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const headers = {
    Accept: 'application/json',
    Authorization: `Bearer ${authData.accessToken}`,
    originator: 'codex_vscode'
  };
  const accountId = getChatGptAccountId(authData);
  if (accountId) {
    headers['ChatGPT-Account-Id'] = accountId;
  }

  try {
    const response = await fetch(USAGE_API_URL, {
      method: 'GET',
      headers,
      signal: controller.signal
    });

    if (!response.ok) {
      return {
        found: false,
        error: `Codex usage API returned HTTP ${response.status}`
      };
    }

    return {
      found: true,
      payload: await response.json()
    };
  } catch (error) {
    return {
      found: false,
      error:
        error && error.name === 'AbortError'
          ? 'Codex usage API request timed out'
          : error && error.message
            ? error.message
            : String(error)
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function getUsageApiRateLimitData(authData, logger) {
  const response = await requestUsagePayload(authData);
  if (!response.found) {
    return response;
  }

  const data = normalizeUsageApiPayload(response.payload);
  if (!data || (!data.primary && !data.secondary)) {
    return {
      found: false,
      error: 'Codex usage API response did not include rate-limit windows'
    };
  }

  if (logger) {
    logger.info('Loaded Codex rate limits from usage API.', {
      source: USAGE_API_URL,
      planType: data.planType,
      primaryWindowMinutes: data.primary ? data.primary.windowMinutes : null,
      secondaryWindowMinutes: data.secondary ? data.secondary.windowMinutes : null
    });
  }

  return {
    found: true,
    data
  };
}

module.exports = {
  getUsageApiRateLimitData,
  normalizeUsageApiPayload
};
