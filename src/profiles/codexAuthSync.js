'use strict';

const fs = require('fs');
const path = require('path');

function buildCodexAuthJson(authData) {
  const payload =
    authData && authData.authJson && typeof authData.authJson === 'object'
      ? JSON.parse(JSON.stringify(authData.authJson))
      : {};

  if (!payload.tokens || typeof payload.tokens !== 'object') {
    payload.tokens = {};
  }

  payload.tokens.id_token = authData.idToken;
  payload.tokens.access_token = authData.accessToken;
  payload.tokens.refresh_token = authData.refreshToken;

  if (authData.accountId) {
    payload.tokens.account_id = authData.accountId;
  }

  return `${JSON.stringify(payload, null, 2)}\n`;
}

function syncCodexAuthFile(authPath, authData) {
  const dir = path.dirname(authPath);
  fs.mkdirSync(dir, { recursive: true });

  const tmpPath = path.join(dir, `auth.json.tmp.${process.pid}.${Date.now()}`);
  const content = buildCodexAuthJson(authData);

  fs.writeFileSync(tmpPath, content, { encoding: 'utf8' });

  try {
    try {
      fs.renameSync(tmpPath, authPath);
      return;
    } catch {
      fs.copyFileSync(tmpPath, authPath);
    }
  } finally {
    try {
      if (fs.existsSync(tmpPath)) {
        fs.unlinkSync(tmpPath);
      }
    } catch {
      // Ignore cleanup failures.
    }
  }
}

module.exports = {
  buildCodexAuthJson,
  syncCodexAuthFile
};
