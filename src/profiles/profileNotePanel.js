'use strict';

const vscode = require('vscode');
const { randomBytes } = require('crypto');
const { displayProfileName } = require('./privacy');
const { generateDetectedTotpCodes } = require('./totp');

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function createNonce() {
  return randomBytes(18).toString('base64');
}

function escapeScriptJson(value) {
  return JSON.stringify(value)
    .replace(/&/g, '\\u0026')
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

class ProfileNotePanel {
  static panelsByProfileId = new Map();

  static closeForProfile(profileId) {
    const existing = ProfileNotePanel.panelsByProfileId.get(profileId);
    if (!existing) {
      return;
    }

    existing.panel.dispose();
    if (ProfileNotePanel.panelsByProfileId.has(profileId)) {
      existing.dispose();
    }
  }

  static async createOrShow(profileManager, profile) {
    if (!profile || !profile.id) {
      throw new Error('Cannot open a private note without a Codex profile.');
    }

    const existing = ProfileNotePanel.panelsByProfileId.get(profile.id);
    if (existing) {
      existing.panel.reveal(vscode.ViewColumn.Beside);
      return existing;
    }

    const [note, totp] = await Promise.all([
      profileManager.readProfilePrivateNote(profile.id),
      typeof profileManager.getProfileTotpCode === 'function'
        ? profileManager.getProfileTotpCode(profile.id)
        : Promise.resolve({ configured: false })
    ]);
    const panel = vscode.window.createWebviewPanel(
      'codexProfilePrivateNote',
      `Private note — ${displayProfileName(profile)}`,
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true
      }
    );
    const instance = new ProfileNotePanel(panel, profileManager, profile);
    ProfileNotePanel.panelsByProfileId.set(profile.id, instance);
    instance.render(note, totp);
    return instance;
  }

  constructor(panel, profileManager, profile) {
    this.panel = panel;
    this.profileManager = profileManager;
    this.profile = profile;
    this.saveQueue = Promise.resolve();
    this.disposables = [
      panel.onDidDispose(() => this.dispose()),
      panel.webview.onDidReceiveMessage((message) => {
        void this.handleMessage(message);
      })
    ];
  }

  dispose() {
    ProfileNotePanel.panelsByProfileId.delete(this.profile.id);
    while (this.disposables.length > 0) {
      const disposable = this.disposables.pop();
      if (disposable) {
        disposable.dispose();
      }
    }
  }

  async handleMessage(message) {
    if (!message || typeof message !== 'object') {
      return;
    }

    if (message.command !== 'save') {
      await this.handleTotpMessage(message);
      return;
    }

    const revision = Number(message.revision) || 0;
    const value = typeof message.value === 'string' ? message.value : '';
    this.saveQueue = this.saveQueue.then(async () => {
      try {
        await this.profileManager.writeProfilePrivateNote(this.profile.id, value);
        await this.panel.webview.postMessage({
          command: 'saved',
          revision
        });
      } catch (error) {
        await this.panel.webview.postMessage({
          command: 'saveError',
          revision,
          message: error && error.message ? error.message : String(error)
        });
      }
    });
    await this.saveQueue;
  }

  async handleTotpMessage(message) {
    const requestId = message.requestId;
    try {
      if (message.command === 'saveTotp') {
        if (typeof message.value !== 'string') {
          throw new Error('A 2FA secret or otpauth:// URI is required.');
        }
        await this.profileManager.writeProfileTotpConfiguration(
          this.profile.id,
          message.value
        );
      } else if (message.command === 'clearTotp') {
        await this.profileManager.deleteProfileTotpConfiguration(this.profile.id);
      } else if (message.command === 'copyTotp') {
        const current = await this.profileManager.getProfileTotpCode(this.profile.id);
        if (!current.configured || !current.code) {
          throw new Error('2FA is not configured for this account.');
        }
        await vscode.env.clipboard.writeText(current.code);
        await this.panel.webview.postMessage({
          command: 'totpCopied',
          requestId,
          totp: current
        });
        return;
      } else if (message.command === 'requestDetectedTotp') {
        if (typeof message.value !== 'string' || message.value.length > MAX_NOTE_LENGTH_FOR_WEBVIEW) {
          throw new Error('Private account note text is invalid.');
        }
        await this.panel.webview.postMessage({
          command: 'detectedTotpUpdated',
          requestId,
          detections: generateDetectedTotpCodes(message.value)
        });
        return;
      } else if (message.command === 'copyDetectedTotp') {
        const code = typeof message.value === 'string' ? message.value : '';
        if (!/^\d{6,8}$/.test(code)) {
          throw new Error('The detected 2FA code is invalid.');
        }
        await vscode.env.clipboard.writeText(code);
        await this.panel.webview.postMessage({
          command: 'detectedTotpCopied',
          requestId
        });
        return;
      } else if (message.command !== 'requestTotp') {
        return;
      }

      const totp = await this.profileManager.getProfileTotpCode(this.profile.id);
      await this.panel.webview.postMessage({
        command: 'totpUpdated',
        requestId,
        totp
      });
    } catch (error) {
      await this.panel.webview.postMessage({
        command: 'totpError',
        requestId,
        message: error && error.message ? error.message : String(error)
      });
    }
  }

  render(note, initialTotp = { configured: false }) {
    const nonce = createNonce();
    const profileName = displayProfileName(this.profile);
    this.panel.webview.html = `<!DOCTYPE html>
      <html lang="en">
        <head>
          <meta charset="UTF-8">
          <meta
            http-equiv="Content-Security-Policy"
            content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';"
          >
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Private note</title>
          <style nonce="${nonce}">
            body {
              box-sizing: border-box;
              display: grid;
              grid-template-rows: auto auto minmax(240px, 1fr) auto;
              gap: 12px;
              height: 100vh;
              margin: 0;
              padding: 16px;
              color: var(--vscode-editor-foreground);
              background: var(--vscode-editor-background);
              font-family: var(--vscode-font-family);
            }
            .header {
              display: flex;
              align-items: center;
              justify-content: space-between;
              gap: 12px;
            }
            .title {
              font-size: 16px;
              font-weight: 600;
            }
            .subtitle,
            #status,
            #totpStatus {
              color: var(--vscode-descriptionForeground);
              font-size: 12px;
            }
            textarea {
              box-sizing: border-box;
              width: 100%;
              height: 100%;
              resize: none;
              padding: 12px;
              border: 1px solid var(--vscode-input-border);
              outline: none;
              color: var(--vscode-input-foreground);
              background: var(--vscode-input-background);
              font-family: var(--vscode-editor-font-family);
              font-size: var(--vscode-editor-font-size);
              line-height: 1.5;
            }
            textarea:focus {
              border-color: var(--vscode-focusBorder);
            }
            button {
              min-height: 30px;
              padding: 5px 12px;
              border: 0;
              border-radius: 4px;
              color: var(--vscode-button-foreground);
              background: var(--vscode-button-background);
              cursor: pointer;
            }
            button:hover {
              background: var(--vscode-button-hoverBackground);
            }
            button.secondary {
              color: var(--vscode-button-secondaryForeground);
              background: var(--vscode-button-secondaryBackground);
            }
            button.secondary:hover {
              background: var(--vscode-button-secondaryHoverBackground);
            }
            button:disabled {
              cursor: default;
              opacity: 0.55;
            }
            .totp-panel {
              display: grid;
              gap: 9px;
              padding: 12px;
              border: 1px solid var(--vscode-panel-border);
              border-radius: 6px;
              background: var(--vscode-sideBar-background);
            }
            .totp-row {
              display: flex;
              align-items: center;
              gap: 8px;
              flex-wrap: wrap;
            }
            #totpCode {
              min-width: 120px;
              font-family: var(--vscode-editor-font-family);
              font-size: 20px;
              font-weight: 700;
              letter-spacing: 3px;
            }
            #totpInput {
              box-sizing: border-box;
              flex: 1 1 300px;
              min-width: 0;
              min-height: 32px;
              padding: 5px 9px;
              border: 1px solid var(--vscode-input-border);
              border-radius: 4px;
              color: var(--vscode-input-foreground);
              background: var(--vscode-input-background);
              font: inherit;
            }
            #detectedTotpPanel {
              display: grid;
              gap: 6px;
              padding-top: 8px;
              border-top: 1px solid var(--vscode-panel-border);
            }
            #detectedTotpPanel[hidden] {
              display: none;
            }
            #detectedTotpCodes {
              display: flex;
              align-items: center;
              gap: 6px;
              flex-wrap: wrap;
            }
            button.detected-totp-code {
              font-family: var(--vscode-editor-font-family);
              font-weight: 700;
              letter-spacing: 1px;
            }
            .footer {
              display: flex;
              align-items: center;
              justify-content: space-between;
              gap: 12px;
            }
          </style>
        </head>
        <body>
          <div class="header">
            <div>
              <div class="title">🗒️ Private account note</div>
              <div class="subtitle">${escapeHtml(profileName)}</div>
            </div>
            <button id="saveButton" type="button">Save securely</button>
          </div>
          <div class="totp-panel">
            <div class="totp-row">
              <strong>2FA / TOTP</strong>
              <button id="totpCode" class="secondary" type="button" hidden></button>
              <span id="totpCountdown" class="subtitle">Not configured</span>
              <span id="totpLabel" class="subtitle"></span>
            </div>
            <div class="totp-row">
              <input
                id="totpInput"
                type="password"
                autocomplete="off"
                spellcheck="false"
                aria-label="New TOTP secret or otpauth URI"
                placeholder="Base32 secret or otpauth:// URI"
              >
              <button id="saveTotpButton" class="secondary" type="button">Save 2FA</button>
              <button id="clearTotpButton" class="secondary" type="button" disabled>Remove</button>
            </div>
            <div id="totpStatus">
              The secret is stored separately in VS Code SecretStorage and is never shown again.
            </div>
            <div id="detectedTotpPanel" hidden>
              <strong>2FA detected in note</strong>
              <div id="detectedTotpCodes"></div>
              <div class="subtitle">
                Recognized after 2FA/TOTP/OTP/secret/ключ labels or in an otpauth://totp URI.
              </div>
            </div>
          </div>
          <textarea
            id="note"
            aria-label="Private account note"
            maxlength="${MAX_NOTE_LENGTH_FOR_WEBVIEW}"
            spellcheck="false"
          >${escapeHtml(note)}</textarea>
          <div class="footer">
            <span id="status">Stored with VS Code SecretStorage</span>
            <span class="subtitle">Ctrl/Cmd+S to save</span>
          </div>
          <script nonce="${nonce}">
            const vscode = acquireVsCodeApi();
            const note = document.getElementById('note');
            const saveButton = document.getElementById('saveButton');
            const status = document.getElementById('status');
            const totpCode = document.getElementById('totpCode');
            const totpCountdown = document.getElementById('totpCountdown');
            const totpLabel = document.getElementById('totpLabel');
            const totpInput = document.getElementById('totpInput');
            const totpStatus = document.getElementById('totpStatus');
            const saveTotpButton = document.getElementById('saveTotpButton');
            const clearTotpButton = document.getElementById('clearTotpButton');
            const detectedTotpPanel = document.getElementById('detectedTotpPanel');
            const detectedTotpCodes = document.getElementById('detectedTotpCodes');
            let revision = 0;
            let savedValue = note.value;
            let saveTimer;
            const pendingValues = new Map();
            let totpRevision = 0;
            let totpValidUntil = 0;
            let totpTimer;
            let totpRefreshRequested = false;
            let detectedTotp = [];
            let detectedTotpTimer;
            let detectedTotpRequestTimer;
            let detectedTotpRefreshRequested = false;
            let detectedTotpLatestRequestId = null;

            function updateTotpCountdown() {
              if (!totpValidUntil) {
                return;
              }
              const remaining = Math.max(0, Math.ceil((totpValidUntil - Date.now()) / 1000));
              totpCountdown.textContent = remaining > 0 ? remaining + 's remaining' : 'Refreshing...';
              if (remaining <= 0 && !totpRefreshRequested) {
                totpRefreshRequested = true;
                totpRevision += 1;
                vscode.postMessage({ command: 'requestTotp', requestId: totpRevision });
              }
            }

            function applyTotp(totp) {
              clearInterval(totpTimer);
              totpRefreshRequested = false;
              const configured = Boolean(totp && totp.configured && totp.code);
              totpCode.hidden = !configured;
              clearTotpButton.disabled = !configured;
              if (!configured) {
                totpCode.textContent = '';
                totpCountdown.textContent = 'Not configured';
                totpLabel.textContent = '';
                totpValidUntil = 0;
                return;
              }
              totpCode.textContent = totp.code;
              totpCode.title = 'Copy current 2FA code';
              totpValidUntil = Number(totp.validUntil) || 0;
              const label = [totp.issuer, totp.account].filter(Boolean).join(' — ');
              totpLabel.textContent = label;
              updateTotpCountdown();
              totpTimer = setInterval(updateTotpCountdown, 1000);
            }

            function requestDetectedTotp() {
              clearTimeout(detectedTotpRequestTimer);
              detectedTotpRefreshRequested = true;
              totpRevision += 1;
              detectedTotpLatestRequestId = totpRevision;
              vscode.postMessage({
                command: 'requestDetectedTotp',
                requestId: detectedTotpLatestRequestId,
                value: note.value
              });
            }

            function scheduleDetectedTotp() {
              clearTimeout(detectedTotpRequestTimer);
              detectedTotpRequestTimer = setTimeout(requestDetectedTotp, 300);
            }

            function renderDetectedTotp() {
              detectedTotpCodes.textContent = '';
              detectedTotpPanel.hidden = detectedTotp.length === 0;
              for (const detection of detectedTotp) {
                const remaining = Math.max(
                  0,
                  Math.ceil((Number(detection.validUntil) - Date.now()) / 1000)
                );
                const button = document.createElement('button');
                button.className = 'secondary detected-totp-code';
                button.dataset.detectedTotpId = detection.id;
                button.textContent =
                  'Line ' + (detection.lineIndex + 1) + ': ' +
                  detection.code + ' · ' + remaining + 's';
                button.title = 'Copy detected 2FA code';
                detectedTotpCodes.appendChild(button);
              }
              if (
                detectedTotp.some((item) => Number(item.validUntil) <= Date.now()) &&
                !detectedTotpRefreshRequested
              ) {
                requestDetectedTotp();
              }
            }

            function applyDetectedTotp(detections) {
              clearInterval(detectedTotpTimer);
              detectedTotpRefreshRequested = false;
              detectedTotp = Array.isArray(detections) ? detections : [];
              renderDetectedTotp();
              if (detectedTotp.length) {
                detectedTotpTimer = setInterval(renderDetectedTotp, 1000);
              }
            }

            function save() {
              clearTimeout(saveTimer);
              if (note.value === savedValue) {
                status.textContent = 'Saved securely';
                return;
              }
              revision += 1;
              pendingValues.set(revision, note.value);
              status.textContent = 'Saving securely...';
              vscode.postMessage({
                command: 'save',
                revision,
                value: note.value
              });
            }

            note.addEventListener('input', () => {
              status.textContent = 'Unsaved changes';
              clearTimeout(saveTimer);
              saveTimer = setTimeout(save, 800);
              scheduleDetectedTotp();
            });
            saveButton.addEventListener('click', save);
            saveTotpButton.addEventListener('click', () => {
              const value = totpInput.value.trim();
              if (!value) {
                totpStatus.textContent = 'Enter a Base32 secret or otpauth:// URI first.';
                return;
              }
              totpRevision += 1;
              totpStatus.textContent = 'Saving 2FA securely...';
              vscode.postMessage({
                command: 'saveTotp',
                requestId: totpRevision,
                value
              });
            });
            clearTotpButton.addEventListener('click', () => {
              totpRevision += 1;
              totpStatus.textContent = 'Removing 2FA...';
              vscode.postMessage({ command: 'clearTotp', requestId: totpRevision });
            });
            totpCode.addEventListener('click', () => {
              totpRevision += 1;
              totpStatus.textContent = 'Copying current code...';
              vscode.postMessage({ command: 'copyTotp', requestId: totpRevision });
            });
            detectedTotpCodes.addEventListener('click', (event) => {
              const button = event.target.closest('button[data-detected-totp-id]');
              if (!button) {
                return;
              }
              const detection = detectedTotp.find(
                (item) => item.id === button.dataset.detectedTotpId
              );
              if (!detection) {
                return;
              }
              totpRevision += 1;
              totpStatus.textContent = 'Copying detected 2FA code...';
              vscode.postMessage({
                command: 'copyDetectedTotp',
                requestId: totpRevision,
                value: detection.code
              });
            });
            document.addEventListener('keydown', (event) => {
              if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
                event.preventDefault();
                save();
              }
            });
            window.addEventListener('message', (event) => {
              const message = event.data;
              if (!message) {
                return;
              }
              if (message.command === 'totpUpdated') {
                totpInput.value = '';
                applyTotp(message.totp);
                totpStatus.textContent =
                  message.totp && message.totp.configured
                    ? '2FA is stored securely. The secret is hidden.'
                    : '2FA removed from protected storage.';
                return;
              }
              if (message.command === 'totpCopied') {
                applyTotp(message.totp);
                totpStatus.textContent = 'Current 2FA code copied';
                return;
              }
              if (message.command === 'detectedTotpUpdated') {
                if (message.requestId !== detectedTotpLatestRequestId) {
                  return;
                }
                applyDetectedTotp(message.detections);
                return;
              }
              if (message.command === 'detectedTotpCopied') {
                totpStatus.textContent = 'Detected 2FA code copied';
                return;
              }
              if (message.command === 'totpError') {
                totpStatus.textContent =
                  '2FA action failed: ' + (message.message || 'Unknown error');
                return;
              }
              const pendingValue = pendingValues.get(message.revision);
              pendingValues.delete(message.revision);
              if (message.revision !== revision) {
                return;
              }
              if (message.command === 'saved') {
                savedValue = pendingValue || '';
                if (note.value === savedValue) {
                  status.textContent = 'Saved securely';
                } else {
                  status.textContent = 'Unsaved changes';
                  clearTimeout(saveTimer);
                  saveTimer = setTimeout(save, 800);
                }
              } else if (message.command === 'saveError') {
                status.textContent = 'Save failed: ' + (message.message || 'Unknown error');
              }
            });
            applyTotp(${escapeScriptJson(initialTotp)});
            requestDetectedTotp();
            note.focus();
          </script>
        </body>
      </html>`;
  }
}

const MAX_NOTE_LENGTH_FOR_WEBVIEW = 256 * 1024;

module.exports = {
  ProfileNotePanel
};
