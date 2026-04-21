'use strict';

const vscode = require('vscode');
const {
  formatAbsoluteTimestamp,
  formatResetText,
  getProfileRateStatus,
  getWindowLabel
} = require('./profileStatus');
const { formatTokenUsage } = require('./rateLimitParser');

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

class RateLimitDetailsPanel {
  static createOrShow(extensionUri, profileManager, rateLimitMonitor) {
    const column = vscode.window.activeTextEditor
      ? vscode.window.activeTextEditor.viewColumn
      : vscode.ViewColumn.One;

    if (RateLimitDetailsPanel.currentPanel) {
      RateLimitDetailsPanel.currentPanel.panel.reveal(column);
      void RateLimitDetailsPanel.currentPanel.update();
      return RateLimitDetailsPanel.currentPanel;
    }

    const panel = vscode.window.createWebviewPanel(
      'codexRateLimitDetails',
      'Codex Profiles and Limits',
      column || vscode.ViewColumn.One,
      { enableScripts: true, localResourceRoots: [extensionUri] }
    );

    RateLimitDetailsPanel.currentPanel = new RateLimitDetailsPanel(
      panel,
      profileManager,
      rateLimitMonitor
    );
    return RateLimitDetailsPanel.currentPanel;
  }

  constructor(panel, profileManager, rateLimitMonitor) {
    this.panel = panel;
    this.profileManager = profileManager;
    this.rateLimitMonitor = rateLimitMonitor;
    this.disposables = [];

    this.disposables.push(
      this.panel.onDidDispose(() => this.dispose()),
      this.panel.webview.onDidReceiveMessage(async (message) => {
        if (!message || message.command !== 'refresh') {
          return;
        }
        await this.rateLimitMonitor.refresh(true);
        await this.update();
      }),
      this.profileManager.onDidChange(() => {
        void this.update();
      }),
      this.rateLimitMonitor.onDidChange(() => {
        void this.update();
      })
    );

    void this.update();
  }

  dispose() {
    RateLimitDetailsPanel.currentPanel = undefined;
    while (this.disposables.length > 0) {
      const disposable = this.disposables.pop();
      if (disposable) {
        disposable.dispose();
      }
    }
  }

  renderWindow(windowState, fallbackLabel, now) {
    if (!windowState) {
      return '';
    }

    const label = getWindowLabel(windowState, fallbackLabel);
    const status = windowState.resetAt ? formatResetText(windowState.resetAt, now) : 'Ready';
    const resetAt = windowState.resetAt ? formatAbsoluteTimestamp(windowState.resetAt) : 'n/a';

    return `
      <div class="window-card">
        <div class="window-title">${escapeHtml(label)}</div>
        <div class="window-line"><strong>Usage:</strong> ${windowState.usedPercent.toFixed(1)}%</div>
        <div class="window-line"><strong>Status:</strong> ${escapeHtml(status)}</div>
        <div class="window-line"><strong>Reset at:</strong> ${escapeHtml(resetAt)}</div>
      </div>
    `;
  }

  renderProfilesTable(profiles, activeProfileId, now) {
    if (!profiles.length) {
      return '<div class="empty">No saved profiles yet.</div>';
    }

    const rows = profiles.map((profile) => {
      const status = getProfileRateStatus(profile, now);
      return `
        <tr>
          <td>${escapeHtml(profile.name)}${profile.id === activeProfileId ? ' <span class="badge">Active</span>' : ''}</td>
          <td>${escapeHtml(profile.email || 'Unknown')}</td>
          <td>${escapeHtml(status.planText)}</td>
          <td>${escapeHtml(status.compactText)}</td>
          <td>${status.cooldownUntil ? escapeHtml(formatAbsoluteTimestamp(status.cooldownUntil)) : 'n/a'}</td>
          <td>${profile.rateLimitState && profile.rateLimitState.observedAt
            ? escapeHtml(formatAbsoluteTimestamp(profile.rateLimitState.observedAt))
            : 'n/a'}</td>
        </tr>
      `;
    });

    return `
      <table>
        <thead>
          <tr>
            <th>Profile</th>
            <th>Email</th>
            <th>Plan</th>
            <th>Status</th>
            <th>Cooldown ends</th>
            <th>Last observation</th>
          </tr>
        </thead>
        <tbody>${rows.join('')}</tbody>
      </table>
    `;
  }

  async update() {
    const profiles = await this.profileManager.listProfiles();
    const activeProfileId = await this.profileManager.getActiveProfileId();
    const activeProfile = activeProfileId
      ? profiles.find((profile) => profile.id === activeProfileId) || null
      : null;
    const now = Date.now();
    const activeStatus = activeProfile ? getProfileRateStatus(activeProfile, now) : null;
    const lastObservation = this.rateLimitMonitor.getLastObservation();
    const lastError = this.rateLimitMonitor.getLastError();

    const activeWindowsHtml = activeProfile
      ? [
          this.renderWindow(activeStatus.primary, 'Primary', now),
          this.renderWindow(activeStatus.secondary, 'Secondary', now)
        ]
          .filter(Boolean)
          .join('')
      : '';

    const tokenUsageHtml =
      lastObservation && activeProfile
        ? `
          <div class="summary-card">
            <div class="section-title">Token usage</div>
            <div class="window-line"><strong>Total:</strong> ${escapeHtml(
              formatTokenUsage(lastObservation.totalUsage)
            )}</div>
            <div class="window-line"><strong>Last:</strong> ${escapeHtml(
              formatTokenUsage(lastObservation.lastUsage)
            )}</div>
            <div class="window-line"><strong>Source:</strong> ${escapeHtml(
              lastObservation.filePath
            )}</div>
          </div>
        `
        : '';

    this.panel.webview.html = `<!DOCTYPE html>
      <html lang="en">
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Codex Profiles and Limits</title>
          <style>
            body {
              font-family: var(--vscode-font-family);
              margin: 0;
              padding: 20px;
              color: var(--vscode-editor-foreground);
              background: var(--vscode-editor-background);
            }
            .layout {
              display: grid;
              gap: 16px;
            }
            .summary-card,
            .window-card {
              border: 1px solid var(--vscode-panel-border);
              border-radius: 8px;
              padding: 14px;
              background: var(--vscode-sideBar-background);
            }
            .header {
              display: flex;
              justify-content: space-between;
              align-items: center;
              gap: 12px;
            }
            .title {
              font-size: 20px;
              font-weight: 600;
            }
            .subtitle {
              color: var(--vscode-descriptionForeground);
              margin-top: 4px;
            }
            button {
              border: 0;
              border-radius: 6px;
              padding: 8px 12px;
              cursor: pointer;
              color: var(--vscode-button-foreground);
              background: var(--vscode-button-background);
            }
            .section-title {
              font-size: 15px;
              font-weight: 600;
              margin-bottom: 10px;
            }
            .window-grid {
              display: grid;
              grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
              gap: 12px;
            }
            .window-title {
              font-weight: 600;
              margin-bottom: 8px;
            }
            .window-line {
              margin-top: 6px;
              color: var(--vscode-editor-foreground);
            }
            .badge {
              display: inline-block;
              margin-left: 6px;
              padding: 2px 6px;
              border-radius: 6px;
              background: var(--vscode-badge-background);
              color: var(--vscode-badge-foreground);
              font-size: 11px;
            }
            .error {
              color: var(--vscode-errorForeground);
            }
            table {
              width: 100%;
              border-collapse: collapse;
            }
            th, td {
              text-align: left;
              padding: 10px 8px;
              border-bottom: 1px solid var(--vscode-panel-border);
              vertical-align: top;
            }
            th {
              color: var(--vscode-descriptionForeground);
              font-weight: 600;
            }
            .empty {
              color: var(--vscode-descriptionForeground);
            }
          </style>
        </head>
        <body>
          <div class="layout">
            <div class="summary-card">
              <div class="header">
                <div>
                  <div class="title">Codex profiles and limits</div>
                  <div class="subtitle">${
                    activeProfile
                      ? `${escapeHtml(activeProfile.name)} - ${escapeHtml(activeStatus.compactText)}`
                      : 'No active profile selected'
                  }</div>
                </div>
                <button onclick="refresh()">Refresh</button>
              </div>
              ${
                lastError
                  ? `<div class="window-line error"><strong>Monitor:</strong> ${escapeHtml(
                      lastError
                    )}</div>`
                  : ''
              }
              ${
                activeProfile && activeProfile.rateLimitState && activeProfile.rateLimitState.observedAt
                  ? `<div class="window-line"><strong>Last observation:</strong> ${escapeHtml(
                      formatAbsoluteTimestamp(activeProfile.rateLimitState.observedAt)
                    )}</div>`
                  : ''
              }
            </div>

            ${
              activeWindowsHtml
                ? `<div class="window-grid">${activeWindowsHtml}</div>`
                : activeProfile
                  ? '<div class="summary-card"><div class="section-title">Current cooldown</div><div class="empty">No active cooldown windows for the selected profile.</div></div>'
                  : ''
            }

            ${tokenUsageHtml}

            <div class="summary-card">
              <div class="section-title">Saved profiles</div>
              ${this.renderProfilesTable(profiles, activeProfileId, now)}
            </div>
          </div>

          <script>
            const vscode = acquireVsCodeApi();
            function refresh() {
              vscode.postMessage({ command: 'refresh' });
            }
          </script>
        </body>
      </html>`;
  }
}

module.exports = {
  RateLimitDetailsPanel
};
