'use strict';

const { randomBytes } = require('crypto');
const vscode = require('vscode');
const { formatLocalDateTime } = require('../ui/userFormatting');

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function createNonce() {
  return randomBytes(18).toString('base64');
}

function formatTimestamp(value) {
  return value ? formatLocalDateTime(value) : 'Unavailable';
}

function formatDuration(value) {
  const milliseconds = Number(value);
  if (!Number.isFinite(milliseconds) || milliseconds < 0) {
    return 'Unavailable';
  }
  if (milliseconds < 1000) {
    return `${Math.round(milliseconds)} ms`;
  }
  const seconds = Math.round(milliseconds / 100) / 10;
  if (seconds < 60) {
    return `${seconds} s`;
  }
  const minutes = Math.floor(seconds / 60);
  return `${minutes} min ${Math.round(seconds % 60)} s`;
}

function yesNo(value) {
  return value === true ? 'Yes' : 'No';
}

function statusLabel(status) {
  switch (status) {
    case 'completed':
      return 'Completed';
    case 'partial':
      return 'Partially completed';
    case 'failed':
      return 'Failed';
    case 'cancelled':
      return 'Cancelled';
    case 'not-run':
      return 'Not run';
    case 'needs-auth':
      return 'Sign-in required';
    case 'chat-closed':
      return 'Chat closed early';
    case 'conversation-not-created':
      return 'Conversation not created';
    case 'turn-failed':
      return 'Turn failed';
    case 'turn-timeout':
      return 'Answer timed out';
    case 'empty-response':
      return 'Empty response';
    case 'ui-unavailable':
      return 'Codex UI unavailable';
    default:
      return status || 'Unknown';
  }
}

function renderRows(rows) {
  return rows
    .filter((row) => row[1] !== null && row[1] !== undefined && row[1] !== '')
    .map(
      ([label, value]) =>
        `<div class="key">${escapeHtml(label)}</div><div class="value">${escapeHtml(value)}</div>`
    )
    .join('');
}

function renderRateLimitWindow(label, window) {
  if (!window) {
    return `<div class="muted">${escapeHtml(label)}: unavailable</div>`;
  }
  return `<div class="limit-window">
    <strong>${escapeHtml(label)}</strong>
    <span>Used: ${escapeHtml(
      window.usedPercent == null ? 'Unavailable' : `${window.usedPercent}%`
    )}</span>
    <span>Reset: ${escapeHtml(formatTimestamp(window.resetAt))}</span>
    <span>Window: ${escapeHtml(
      window.windowMinutes == null ? 'Unavailable' : `${window.windowMinutes} min`
    )}</span>
  </div>`;
}

function renderTimeline(events) {
  if (!Array.isArray(events) || events.length === 0) {
    return '<div class="muted">No timeline events were recorded.</div>';
  }
  return `<ol class="timeline">${events
    .map(
      (event) => `<li>
        <time>${escapeHtml(formatTimestamp(event.at))}</time>
        <strong>${escapeHtml(String(event.phase || '').replace(/-/g, ' '))}</strong>
        ${event.profileName ? `<span>${escapeHtml(event.profileName)}</span>` : ''}
        ${event.detail ? `<pre>${escapeHtml(event.detail)}</pre>` : ''}
      </li>`
    )
    .join('')}</ol>`;
}

function renderChatSnapshot(account) {
  const hasSnapshot = account.prompt || account.responseText || account.threadId;
  if (!hasSnapshot) {
    return `<details class="nested">
      <summary>Chat snapshot</summary>
      <div class="muted section-body">The chat did not reach a stage where a snapshot could be captured.</div>
    </details>`;
  }
  return `<details class="nested chat-details">
    <summary>Chat snapshot · archived: ${escapeHtml(yesNo(account.archived))}</summary>
    <div class="section-body chat-shot" role="img" aria-label="Visual snapshot of the Codex activation chat">
      <div class="chat-toolbar">
        <span>Codex service chat</span>
        <span>${escapeHtml(account.threadId || 'Thread ID unavailable')}</span>
      </div>
      <div class="bubble user">
        <div class="speaker">User</div>
        <pre>${escapeHtml(account.prompt || 'тест')}</pre>
      </div>
      <div class="bubble assistant">
        <div class="speaker">Codex</div>
        <pre>${escapeHtml(account.responseText || 'No assistant response captured.')}</pre>
      </div>
      <div class="chat-meta">
        Response length: ${escapeHtml(account.responseLength || 0)} ·
        Thread reused: ${escapeHtml(yesNo(account.threadReused))} ·
        Archive error: ${escapeHtml(account.archiveError || 'None')}
      </div>
    </div>
  </details>`;
}

function renderAccount(account, reportEvents) {
  const accountEvents = (reportEvents || []).filter(
    (event) => event.profileId === account.profileId
  );
  const rateLimit = account.rateLimit || {};
  const openAttribute = account.status !== 'completed' && account.status !== 'not-run'
    ? ' open'
    : '';
  return `<details class="account ${escapeHtml(account.status)}"${openAttribute}>
    <summary>
      <span>${escapeHtml(account.profileName || account.profileId)}</span>
      <span class="status ${escapeHtml(account.status)}">${escapeHtml(
        statusLabel(account.status)
      )}</span>
    </summary>
    <div class="section-body">
      <div class="grid">
        ${renderRows([
          ['Profile ID', account.profileId],
          ['Started', formatTimestamp(account.startedAt)],
          ['Finished', formatTimestamp(account.completedAt)],
          ['Duration', formatDuration(account.durationMs)],
          ['Failed phase', account.failedPhase],
          ['Thread ID', account.threadId],
          ['Thread reused', yesNo(account.threadReused)],
          ['Chat archived', yesNo(account.archived)],
          ['Usage API confirmed', yesNo(account.limitConfirmed)],
          ['Rate-limit source', rateLimit.source],
          ['Rate-limit observed', formatTimestamp(rateLimit.observedAt)],
          ['Plan', rateLimit.planType]
        ])}
      </div>
      ${
        account.error
          ? `<div class="error-block"><strong>Error</strong><pre>${escapeHtml(
              account.error
            )}</pre></div>`
          : ''
      }
      <div class="limits">
        ${renderRateLimitWindow('Primary', rateLimit.primary)}
        ${renderRateLimitWindow('Secondary', rateLimit.secondary)}
      </div>
      ${renderChatSnapshot(account)}
      <details class="nested">
        <summary>Account timeline</summary>
        <div class="section-body">${renderTimeline(accountEvents)}</div>
      </details>
      <details class="nested">
        <summary>Codex diagnostics</summary>
        <div class="section-body"><pre>${escapeHtml(
          account.diagnostics || 'No Codex diagnostics were captured.'
        )}</pre></div>
      </details>
    </div>
  </details>`;
}

function buildActivationReportHtml(report) {
  const nonce = createNonce();
  const environment = report.environment || {};
  const accounts = Array.isArray(report.accounts) ? report.accounts : [];
  const events = Array.isArray(report.events) ? report.events : [];
  const rawReport = JSON.stringify(report, null, 2);
  const status = report.status || 'unknown';
  return `<!DOCTYPE html>
    <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta
          http-equiv="Content-Security-Policy"
          content="default-src 'none'; style-src 'nonce-${nonce}';"
        >
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Codex counter activation report</title>
        <style nonce="${nonce}">
          * { box-sizing: border-box; }
          body {
            max-width: 1120px;
            margin: 0 auto;
            padding: 24px;
            color: var(--vscode-editor-foreground);
            background: var(--vscode-editor-background);
            font-family: var(--vscode-font-family);
          }
          h1 { margin: 0 0 6px; font-size: 24px; }
          .subtitle, .muted { color: var(--vscode-descriptionForeground); }
          .summary {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
            gap: 10px;
            margin: 20px 0;
          }
          .card, details {
            border: 1px solid var(--vscode-panel-border);
            border-radius: 8px;
            background: var(--vscode-sideBar-background);
          }
          .card { padding: 14px; }
          .card strong { display: block; margin-top: 4px; font-size: 20px; }
          .privacy {
            margin: 12px 0 20px;
            padding: 10px 12px;
            border-left: 3px solid var(--vscode-notificationsInfoIcon-foreground);
            background: var(--vscode-textBlockQuote-background);
          }
          details { margin: 10px 0; overflow: hidden; }
          summary {
            display: flex;
            justify-content: space-between;
            gap: 12px;
            padding: 12px 14px;
            cursor: pointer;
            font-weight: 600;
            background: var(--vscode-list-hoverBackground);
          }
          .section-body { padding: 14px; }
          .nested { margin: 12px 0 0; background: var(--vscode-editor-background); }
          .grid {
            display: grid;
            grid-template-columns: minmax(150px, 220px) minmax(0, 1fr);
            gap: 7px 14px;
          }
          .key { color: var(--vscode-descriptionForeground); }
          .value { min-width: 0; overflow-wrap: anywhere; font-family: var(--vscode-editor-font-family); }
          .status { font-weight: 600; }
          .status.completed { color: var(--vscode-testing-iconPassed); }
          .status.failed { color: var(--vscode-testing-iconFailed); }
          .status.needs-auth, .status.chat-closed, .status.conversation-not-created,
          .status.turn-failed, .status.turn-timeout, .status.empty-response,
          .status.ui-unavailable { color: var(--vscode-testing-iconFailed); }
          .status.cancelled, .status.partial { color: var(--vscode-editorWarning-foreground); }
          .limits {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
            gap: 10px;
            margin-top: 14px;
          }
          .limit-window {
            display: grid;
            gap: 5px;
            padding: 12px;
            border: 1px solid var(--vscode-panel-border);
            border-radius: 6px;
          }
          .chat-shot {
            border: 1px solid var(--vscode-panel-border);
            border-radius: 8px;
            background: var(--vscode-editor-background);
          }
          .chat-toolbar {
            display: flex;
            justify-content: space-between;
            gap: 12px;
            margin: -14px -14px 14px;
            padding: 10px 12px;
            color: var(--vscode-descriptionForeground);
            border-bottom: 1px solid var(--vscode-panel-border);
            font-size: 12px;
            overflow-wrap: anywhere;
          }
          .bubble {
            width: min(82%, 760px);
            margin: 10px 0;
            padding: 10px 12px;
            border-radius: 10px;
          }
          .bubble.user {
            margin-left: auto;
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
          }
          .bubble.assistant { background: var(--vscode-textBlockQuote-background); }
          .speaker { margin-bottom: 6px; font-size: 11px; font-weight: 700; text-transform: uppercase; }
          .chat-meta { margin-top: 12px; color: var(--vscode-descriptionForeground); font-size: 12px; }
          pre {
            margin: 0;
            white-space: pre-wrap;
            overflow-wrap: anywhere;
            font-family: var(--vscode-editor-font-family);
            font-size: var(--vscode-editor-font-size);
          }
          .error-block {
            margin-top: 14px;
            padding: 12px;
            border-left: 3px solid var(--vscode-testing-iconFailed);
            background: var(--vscode-inputValidation-errorBackground);
          }
          .timeline { margin: 0; padding-left: 24px; }
          .timeline li { margin: 8px 0; }
          .timeline time { display: inline-block; min-width: 220px; color: var(--vscode-descriptionForeground); }
          .timeline span { margin-left: 8px; color: var(--vscode-descriptionForeground); }
          .timeline pre { margin: 5px 0 0; }
          @media (max-width: 620px) {
            body { padding: 14px; }
            .grid { grid-template-columns: 1fr; gap: 3px; }
            .value { margin-bottom: 7px; }
            .bubble { width: 100%; }
            .timeline time { display: block; min-width: 0; }
          }
        </style>
      </head>
      <body>
        <h1>Codex counter activation report</h1>
        <div class="subtitle">Job ${escapeHtml(report.jobId || 'unavailable')} · ${escapeHtml(
          formatTimestamp(report.completedAt)
        )}</div>
        <div class="summary">
          <div class="card">Status<strong class="status ${escapeHtml(status)}">${escapeHtml(
            statusLabel(status)
          )}</strong></div>
          <div class="card">Method<strong>${escapeHtml(
            report.modeLabel || report.mode || 'Unavailable'
          )}</strong></div>
          <div class="card">Succeeded<strong>${escapeHtml(report.succeeded || 0)} / ${escapeHtml(
            report.attempted || 0
          )}</strong></div>
          <div class="card">Failed<strong>${escapeHtml(report.failed || 0)}</strong></div>
          <div class="card">Unconfirmed<strong>${escapeHtml(report.unconfirmed || 0)}</strong></div>
          <div class="card">Duration<strong>${escapeHtml(
            formatDuration(report.durationMs)
          )}</strong></div>
          <div class="card">Original restored<strong>${escapeHtml(
            yesNo(report.originalAccountRestored)
          )}</strong></div>
        </div>
        <div class="privacy">
          This report contains no authentication tokens or saved credentials. Chat snapshots contain only the
          activation prompt and the assistant response returned for it.
        </div>
        ${
          report.lastError
            ? `<div class="error-block"><strong>Run error</strong><pre>${escapeHtml(
                report.lastError
              )}</pre></div>`
            : ''
        }
        <h2>Accounts</h2>
        ${
          accounts.length
            ? accounts.map((account) => renderAccount(account, events)).join('')
            : '<div class="muted">No account attempts were recorded.</div>'
        }
        <h2>Run diagnostics</h2>
        <details>
          <summary>Environment and paths</summary>
          <div class="section-body grid">
            ${renderRows([
              ['Extension version', environment.extensionVersion],
              ['VS Code version', environment.vscodeVersion],
              ['Official Codex version', environment.codexExtensionVersion],
              ['Activation method', report.modeLabel || report.mode],
              ['Platform', environment.platform],
              ['Architecture', environment.architecture],
              ['Workspace trusted', yesNo(environment.workspaceTrusted)],
              ['Original profile', report.originalProfileName],
              ['Original profile ID', report.originalProfileId],
              ['Job file', report.jobPath],
              ['Worker workspace', report.workerWorkspacePath],
              ['Final phase', report.phase],
              ['Started', formatTimestamp(report.createdAt)],
              ['Completed', formatTimestamp(report.completedAt)]
            ])}
          </div>
        </details>
        <details>
          <summary>Full run timeline</summary>
          <div class="section-body">${renderTimeline(events)}</div>
        </details>
        <details>
          <summary>Machine-readable report JSON</summary>
          <div class="section-body"><pre>${escapeHtml(rawReport)}</pre></div>
        </details>
      </body>
    </html>`;
}

class RateLimitActivationReportPanel {
  static currentPanel;

  static createOrShow(report) {
    if (!report || typeof report !== 'object') {
      return null;
    }
    const column = vscode.window.activeTextEditor
      ? vscode.window.activeTextEditor.viewColumn
      : vscode.ViewColumn.One;
    if (RateLimitActivationReportPanel.currentPanel) {
      RateLimitActivationReportPanel.currentPanel.panel.reveal(column);
      RateLimitActivationReportPanel.currentPanel.update(report);
      return RateLimitActivationReportPanel.currentPanel;
    }
    const panel = vscode.window.createWebviewPanel(
      'codexCounterActivationReport',
      'Codex counter activation report',
      column,
      {
        enableScripts: false,
        retainContextWhenHidden: true
      }
    );
    const instance = new RateLimitActivationReportPanel(panel, report);
    RateLimitActivationReportPanel.currentPanel = instance;
    return instance;
  }

  constructor(panel, report) {
    this.panel = panel;
    this.disposable = panel.onDidDispose(() => this.dispose());
    this.update(report);
  }

  update(report) {
    this.report = report;
    this.panel.webview.html = buildActivationReportHtml(report);
  }

  dispose() {
    if (this.disposable) {
      this.disposable.dispose();
      this.disposable = null;
    }
    if (RateLimitActivationReportPanel.currentPanel === this) {
      RateLimitActivationReportPanel.currentPanel = undefined;
    }
  }
}

module.exports = {
  RateLimitActivationReportPanel,
  buildActivationReportHtml
};
