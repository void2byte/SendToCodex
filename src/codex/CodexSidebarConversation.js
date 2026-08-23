'use strict';

const fs = require('fs');
const path = require('path');

const CODEX_EXTENSION_LOG_DIRECTORY = 'openai.chatgpt';
const CODEX_LOG_FILE_NAME = 'Codex.log';
const CODEX_CONVERSATION_ID_PATTERN =
  '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const RESUME_SUCCESS_PATTERN = new RegExp(
  `maybe_resume_success\\s+conversationId=(${CODEX_CONVERSATION_ID_PATTERN})`,
  'gi'
);
const HANDLING_URI_PREFIX_PATTERN = /Handling URI\s+path=\/local\//i;

function getOfficialCodexLogPath(extensionLogDirectory) {
  const ownLogDirectory = String(extensionLogDirectory || '').trim();
  if (!ownLogDirectory) {
    return null;
  }

  return path.join(
    path.dirname(path.resolve(ownLogDirectory)),
    CODEX_EXTENSION_LOG_DIRECTORY,
    CODEX_LOG_FILE_NAME
  );
}

function getFileSize(filePath) {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

function readLogSince(filePath, startOffset) {
  const stat = fs.statSync(filePath);
  const safeStart = stat.size >= startOffset ? startOffset : 0;
  const bytesToRead = stat.size - safeStart;
  if (bytesToRead <= 0) {
    return '';
  }

  const descriptor = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(bytesToRead);
    const bytesRead = fs.readSync(descriptor, buffer, 0, bytesToRead, safeStart);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    fs.closeSync(descriptor);
  }
}

function hasResumeSuccess(text, conversationId) {
  const escapedId = String(conversationId).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`maybe_resume_success\\s+conversationId=${escapedId}(?:\\s|$)`, 'i').test(
    String(text || '')
  );
}

function hasRouteHandlingSuccess(text, conversationId) {
  const source = String(text || '');
  if (!HANDLING_URI_PREFIX_PATTERN.test(source)) {
    return false;
  }

  const escapedId = String(conversationId).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`Handling URI\\s+path=/local/${escapedId}(?:\\s|$)`, 'i').test(source);
}

function hasResumeFailure(text, conversationId) {
  const escapedId = String(conversationId).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(
    `(?:Failed to resume conversation|Request failed|No turns for conversation)\\s+conversationId=${escapedId}(?:\\s|$)`,
    'i'
  ).test(String(text || ''));
}

async function waitForConversationResume(filePath, conversationId, options = {}) {
  const timeoutMs = Math.max(0, Number(options.timeoutMs || 60_000));
  const pollIntervalMs = Math.max(50, Number(options.pollIntervalMs || 250));
  const routeHandlingSettleMs = Math.max(0, Number(options.routeHandlingSettleMs || 1500));
  const startOffset = Math.max(0, Number(options.startOffset) || 0);
  const startedAt = Date.now();
  let observedFailure = false;
  let routeHandledAt = 0;

  while (Date.now() - startedAt <= timeoutMs) {
    try {
      const appended = readLogSince(filePath, startOffset);
      if (hasResumeSuccess(appended, conversationId)) {
        return {
          resumed: true,
          waitedMs: Date.now() - startedAt
        };
      }
      observedFailure = observedFailure || hasResumeFailure(appended, conversationId);
      if (!routeHandledAt && hasRouteHandlingSuccess(appended, conversationId)) {
        routeHandledAt = Date.now();
      }
      if (!observedFailure && routeHandledAt && Date.now() - routeHandledAt >= routeHandlingSettleMs) {
        return {
          resumed: true,
          routeHandled: true,
          waitedMs: Date.now() - startedAt
        };
      }
    } catch (error) {
      if (error && error.code !== 'ENOENT') {
        throw error;
      }
    }

    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  const failureHint = observedFailure
    ? ' The official Codex extension logged a thread/resume failure.'
    : '';
  throw new Error(
    `Codex did not confirm thread/resume for conversation ${conversationId} within ${timeoutMs}ms.${failureHint}`
  );
}

module.exports = {
  CODEX_CONVERSATION_ID_PATTERN,
  getFileSize,
  getOfficialCodexLogPath,
  hasRouteHandlingSuccess,
  hasResumeFailure,
  hasResumeSuccess,
  waitForConversationResume
};
