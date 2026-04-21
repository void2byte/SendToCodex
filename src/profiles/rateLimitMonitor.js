'use strict';

const vscode = require('vscode');
const { getUsageApiRateLimitData } = require('./rateLimitApiClient');
const { getRateLimitData } = require('./rateLimitParser');

class RateLimitMonitor {
  constructor(profileManager, logger) {
    this.profileManager = profileManager;
    this.logger = logger;
    this.refreshTimer = undefined;
    this.isWindowFocused = true;
    this.lastError = null;
    this.lastObservation = null;
    this.lastActiveProfileId = null;
    this.sessionFileByProfileId = new Map();
    this.latestRefreshId = 0;
    this.onDidChangeEmitter = new vscode.EventEmitter();
    this.onDidChange = this.onDidChangeEmitter.event;
    this.disposables = [];
  }

  activate() {
    this.disposables.push(
      vscode.window.onDidChangeWindowState((event) => {
        this.setWindowFocused(event.focused);
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (!event.affectsConfiguration('codexRatelimit')) {
          return;
        }

        if (event.affectsConfiguration('codexRatelimit.refreshInterval')) {
          this.startRefreshTimer();
          return;
        }

        void this.refresh(true);
      })
    );

    this.startRefreshTimer();
  }

  dispose() {
    this.stopRefreshTimer();
    for (const disposable of this.disposables.splice(0)) {
      disposable.dispose();
    }
    this.onDidChangeEmitter.dispose();
  }

  getRefreshIntervalMs() {
    const intervalSeconds = Math.max(
      vscode.workspace.getConfiguration('codexRatelimit').get('refreshInterval', 10),
      5
    );
    return intervalSeconds * 1000;
  }

  getSessionPath() {
    return vscode.workspace.getConfiguration('codexRatelimit').get('sessionPath', '');
  }

  shouldUseUsageApi() {
    return vscode.workspace.getConfiguration('codexRatelimit').get('preferUsageApi', true);
  }

  getWorkspaceCwd() {
    const folder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
    return folder ? folder.uri.fsPath : null;
  }

  normalizePlanType(value) {
    const normalized = String(value || '').trim().toLowerCase();
    return normalized && normalized !== 'unknown' ? normalized : null;
  }

  shouldAcceptObservationForProfile(profile, observation) {
    if (!profile || !observation) {
      return false;
    }

    const profilePlanType = this.normalizePlanType(profile.planType);
    const observedPlanType = this.normalizePlanType(observation.planType);
    if (profilePlanType && observedPlanType && profilePlanType !== observedPlanType) {
      return false;
    }

    return true;
  }

  setWindowFocused(focused) {
    this.isWindowFocused = focused;
    if (focused) {
      this.startRefreshTimer();
      return;
    }
    this.stopRefreshTimer();
  }

  startRefreshTimer() {
    this.stopRefreshTimer();

    if (!this.isWindowFocused) {
      return;
    }

    void this.refresh(true);
    this.refreshTimer = setInterval(() => {
      if (this.isWindowFocused) {
        void this.refresh(false);
      }
    }, this.getRefreshIntervalMs());
  }

  stopRefreshTimer() {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = undefined;
    }
  }

  getLastError() {
    return this.lastError;
  }

  getLastObservation() {
    return this.lastObservation;
  }

  async refresh(force) {
    const refreshId = ++this.latestRefreshId;

    try {
      await this.profileManager.clearExpiredCooldowns();
      const activeProfileId = await this.profileManager.getActiveProfileId();
      if (refreshId !== this.latestRefreshId) {
        return;
      }

      if (!activeProfileId) {
        this.lastActiveProfileId = null;
        this.lastError = null;
        this.lastObservation = null;
        this.onDidChangeEmitter.fire();
        return;
      }

      const activeProfile = await this.profileManager.getProfile(activeProfileId);
      if (refreshId !== this.latestRefreshId) {
        return;
      }

      if (!activeProfile) {
        this.lastActiveProfileId = null;
        this.lastError = 'Active profile could not be loaded';
        this.lastObservation = null;
        this.onDidChangeEmitter.fire();
        return;
      }

      if (this.lastActiveProfileId !== activeProfileId) {
        this.lastActiveProfileId = activeProfileId;
        this.lastObservation = null;
        const sourceFile =
          activeProfile.rateLimitState && activeProfile.rateLimitState.sourceFile
            ? activeProfile.rateLimitState.sourceFile
            : null;
        if (sourceFile) {
          this.sessionFileByProfileId.set(activeProfileId, sourceFile);
        }
      }

      let usageApiError = null;
      if (this.shouldUseUsageApi()) {
        const authData = await this.profileManager.loadAuthData(activeProfileId);
        if (refreshId !== this.latestRefreshId) {
          return;
        }

        if (authData) {
          const usageApiResult = await getUsageApiRateLimitData(authData, this.logger);
          if (refreshId !== this.latestRefreshId) {
            return;
          }

          if (
            usageApiResult.found &&
            usageApiResult.data &&
            this.shouldAcceptObservationForProfile(activeProfile, usageApiResult.data)
          ) {
            this.lastError = null;
            this.lastObservation = usageApiResult.data;
            await this.profileManager.recordRateLimitObservation(
              activeProfileId,
              usageApiResult.data
            );
            this.onDidChangeEmitter.fire();
            return;
          }

          usageApiError =
            usageApiResult.error || 'Waiting for usage API data for the active profile';
        }
      }

      const activeSinceMs = await this.profileManager.getActiveProfileActivatedAt();
      const preferredFile =
        this.sessionFileByProfileId.get(activeProfileId) ||
        (activeProfile.rateLimitState && activeProfile.rateLimitState.sourceFile) ||
        null;
      const result = await getRateLimitData(this.getSessionPath(), this.logger, {
        preferredFile,
        activeSinceMs,
        workspaceCwd: this.getWorkspaceCwd(),
        expectedPlanType: activeProfile.planType
      });
      if (refreshId !== this.latestRefreshId) {
        return;
      }

      if (!result.found || !result.data) {
        this.lastError = usageApiError || result.error || 'No rate limit data found';
        this.lastObservation = null;
        this.onDidChangeEmitter.fire();
        return;
      }

      if (
        activeSinceMs &&
        result.data.recordTimestampMs &&
        result.data.recordTimestampMs + 2000 < activeSinceMs
      ) {
        this.lastError = 'Waiting for session data for the active profile';
        this.lastObservation = result.data;
        this.onDidChangeEmitter.fire();
        return;
      }

      if (!this.shouldAcceptObservationForProfile(activeProfile, result.data)) {
        this.lastError = 'Waiting for rate-limit data for the active profile';
        this.lastObservation = null;
        this.onDidChangeEmitter.fire();
        return;
      }

      if (refreshId !== this.latestRefreshId) {
        return;
      }

      this.lastError = null;
      this.lastObservation = result.data;
      this.sessionFileByProfileId.set(activeProfileId, result.data.filePath);
      await this.profileManager.recordRateLimitObservation(activeProfileId, result.data);
      this.onDidChangeEmitter.fire();
    } catch (error) {
      this.lastError = error && error.message ? error.message : String(error);
      this.onDidChangeEmitter.fire();
      if (this.logger) {
        this.logger.error('Failed to refresh Codex rate-limit data.', {
          error: this.lastError,
          force: Boolean(force)
        });
      }
    }
  }
}

module.exports = {
  RateLimitMonitor
};
