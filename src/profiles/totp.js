'use strict';

const crypto = require('crypto');

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const SUPPORTED_ALGORITHMS = new Set(['SHA1', 'SHA256', 'SHA512']);

function normalizeBase32Secret(value) {
  const secret = String(value || '')
    .trim()
    .replace(/[\s-]+/g, '')
    .replace(/=+$/g, '')
    .toUpperCase();
  if (!secret) {
    throw new Error('A 2FA secret is required.');
  }
  if (!/^[A-Z2-7]+$/.test(secret)) {
    throw new Error('The 2FA secret must be Base32 text or a valid otpauth:// URI.');
  }
  return secret;
}

function normalizeAlgorithm(value) {
  const algorithm = String(value || 'SHA1').trim().toUpperCase();
  if (!SUPPORTED_ALGORITHMS.has(algorithm)) {
    throw new Error(`Unsupported TOTP algorithm: ${algorithm}.`);
  }
  return algorithm;
}

function normalizeInteger(value, fallback, minimum, maximum, label) {
  const number = value == null || value === '' ? fallback : Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} to ${maximum}.`);
  }
  return number;
}

function normalizeTotpConfiguration(value) {
  const input = String(value || '').trim();
  if (!input) {
    throw new Error('A 2FA secret is required.');
  }

  let secret = input;
  let algorithm = 'SHA1';
  let digits = 6;
  let period = 30;
  let issuer = '';
  let account = '';

  if (/^otpauth:\/\//i.test(input)) {
    let uri;
    try {
      uri = new URL(input);
    } catch {
      throw new Error('The otpauth:// URI is invalid.');
    }
    if (uri.protocol !== 'otpauth:' || uri.hostname.toLowerCase() !== 'totp') {
      throw new Error('Only otpauth://totp URIs are supported.');
    }
    secret = uri.searchParams.get('secret') || '';
    algorithm = uri.searchParams.get('algorithm') || algorithm;
    digits = uri.searchParams.get('digits') || digits;
    period = uri.searchParams.get('period') || period;
    issuer = String(uri.searchParams.get('issuer') || '').trim();
    const label = decodeURIComponent(uri.pathname.replace(/^\/+/, ''));
    account = label.includes(':') ? label.slice(label.indexOf(':') + 1).trim() : label.trim();
    if (!issuer && label.includes(':')) {
      issuer = label.slice(0, label.indexOf(':')).trim();
    }
  }

  return {
    secret: normalizeBase32Secret(secret),
    algorithm: normalizeAlgorithm(algorithm),
    digits: normalizeInteger(digits, 6, 6, 8, 'TOTP digits'),
    period: normalizeInteger(period, 30, 15, 300, 'TOTP period'),
    issuer,
    account
  };
}

function decodeBase32(value) {
  const secret = normalizeBase32Secret(value);
  let bits = 0;
  let bitCount = 0;
  const bytes = [];
  for (const character of secret) {
    bits = (bits << 5) | BASE32_ALPHABET.indexOf(character);
    bitCount += 5;
    while (bitCount >= 8) {
      bitCount -= 8;
      bytes.push((bits >>> bitCount) & 0xff);
      bits &= (1 << bitCount) - 1;
    }
  }
  if (!bytes.length) {
    throw new Error('The 2FA secret is too short.');
  }
  return Buffer.from(bytes);
}

function generateTotpCode(configuration, timestamp = Date.now()) {
  const config = normalizeTotpConfiguration(
    typeof configuration === 'string'
      ? configuration
      : configuration && configuration.secret
  );
  if (configuration && typeof configuration === 'object') {
    config.algorithm = normalizeAlgorithm(configuration.algorithm);
    config.digits = normalizeInteger(configuration.digits, 6, 6, 8, 'TOTP digits');
    config.period = normalizeInteger(configuration.period, 30, 15, 300, 'TOTP period');
    config.issuer = String(configuration.issuer || '');
    config.account = String(configuration.account || '');
  }

  const timestampMs = Number(timestamp);
  if (!Number.isFinite(timestampMs) || timestampMs < 0) {
    throw new Error('A valid timestamp is required to generate a TOTP code.');
  }

  const counter = BigInt(Math.floor(timestampMs / 1000 / config.period));
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(counter);
  const digest = crypto
    .createHmac(config.algorithm.toLowerCase(), decodeBase32(config.secret))
    .update(counterBuffer)
    .digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);
  const code = String(binary % (10 ** config.digits)).padStart(config.digits, '0');
  const validUntil = (Number(counter) + 1) * config.period * 1000;

  return {
    code,
    digits: config.digits,
    period: config.period,
    validUntil,
    issuer: config.issuer,
    account: config.account
  };
}

function trimOtpauthCandidate(value) {
  return String(value || '').replace(/[),.;\]}]+$/g, '');
}

function findTotpCandidates(value) {
  const text = String(value || '');
  const lines = text.split(/\r?\n/);
  const candidates = [];
  const seen = new Set();
  const uriPattern = /otpauth:\/\/totp\/[^\s<>"']+/gi;
  const labelledSecretPattern =
    /(?:\b(?:2fa|totp|otp|secret)\b|секрет|ключ)\s*(?:secret\s*)?[:=\-]\s*([A-Z2-7](?:[A-Z2-7\s-]{14,}[A-Z2-7]))/gi;

  lines.forEach((line, lineIndex) => {
    const uriRanges = [];
    for (const match of line.matchAll(uriPattern)) {
      const candidate = trimOtpauthCandidate(match[0]);
      uriRanges.push({
        start: match.index || 0,
        end: (match.index || 0) + match[0].length
      });
      const key = `${lineIndex}:${candidate}`;
      if (!seen.has(key)) {
        seen.add(key);
        candidates.push({
          lineIndex,
          columnIndex: match.index || 0,
          value: candidate,
          kind: 'otpauth'
        });
      }
    }
    for (const match of line.matchAll(labelledSecretPattern)) {
      const matchIndex = match.index || 0;
      if (uriRanges.some((range) => matchIndex >= range.start && matchIndex < range.end)) {
        continue;
      }
      const candidate = String(match[1] || '').trim();
      const key = `${lineIndex}:${candidate}`;
      if (!seen.has(key)) {
        seen.add(key);
        candidates.push({
          lineIndex,
          columnIndex: matchIndex,
          value: candidate,
          kind: 'labelled-secret'
        });
      }
    }
  });

  return candidates;
}

function generateDetectedTotpCodes(value, timestamp = Date.now()) {
  return findTotpCandidates(value).flatMap((candidate, index) => {
    try {
      const generated = generateTotpCode(candidate.value, timestamp);
      return [{
        id: `${candidate.lineIndex}:${candidate.columnIndex}:${index}`,
        lineIndex: candidate.lineIndex,
        kind: candidate.kind,
        code: generated.code,
        digits: generated.digits,
        period: generated.period,
        validUntil: generated.validUntil,
        issuer: generated.issuer,
        account: generated.account
      }];
    } catch {
      return [];
    }
  });
}

module.exports = {
  findTotpCandidates,
  generateDetectedTotpCodes,
  generateTotpCode,
  normalizeBase32Secret,
  normalizeTotpConfiguration
};
