'use strict';

const vscode = require('vscode');
const { areProfileFeaturesEnabled } = require('./featureFlags');
const { getCodexAppServerRateLimitData } = require('./codexAppServerRateLimitClient');
const {
  getUsageApiRateLimitData,
  isAccessTokenExpiringSoon
} = require('./rateLimitApiClient');
const { getRateLimitData } = require('./rateLimitParser');
const {
  getProfileRateStatus,
  getWindowRemainingPercent,
  isProfileWeeklyTokensLow,
  sortProfilesForDisplay
} = require('./profileStatus');
const { getProfileQuickPickSettings } = require('./quickPickSettings');
const { displayProfileName } = require('./privacy');
const { showUnexpectedRateLimitResetDecision } = require('./paidLimitResetPrompt');

const LOW_USAGE_SWITCH_PROMPT_STATE_KEY = 'codexSwitch.lowUsageSwitchPrompt';
const LOW_USAGE_SWITCH_PROMPT_COOLDOWN_MS = 6 * 60 * 60 * 1000;
class RateLimitMonitor {
  constructor(profileManager, logger) {
    this.profileManager = profileManager;
    this.logger = logger;
    this.refreshTimer = undefined;
    this.isWindowFocused = true;
    this.lastError = null;
    this.lastObservation = null;
    this.lastRefreshResult = null;
    this.lastActiveProfileId = null;
    this.lastLowUsagePromptKey = null;
    this.lastLowUsagePromptAt = 0;
    this.lowUsagePromptInFlight = false;
    this.unexpectedResetPromptInFlight = false;
    this.sessionFileByProfileId = new Map();
    this.latestRefreshId = 0;
    this.refreshInFlight = null;
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
        if (
          !event.affectsConfiguration('codexRatelimit') &&
          !event.affectsConfiguration('codexSwitch.enabled') &&
          !event.affectsConfiguration('codexSwitch.lowUsageProfileSwitchBehavior') &&
          !event.affectsConfiguration('codexSwitch.lowUsageSwitchThreshold') &&
          !event.affectsConfiguration('codexSwitch.lowUsageSwitchFreshnessMinutes')
        ) {
          return;
        }

        if (event.affectsConfiguration('codexSwitch.enabled')) {
          if (areProfileFeaturesEnabled()) {
            this.startRefreshTimer();
            void this.refresh(true);
          } else {
            this.stopRefreshTimer();
            this.lastError = null;
            this.lastObservation = null;
            this.lastRefreshResult = {
              timestamp: Date.now(),
              source: 'profileFeatures',
              outcome: 'disabled'
            };
            this.lastActiveProfileId = null;
            this.onDidChangeEmitter.fire();
          }
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

  shouldRefreshAuthBeforeUsageApi(authData) {
    return isAccessTokenExpiringSoon(authData);
  }

  shouldTryAppServerAfterUsageApiFailure(usageApiResult) {
    if (!usageApiResult || usageApiResult.found) {
      return false;
    }

    if (usageApiResult.status === 401 || usageApiResult.status === 403) {
      return true;
    }

    const errorText = String(usageApiResult.error || '').toLowerCase();
    return errorText.includes('access token') || errorText.includes('rate-limit windows');
  }

  getWorkspaceCwd() {
    const folder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
    return folder ? folder.uri.fsPath : null;
  }

  normalizePlanType(value) {
    const normalized = String(value || '').trim().toLowerCase();
    return normalized && normalized !== 'unknown' ? normalized : null;
  }

  shouldAcceptObservationForProfile(profile, observation, options = {}) {
    if (!profile || !observation) {
      return false;
    }

    const profilePlanType = this.normalizePlanType(profile.planType);
    const observedPlanType = this.normalizePlanType(observation.planType);
    if (
      !options.acceptPlanChange &&
      profilePlanType &&
      observedPlanType &&
      profilePlanType !== observedPlanType
    ) {
      return false;
    }

    return true;
  }

  logObservedPlanChange(profile, observation, source) {
    const profilePlanType = this.normalizePlanType(profile && profile.planType);
    const observedPlanType = this.normalizePlanType(observation && observation.planType);
    if (!profilePlanType || !observedPlanType || profilePlanType === observedPlanType) {
      return;
    }

    if (this.logger) {
      this.logger.info('Updating Codex profile plan type from rate-limit observation.', {
        profileId: profile.id,
        previousPlanType: profile.planType,
        observedPlanType: observation.planType,
        source
      });
    }
  }

  async syncRefreshedAuthData(profileId, profile, refreshedAuthData) {
    if (!refreshedAuthData) {
      return false;
    }

    if (
      this.profileManager.matchesAuth &&
      profile &&
      !this.profileManager.matchesAuth(profile, refreshedAuthData)
    ) {
      const message =
        'Codex app-server returned refreshed auth for a different account; stored profile tokens were not updated.';
      if (this.logger) {
        this.logger.error(message, {
          profileId,
          profileEmail: profile.email,
          refreshedEmail: refreshedAuthData.email
        });
      }
      this.lastError = message;
      return false;
    }

    if (this.profileManager.syncStoredProfileAuth) {
      return this.profileManager.syncStoredProfileAuth(profileId, refreshedAuthData);
    }

    return false;
  }

  async recordFreshRateLimitObservation(profileId, profile, observation, source, force) {
    if (
      !observation ||
      !this.shouldAcceptObservationForProfile(profile, observation, {
        acceptPlanChange: true
      })
    ) {
      return false;
    }

    this.logObservedPlanChange(profile, observation, source);
    this.lastError = null;
    this.lastObservation = observation;
    const persistenceResult = this.profileManager.recordRateLimitObservationWithResult
      ? await this.profileManager.recordRateLimitObservationWithResult(profileId, observation)
      : {
          changed: await this.profileManager.recordRateLimitObservation(profileId, observation),
          unexpectedResetWindows: [],
          observedAt: observation.recordTimestampMs
        };
    this.setRefreshResult({
      source,
      outcome: 'fresh',
      profileId,
      sourceFile: observation.filePath || source,
      force: Boolean(force)
    });
    this.onDidChangeEmitter.fire();
    if (
      persistenceResult &&
      Array.isArray(persistenceResult.unexpectedResetWindows) &&
      persistenceResult.unexpectedResetWindows.length > 0
    ) {
      void this.maybeOfferPaidProfileLimitReset(profile, persistenceResult);
    }
    void this.maybeSuggestLowUsageSwitch(profileId);
    return true;
  }

  async maybeOfferPaidProfileLimitReset(profile, resetResult) {
    if (
      this.unexpectedResetPromptInFlight ||
      !this.profileManager ||
      typeof this.profileManager.resetPaidProfileRateLimits !== 'function'
    ) {
      return false;
    }

    this.unexpectedResetPromptInFlight = true;
    try {
      const profileName = displayProfileName(profile);
      const decision = await showUnexpectedRateLimitResetDecision({
        message: `Codex limits reset early for ${profileName}. Was this a shared reset?`,
        detail:
          'Choose “Shared reset” only if OpenAI reset all paid accounts. Choose “Only this account” to keep every other stored counter unchanged; this account already has fresh server data.'
      });
      if (decision !== 'shared') {
        if (this.logger) {
          this.logger.info('Kept other paid-account counters after an early limit reset.', {
            profileId: profile && profile.id,
            decision
          });
        }
        return false;
      }

      const resetProfileCount = await this.profileManager.resetPaidProfileRateLimits(
        resetResult && resetResult.observedAt
      );
      if (this.logger) {
        this.logger.info('Accepted the out-of-schedule paid-account limit reset prompt.', {
          profileId: profile && profile.id,
          profileCount: resetProfileCount
        });
      }
      return true;
    } catch (error) {
      if (this.logger) {
        this.logger.warn('Failed to handle an out-of-schedule rate-limit reset prompt.', {
          profileId: profile && profile.id,
          error: error && error.message ? error.message : String(error)
        });
      }
      return false;
    } finally {
      this.unexpectedResetPromptInFlight = false;
    }
  }

  async getCodexAppServerRateLimitForProfile(profileId, profile, authData, force) {
    const result = await getCodexAppServerRateLimitData(authData, this.logger);
    if (result && result.refreshedAuthData) {
      await this.syncRefreshedAuthData(profileId, profile, result.refreshedAuthData);
    }

    if (
      result &&
      result.found &&
      result.data &&
      (await this.recordFreshRateLimitObservation(
        profileId,
        profile,
        result.data,
        'codexAppServer',
        force
      ))
    ) {
      return {
        found: true,
        data: result.data
      };
    }

    return {
      found: false,
      error:
        result && result.found && result.data
          ? 'Codex app-server data did not match the active profile plan'
          : (result && result.error) || 'Codex app-server did not return rate-limit data'
    };
  }

  setWindowFocused(focused) {
    this.isWindowFocused = focused;
    this.startRefreshTimer();
  }

  startRefreshTimer() {
    this.stopRefreshTimer();

    if (!areProfileFeaturesEnabled()) {
      return;
    }

    void this.refresh(true);
    this.refreshTimer = setInterval(() => {
      void this.refresh(false);
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

  getLastRefreshResult() {
    return this.lastRefreshResult;
  }

  setRefreshResult(result) {
    this.lastRefreshResult = {
      timestamp: Date.now(),
      ...result
    };
  }

  getLowUsageSwitchBehavior() {
    const behavior = vscode.workspace
      .getConfiguration('codexSwitch')
      .get('lowUsageProfileSwitchBehavior', 'ask');
    return behavior === 'auto' || behavior === 'off' ? behavior : 'ask';
  }

  getLowUsageSwitchThreshold() {
    const threshold = Number(
      vscode.workspace.getConfiguration('codexSwitch').get('lowUsageSwitchThreshold', 5)
    );
    if (!Number.isFinite(threshold)) {
      return 5;
    }
    return Math.max(0, Math.min(100, Math.round(threshold)));
  }

  getLowUsageSwitchFreshnessMs() {
    const minutes = Number(
      vscode.workspace
        .getConfiguration('codexSwitch')
        .get('lowUsageSwitchFreshnessMinutes', 60)
    );
    const normalizedMinutes = Number.isFinite(minutes) ? Math.max(1, minutes) : 60;
    return normalizedMinutes * 60 * 1000;
  }

  getKnownRemainingPercents(profile, now, activeProfileId) {
    const status = getProfileRateStatus(profile, now, { activeProfileId });
    return [status.primary, status.secondary]
      .map((windowState) => getWindowRemainingPercent(windowState, now))
      .filter((value) => value >= 0);
  }

  getKnownPrimaryRemainingPercents(profile, now, activeProfileId) {
    const status = getProfileRateStatus(profile, now, { activeProfileId });
    if (!status.observedAt || !profile || !profile.rateLimitState) {
      return [];
    }

    const primaryRemaining = getWindowRemainingPercent(profile.rateLimitState.primary, now);
    return primaryRemaining >= 0 ? [primaryRemaining] : [];
  }

  isProfileLowOnUsage(profile, now, threshold, activeProfileId) {
    const remainingPercents = this.getKnownPrimaryRemainingPercents(
      profile,
      now,
      activeProfileId
    );
    return remainingPercents.some((value) => value <= threshold);
  }

  getLowUsagePromptStateBucket() {
    return this.profileManager && this.profileManager.context
      ? this.profileManager.context.globalState
      : null;
  }

  getLowUsagePromptState() {
    const bucket = this.getLowUsagePromptStateBucket();
    const state = bucket && typeof bucket.get === 'function'
      ? bucket.get(LOW_USAGE_SWITCH_PROMPT_STATE_KEY)
      : null;
    return state && typeof state === 'object' ? state : {};
  }

  async updateLowUsagePromptState(patch) {
    const bucket = this.getLowUsagePromptStateBucket();
    if (!bucket || typeof bucket.update !== 'function') {
      return;
    }

    await bucket.update(LOW_USAGE_SWITCH_PROMPT_STATE_KEY, {
      ...this.getLowUsagePromptState(),
      ...patch
    });
  }

  shouldSuppressLowUsagePrompt(promptKey, now) {
    if (this.lowUsagePromptInFlight) {
      return true;
    }

    if (
      this.lastLowUsagePromptKey === promptKey &&
      now - this.lastLowUsagePromptAt >= 0 &&
      now - this.lastLowUsagePromptAt < LOW_USAGE_SWITCH_PROMPT_COOLDOWN_MS
    ) {
      return true;
    }

    const state = this.getLowUsagePromptState();
    const lastPromptAt = Number(state.lastPromptAt);
    return state.lastPromptKey === promptKey &&
      Number.isFinite(lastPromptAt) &&
      now - lastPromptAt >= 0 &&
      now - lastPromptAt < LOW_USAGE_SWITCH_PROMPT_COOLDOWN_MS;
  }

  getLowUsagePromptKey(activeProfile, threshold, behavior) {
    const primaryWindow =
      activeProfile &&
      activeProfile.rateLimitState &&
      activeProfile.rateLimitState.primary;
    const primaryResetAt = Number(primaryWindow && primaryWindow.resetAt);
    const unexpectedResetCount = Math.max(
      0,
      Math.round(Number(primaryWindow && primaryWindow.unexpectedResetCount) || 0)
    );
    const windowCycle = Number.isFinite(primaryResetAt) && primaryResetAt > 0
      ? Math.round(primaryResetAt)
      : 'unknown';

    return `${behavior}:${activeProfile.id}:${threshold}:${windowCycle}:${unexpectedResetCount}`;
  }

  async disableLowUsageSwitchPrompts() {
    await vscode.workspace
      .getConfiguration('codexSwitch')
      .update(
        'lowUsageProfileSwitchBehavior',
        'off',
        vscode.ConfigurationTarget.Global
      );
    await this.updateLowUsagePromptState({
      disabledAt: Date.now()
    });
    if (this.logger) {
      this.logger.info('Disabled Codex low-usage switch prompts from the prompt checkbox.');
    }
  }

  async showLowUsageSwitchPrompt(activeProfile, candidate, threshold) {
    const switchItem = {
      id: 'switch',
      label: `$(arrow-swap) Switch to ${displayProfileName(candidate)}`,
      description: 'Use this account now',
      alwaysShow: true
    };
    const disableItem = {
      id: 'disable',
      label: "$(bell-slash) Don't show again",
      description: 'Disable low-usage switch prompts',
      alwaysShow: true
    };

    const selections = await vscode.window.showQuickPick(
      [switchItem, disableItem],
      {
        canPickMany: true,
        ignoreFocusOut: true,
        title: 'Codex profile is low on primary-window usage',
        placeHolder:
          `Profile "${displayProfileName(activeProfile)}" is at or below ${threshold}% primary-window remaining. Select one or both actions.`
      }
    );

    const selectedItems = Array.isArray(selections) ? selections : [];
    return {
      switchProfile: selectedItems.some((item) => item && item.id === 'switch'),
      disablePrompts: selectedItems.some((item) => item && item.id === 'disable')
    };
  }

  isUsableSwitchCandidate(profile, now, threshold, freshnessMs, activeProfileId, options = {}) {
    if (!profile || !profile.rateLimitState || !profile.rateLimitState.observedAt) {
      return false;
    }

    if (now - Number(profile.rateLimitState.observedAt) > freshnessMs) {
      return false;
    }

    if (isProfileWeeklyTokensLow(profile, now, { ...options, activeProfileId })) {
      return false;
    }

    const remainingPercents = this.getKnownRemainingPercents(profile, now, activeProfileId);
    return remainingPercents.length > 0 && remainingPercents.every((value) => value > threshold);
  }

  async maybeSuggestLowUsageSwitch(activeProfileId) {
    const behavior = this.getLowUsageSwitchBehavior();
    if (behavior === 'off' || !activeProfileId) {
      return;
    }

    try {
      const now = Date.now();
      const threshold = this.getLowUsageSwitchThreshold();
      const freshnessMs = this.getLowUsageSwitchFreshnessMs();
      const quickPickSettings = getProfileQuickPickSettings();
      const lowWeeklyOptions = {
        lowRemainingPercentThreshold: quickPickSettings.lowWeeklyRemainingZeroThreshold
      };
      const profiles = await this.profileManager.listProfiles();
      const activeProfile = profiles.find((profile) => profile.id === activeProfileId);
      if (
        !activeProfile ||
        !this.isProfileLowOnUsage(activeProfile, now, threshold, activeProfileId)
      ) {
        return;
      }

      const candidates = sortProfilesForDisplay(
        profiles.filter((profile) => {
          return profile.id !== activeProfileId &&
            this.isUsableSwitchCandidate(
              profile,
              now,
              threshold,
              freshnessMs,
              activeProfileId,
              lowWeeklyOptions
            );
        }),
        undefined,
        now,
        { ...lowWeeklyOptions, activeProfileId }
      );
      const candidate = candidates[0];
      if (!candidate) {
        return;
      }

      const promptKey = this.getLowUsagePromptKey(activeProfile, threshold, behavior);
      if (this.shouldSuppressLowUsagePrompt(promptKey, now)) {
        return;
      }
      this.lastLowUsagePromptKey = promptKey;
      this.lastLowUsagePromptAt = now;
      await this.updateLowUsagePromptState({
        lastPromptKey: promptKey,
        lastPromptAt: now
      });

      if (behavior === 'auto') {
        void vscode.window.showInformationMessage(
          `Codex profile "${displayProfileName(activeProfile)}" is low on usage. Switching to "${displayProfileName(candidate)}".`
        );
        await vscode.commands.executeCommand('codex-switch.profile.activate', candidate.id);
        return;
      }

      this.lowUsagePromptInFlight = true;
      let selection;
      try {
        selection = await this.showLowUsageSwitchPrompt(activeProfile, candidate, threshold);
      } finally {
        this.lowUsagePromptInFlight = false;
      }
      if (selection.disablePrompts) {
        await this.disableLowUsageSwitchPrompts();
      }
      if (selection.switchProfile) {
        await vscode.commands.executeCommand('codex-switch.profile.activate', candidate.id);
      }
    } catch (error) {
      if (this.logger) {
        this.logger.warn('Failed to suggest a Codex profile switch for low usage.', {
          activeProfileId,
          error: error && error.message ? error.message : String(error)
        });
      }
    }
  }

  async refresh(force) {
    if (this.refreshInFlight) {
      if (this.logger) {
        this.logger.debug('Coalesced Codex rate-limit refresh while another refresh is running.', {
          force: Boolean(force)
        });
      }
      return this.refreshInFlight;
    }

    this.refreshInFlight = this.runRefresh(force);
    try {
      return await this.refreshInFlight;
    } finally {
      this.refreshInFlight = null;
    }
  }

  async runRefresh(force) {
    const refreshId = ++this.latestRefreshId;
    let coordinatedProfileId = null;
    let refreshClaim = null;
    let refreshSucceeded = false;

    try {
      if (!areProfileFeaturesEnabled()) {
        this.lastActiveProfileId = null;
        this.lastError = null;
        this.lastObservation = null;
        this.setRefreshResult({
          source: 'profileFeatures',
          outcome: 'disabled',
          force: Boolean(force)
        });
        this.onDidChangeEmitter.fire();
        return;
      }

      await this.profileManager.clearExpiredCooldowns();
      const activeProfileId = await this.profileManager.getActiveProfileId();
      if (refreshId !== this.latestRefreshId) {
        return;
      }

      if (!activeProfileId) {
        this.lastActiveProfileId = null;
        this.lastError = null;
        this.lastObservation = null;
        this.setRefreshResult({
          source: 'profileStore',
          outcome: 'no-active-profile',
          force: Boolean(force)
        });
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
        this.setRefreshResult({
          source: 'profileStore',
          outcome: 'error',
          profileId: activeProfileId,
          error: this.lastError,
          force: Boolean(force)
        });
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

      if (this.profileManager.claimRateLimitRefresh) {
        refreshClaim = this.profileManager.claimRateLimitRefresh(activeProfileId, {
          minimumFreshMs: this.getRefreshIntervalMs(),
          failureBackoffMs: Math.max(15 * 1000, this.getRefreshIntervalMs())
        });
        if (!refreshClaim.acquired) {
          this.lastError = null;
          this.setRefreshResult({
            source: 'sharedRefreshCoordinator',
            outcome: refreshClaim.reason,
            profileId: activeProfileId,
            force: Boolean(force)
          });
          this.onDidChangeEmitter.fire();
          return;
        }
        coordinatedProfileId = activeProfileId;
      }

      let usageApiError = null;
      if (this.shouldUseUsageApi()) {
        let authData = await this.profileManager.loadAuthData(activeProfileId);
        if (refreshId !== this.latestRefreshId) {
          return;
        }

        if (!authData) {
          usageApiError = 'No stored Codex auth tokens for the active profile';
        } else {
          let triedAppServer = false;
          if (this.shouldRefreshAuthBeforeUsageApi(authData)) {
            triedAppServer = true;
            const appServerResult = await this.getCodexAppServerRateLimitForProfile(
              activeProfileId,
              activeProfile,
              authData,
              force
            );
            if (refreshId !== this.latestRefreshId) {
              return;
            }

            if (appServerResult.found) {
              refreshSucceeded = true;
              return;
            }

            usageApiError = appServerResult.error;
            authData = (await this.profileManager.loadAuthData(activeProfileId)) || authData;
          }

          const usageApiResult = await getUsageApiRateLimitData(authData, this.logger);
          if (refreshId !== this.latestRefreshId) {
            return;
          }

          if (
            usageApiResult.found &&
            usageApiResult.data &&
            (await this.recordFreshRateLimitObservation(
              activeProfileId,
              activeProfile,
              usageApiResult.data,
              'usageApi',
              force
            ))
          ) {
            refreshSucceeded = true;
            return;
          }

          if (!triedAppServer && this.shouldTryAppServerAfterUsageApiFailure(usageApiResult)) {
            const appServerResult = await this.getCodexAppServerRateLimitForProfile(
              activeProfileId,
              activeProfile,
              authData,
              force
            );
            if (refreshId !== this.latestRefreshId) {
              return;
            }

            if (appServerResult.found) {
              refreshSucceeded = true;
              return;
            }

            usageApiError = [
              usageApiResult && usageApiResult.error,
              `Codex app-server fallback failed: ${appServerResult.error}`
            ]
              .filter(Boolean)
              .join('; ');
          }

          usageApiError =
            usageApiError ||
            (usageApiResult && usageApiResult.found && usageApiResult.data
              ? 'Usage API data did not match the active profile plan'
              : (usageApiResult && usageApiResult.error) ||
                'Codex Usage API did not return rate-limit data');
        }
      } else {
        usageApiError =
          'Codex Usage API is disabled; exact active-profile limit display is unavailable';
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
        this.setRefreshResult({
          source: 'localSessions',
          outcome: 'error',
          profileId: activeProfileId,
          error: this.lastError,
          usageApiError,
          force: Boolean(force)
        });
        this.onDidChangeEmitter.fire();
        return;
      }

      if (
        activeSinceMs &&
        result.data.recordTimestampMs &&
        result.data.recordTimestampMs + 2000 < activeSinceMs
      ) {
        this.lastError = usageApiError || 'Waiting for session data for the active profile';
        this.lastObservation = result.data;
        this.setRefreshResult({
          source: 'localSessions',
          outcome: 'stale',
          profileId: activeProfileId,
          sourceFile: result.data.filePath,
          error: this.lastError,
          usageApiError,
          force: Boolean(force)
        });
        this.onDidChangeEmitter.fire();
        return;
      }

      if (!this.shouldAcceptObservationForProfile(activeProfile, result.data)) {
        this.lastError = usageApiError || 'Waiting for rate-limit data for the active profile';
        this.lastObservation = null;
        this.setRefreshResult({
          source: 'localSessions',
          outcome: 'profile-mismatch',
          profileId: activeProfileId,
          sourceFile: result.data.filePath,
          error: this.lastError,
          usageApiError,
          force: Boolean(force)
        });
        this.onDidChangeEmitter.fire();
        return;
      }

      this.lastError = usageApiError;
      this.lastObservation = result.data;
      this.sessionFileByProfileId.set(activeProfileId, result.data.filePath);
      if (this.profileManager.recordRateLimitObservationWithResult) {
        await this.profileManager.recordRateLimitObservationWithResult(
          activeProfileId,
          result.data
        );
      } else {
        await this.profileManager.recordRateLimitObservation(activeProfileId, result.data);
      }
      refreshSucceeded = true;
      this.setRefreshResult({
        source: 'localSessions',
        outcome: 'estimate',
        profileId: activeProfileId,
        sourceFile: result.data.filePath,
        usageApiError,
        force: Boolean(force)
      });
      this.onDidChangeEmitter.fire();
    } catch (error) {
      this.lastError = error && error.message ? error.message : String(error);
      this.setRefreshResult({
        source: 'monitor',
        outcome: 'error',
        error: this.lastError,
        force: Boolean(force)
      });
      this.onDidChangeEmitter.fire();
      if (this.logger) {
        this.logger.error('Failed to refresh Codex rate-limit data.', {
          error: this.lastError,
          force: Boolean(force)
        });
      }
    } finally {
      if (coordinatedProfileId && refreshClaim) {
        try {
          this.profileManager.completeRateLimitRefresh(
            coordinatedProfileId,
            refreshClaim,
            refreshSucceeded
          );
        } catch (error) {
          if (this.logger) {
            this.logger.warn('Failed to complete the shared rate-limit refresh lease.', {
              profileId: coordinatedProfileId,
              error: error && error.message ? error.message : String(error)
            });
          }
        }
      }
    }
  }
}

module.exports = {
  RateLimitMonitor
};
