'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  findTotpCandidates,
  generateDetectedTotpCodes,
  generateTotpCode,
  normalizeTotpConfiguration
} = require('../../src/profiles/totp');

const RFC_SHA1_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

test('TOTP generation matches RFC 6238 SHA-1 vectors', () => {
  const uri =
    `otpauth://totp/Test:alice?secret=${RFC_SHA1_SECRET}` +
    '&issuer=Test&algorithm=SHA1&digits=8&period=30';

  assert.deepEqual(
    generateTotpCode(uri, 59_000),
    {
      code: '94287082',
      digits: 8,
      period: 30,
      validUntil: 60_000,
      issuer: 'Test',
      account: 'alice'
    }
  );
  assert.equal(generateTotpCode(uri, 1_111_111_109_000).code, '07081804');
});

test('plain Base32 secrets use common six-digit TOTP defaults', () => {
  const configuration = normalizeTotpConfiguration(RFC_SHA1_SECRET);

  assert.equal(configuration.algorithm, 'SHA1');
  assert.equal(configuration.digits, 6);
  assert.equal(configuration.period, 30);
  assert.equal(generateTotpCode(configuration, 59_000).code, '287082');
});

test('2FA detection accepts otpauth URIs and labelled secrets without naked false positives', () => {
  const note = [
    'ordinary uppercase text ABCDEFGHIJKLMNOP',
    `2FA: ${RFC_SHA1_SECRET}`,
    `backup otpauth://totp/Test:alice?secret=${RFC_SHA1_SECRET}&digits=8`,
    `ключ: ${RFC_SHA1_SECRET}`
  ].join('\n');
  const candidates = findTotpCandidates(note);
  const codes = generateDetectedTotpCodes(note, 59_000);

  assert.deepEqual(candidates.map((candidate) => candidate.lineIndex), [1, 2, 3]);
  assert.deepEqual(codes.map((item) => item.lineIndex), [1, 2, 3]);
  assert.deepEqual(codes.map((item) => item.code), ['287082', '94287082', '287082']);
  assert.ok(codes.every((item) => !Object.hasOwn(item, 'secret')));
});

test('invalid 2FA text is rejected', () => {
  assert.throws(
    () => normalizeTotpConfiguration('invalid-0-secret'),
    /Base32 text/
  );
  assert.throws(
    () => normalizeTotpConfiguration('otpauth://hotp/Test?secret=ABCDEF234567'),
    /Only otpauth:\/\/totp/
  );
});
