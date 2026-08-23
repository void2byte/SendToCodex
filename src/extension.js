'use strict';
const vscode = require('vscode');
const {
  CONFIG_SECTION,
  DIAGNOSTICS_LOG_FILE_ENABLED_DEFAULT,
  DIAGNOSTICS_LOGGING_ENABLED_DEFAULT,
  isSendToCodexEnabled,
  OUTPUT_CHANNEL_NAME,
  SEND_TO_CODEX_ENABLED_SETTING
} = require('./config');
const { FileLogger } = require('./logging/FileLogger');
const { ActiveTerminalSelectionResolver } = require('./terminalSelection/ActiveTerminalSelectionResolver');
const { SelectionLocator } = require('./terminalSelection/SelectionLocator');
const { TerminalLogManager } = require('./terminalLogs/TerminalLogManager');
const { CodexAvailabilityController } = require('./codex/CodexAvailabilityController');
const { CodexCommandClient } = require('./codex/CodexCommandClient');
const { getOfficialCodexLogPath } = require('./codex/CodexSidebarConversation');
const {
  DEFAULT_PENDING_WARMUP_MAX_AGE_MS,
  DEFAULT_POST_SWITCH_WARMUP_DELAY_MS,
  DEFAULT_POST_SWITCH_RESTORE_STRATEGY,
  captureCurrentCodexChatContext,
  isPendingCodexPostSwitchWarmupFresh,
  isRestorableCodexChatContext,
  normalizePostSwitchRestoreStrategy,
  warmUpCodexAfterProfileSwitch
} = require('./codex/CodexPostSwitchWarmup');
const { EditorSelectionCodexSender } = require('./codex/EditorSelectionCodexSender');
const { ExplorerResourcesCodexSender } = require('./codex/ExplorerResourcesCodexSender');
const { TerminalSelectionCodexSender } = require('./codex/TerminalSelectionCodexSender');
const { createSelectionPopupPresenter } = require('./native/presenter');
const { registerProfileCommands } = require('./profiles/commands');
const { areProfileFeaturesEnabled } = require('./profiles/featureFlags');
const { decideObservedAuthChange } = require('./profiles/authChangePolicy');
const { ProfileManager } = require('./profiles/profileManager');
const { RateLimitMonitor } = require('./profiles/rateLimitMonitor');
const {
  getActiveRateLimitActivationJob,
  tryStartRateLimitActivationWindowWorker
} = require('./profiles/rateLimitActivationWindow');
const { displayAccountLabel } = require('./profiles/privacy');
const { NativeSelectionOverlayController } = require('./ui/NativeSelectionOverlayController');
const { EditorSelectionStatusBarController } = require('./ui/EditorSelectionStatusBarController');
const { ProfileStatusBarController } = require('./profiles/statusBar');
const { SelectionPopupSuppression } = require('./ui/SelectionPopupSuppression');
const { installNotificationPolicy } = require('./ui/notificationPolicy');
const { TerminalSelectionStatusBarController } = require('./ui/TerminalSelectionStatusBarController');

const CODEX_POST_SWITCH_WARMUP_KEY = 'codexSwitch.pendingCodexPostSwitchWarmup';
const CODEX_POST_SWITCH_AUTH_SYNC_KEY = 'codexSwitch.pendingPostSwitchAuthSync';
const UNMANAGED_AUTH_NOTICE_KEY = 'codexSwitch.dismissedUnmanagedAuthNoticeKey';
const AUTH_WATCHER_SETTLE_TIMEOUT_MS = 15 * 1000;
const ACTIVE_WINDOW_USAGE_HEARTBEAT_MS = 30 * 1000;

function activate(context) {
  const output = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);
  context.subscriptions.push(output);

  const logger = new FileLogger(context.logUri.fsPath, output);
  const codexLogPath = getOfficialCodexLogPath(context.logUri.fsPath);
  logger.reloadConfiguration();
  installNotificationPolicy(logger);
  logger.info('Send to Codex extension activated.', {
    vscodeVersion: vscode.version,
    extensionVersion: context.extension && context.extension.packageJSON
      ? context.extension.packageJSON.version
      : null,
    logFilePath: logger.logFilePath
  });
  logger.debug('Codex restore debug build active.', {
    vscodeVersion: vscode.version,
    extensionVersion: context.extension && context.extension.packageJSON
      ? context.extension.packageJSON.version
      : null,
    outputChannelName: OUTPUT_CHANNEL_NAME
  });

  const profileManager = new ProfileManager(context, logger);
  const rateLimitMonitor = new RateLimitMonitor(profileManager, logger);
  context.subscriptions.push(profileManager);
  context.subscriptions.push(rateLimitMonitor);
  void profileManager.initializePortableProfileVault().catch((error) => {
    logger.warn('Failed to initialize the portable Codex profile vault.', {
      error: error && error.message ? error.message : String(error)
    });
  });
  if (
    tryStartRateLimitActivationWindowWorker(
      context,
      profileManager,
      rateLimitMonitor,
      logger,
      { codexLogPath }
    )
  ) {
    logger.info('Started the dedicated Codex counter-activation window worker.');
    return;
  }

  const getActiveCounterActivationOwner = () =>
    getActiveRateLimitActivationJob(profileManager.getStorageDir());

  const warmUpCodexOutsideCounterActivation = async (reason, options = {}) => {
    const activeActivation = getActiveCounterActivationOwner();
    if (activeActivation) {
      logger.info(
        'Suppressed Codex chat restore in this window because counter activation owns the Codex UI.',
        {
          reason,
          activationJobId: activeActivation.jobId,
          workerWorkspacePath: activeActivation.workerWorkspacePath
        }
      );
      return { skipped: true, reason: 'counter-activation-window-owner' };
    }
    return warmUpCodexAfterProfileSwitch(reason, logger, options);
  };

  const manager = new TerminalLogManager(context, output, logger);
  context.subscriptions.push(manager);
  const profileStatusBarController = new ProfileStatusBarController();
  context.subscriptions.push(profileStatusBarController);
  const popupSuppression = new SelectionPopupSuppression(logger);
  const selectionResolver = new ActiveTerminalSelectionResolver(manager);
  const selectionLocator = new SelectionLocator(selectionResolver, output, popupSuppression);
  const codexCommandClient = new CodexCommandClient(logger);
  const codexAvailabilityController = new CodexAvailabilityController(
    codexCommandClient,
    logger
  );
  const editorSender = new EditorSelectionCodexSender(codexCommandClient, output, logger);
  const explorerResourcesSender = new ExplorerResourcesCodexSender(
    codexCommandClient,
    output,
    logger
  );
  const codexSender = new TerminalSelectionCodexSender(
    selectionResolver,
    codexCommandClient,
    output,
    logger,
    popupSuppression
  );
  const nativeSelectionOverlayController = new NativeSelectionOverlayController(
    createSelectionPopupPresenter(logger),
    popupSuppression,
    logger,
    codexAvailabilityController
  );
  const editorStatusBarController = new EditorSelectionStatusBarController(
    codexAvailabilityController,
    logger
  );
  const statusBarController = new TerminalSelectionStatusBarController(
    codexAvailabilityController,
    logger
  );
  context.subscriptions.push(codexAvailabilityController);
  context.subscriptions.push(nativeSelectionOverlayController);
  context.subscriptions.push(editorStatusBarController);
  context.subscriptions.push(statusBarController);

  let latestProfileUiRefreshId = 0;
  let latestAuthWatcherRefreshId = 0;
  let lastUnmanagedAuthNoticeKey;
  let unmanagedAuthNoticeInFlight = false;
  let expectedWindowAuthChange;

  const updateActiveWindowProfileUsage = async (activeProfileId) => {
    try {
      if (!areProfileFeaturesEnabled() || !activeProfileId) {
        profileManager.clearActiveWindowProfileUsage();
        return;
      }

      profileManager.recordActiveWindowProfileUsage(activeProfileId);
    } catch (error) {
      logger.warn('Failed to update Codex active-window profile usage.', {
        error: error && error.message ? error.message : String(error),
        activeProfileId: activeProfileId || null
      });
    }
  };

  const refreshActiveWindowProfileUsage = async () => {
    const activeProfileId = await profileManager.getActiveProfileId();
    await updateActiveWindowProfileUsage(activeProfileId);
  };

  const getExpectedWindowAuthChange = () => {
    if (!expectedWindowAuthChange) {
      return undefined;
    }

    if (expectedWindowAuthChange.expiresAt <= Date.now()) {
      logger.warn('Expired expected Codex auth.json change marker.', {
        expectedProfileId: expectedWindowAuthChange.profileId || null,
        requestedAt: expectedWindowAuthChange.requestedAt
      });
      expectedWindowAuthChange = undefined;
      return undefined;
    }

    return expectedWindowAuthChange;
  };

  const markWindowAuthChangeExpected = (options = {}) => {
    const profileId =
      options && typeof options.profileId === 'string' && options.profileId.trim()
        ? options.profileId.trim()
        : undefined;
    const requestedAt = Date.now();
    expectedWindowAuthChange = {
      profileId,
      requestedAt,
      expiresAt: requestedAt + 10 * 60 * 1000
    };
    logger.info('Expecting a Codex auth.json change for this VS Code window.', {
      expectedProfileId: profileId || null,
      expiresAt: expectedWindowAuthChange.expiresAt
    });
  };

  const clearExpectedWindowAuthChange = () => {
    expectedWindowAuthChange = undefined;
  };

  const shouldAcceptAuthChangeForThisWindow = async (authData) => {
    const expected = getExpectedWindowAuthChange();
    const matchedProfile = expected && expected.profileId && authData
      ? await profileManager.findProfileMatchingAuthData(authData)
      : undefined;
    const decision = decideObservedAuthChange({
      windowFocused: !(vscode.window.state && vscode.window.state.focused === false),
      expectedChange: expected,
      actualProfileId: matchedProfile ? matchedProfile.id : undefined
    });

    if (decision.accept) {
      logger.info('Accepting observed Codex auth.json account change for this window.', {
        reason: decision.reason,
        expectedProfileId: expected && expected.profileId ? expected.profileId : null,
        actualProfileId: matchedProfile ? matchedProfile.id : null
      });
      return true;
    }

    logger.info('Ignoring observed Codex auth.json account change in a background window.', {
      reason: decision.reason,
      expectedProfileId: expected && expected.profileId ? expected.profileId : null,
      actualProfileId: matchedProfile ? matchedProfile.id : null
    });
    return false;
  };

  const getCodexChatContextForProfileSwitch = () => {
    const contextToRestore = captureCurrentCodexChatContext(logger);
    logger.debug('Codex restore debug: getCodexChatContextForProfileSwitch result.', {
      contextToRestore
    });
    if (isRestorableCodexChatContext(contextToRestore)) {
      return contextToRestore;
    }
    return undefined;
  };

  const getPostSwitchRestoreStrategy = () => normalizePostSwitchRestoreStrategy(
    vscode.workspace
      .getConfiguration('codexSwitch')
      .get('postSwitchRestoreStrategy', DEFAULT_POST_SWITCH_RESTORE_STRATEGY)
  );

  const scheduleCodexPostSwitchWarmup = async (profileId, options = {}) => {
    logger.debug('Codex restore debug: scheduleCodexPostSwitchWarmup called.', {
      profileId: profileId || null,
      changedProfile: Boolean(options.changedProfile),
      willReloadWindow: Boolean(options.willReloadWindow)
    });
    if (!profileId || !options.changedProfile) {
      logger.debug('Codex restore debug: skipping schedule because switch did not change profile.', {
        profileId: profileId || null,
        changedProfile: Boolean(options.changedProfile)
      });
      return;
    }

    const activeActivation = getActiveCounterActivationOwner();
    if (activeActivation) {
      logger.info(
        'Did not schedule a Codex chat restore because counter activation owns the Codex UI.',
        {
          profileId,
          activationJobId: activeActivation.jobId,
          workerWorkspacePath: activeActivation.workerWorkspacePath
        }
      );
      return;
    }

    const restoreChatContext = getCodexChatContextForProfileSwitch();
    const restoreStrategy = getPostSwitchRestoreStrategy();
    logger.debug('Codex restore debug: captured context and strategy for profile switch.', {
      profileId,
      restoreChatContext,
      restoreStrategy
    });
    if (options.willReloadWindow) {
      const scheduledAt = Date.now();
      await context.workspaceState.update(
        CODEX_POST_SWITCH_WARMUP_KEY,
        restoreChatContext
          ? {
              profileId,
              scheduledAt,
              restoreChatContext,
              restoreStrategy
            }
          : undefined
      );
      await context.workspaceState.update(CODEX_POST_SWITCH_AUTH_SYNC_KEY, {
        profileId,
        scheduledAt
      });
      if (!restoreChatContext) {
        logger.info(
          'Skipped post-switch chat restore because no Codex conversation editor tab is open.',
          { profileId }
        );
        return;
      }
      logger.debug('Codex restore debug: pending post-switch warm-up saved to workspaceState.', {
        key: CODEX_POST_SWITCH_WARMUP_KEY,
        profileId,
        restoreChatContext,
        restoreStrategy
      });
      logger.info('Scheduled Codex post-switch warm-up for the next VS Code activation.', {
        profileId,
        restoreChatKind: restoreChatContext ? restoreChatContext.kind : null,
        restoreStrategy
      });
      return;
    }

    if (!restoreChatContext) {
      logger.info(
        'Skipped post-switch chat restore because no Codex conversation editor tab is open.',
        { profileId }
      );
      return;
    }

    setTimeout(() => {
      logger.debug('Codex restore debug: running delayed no-reload post-switch warm-up.', {
        profileId,
        restoreChatContext,
        restoreStrategy
      });
      void warmUpCodexOutsideCounterActivation('profile-switch-no-reload', {
        restoreChatContext,
        restoreStrategy
      });
    }, DEFAULT_POST_SWITCH_WARMUP_DELAY_MS);
  };

  const consumePendingPostSwitchAuthSync = async () => {
    const pending = context.workspaceState.get(CODEX_POST_SWITCH_AUTH_SYNC_KEY);
    if (!pending || !pending.scheduledAt) {
      return null;
    }

    await context.workspaceState.update(CODEX_POST_SWITCH_AUTH_SYNC_KEY, undefined);
    if (!isPendingCodexPostSwitchWarmupFresh(pending, Date.now(), DEFAULT_PENDING_WARMUP_MAX_AGE_MS)) {
      logger.warn('Skipped stale post-switch Codex auth sync.', {
        profileId: pending.profileId || null,
        scheduledAt: pending.scheduledAt,
        maxAgeMs: DEFAULT_PENDING_WARMUP_MAX_AGE_MS
      });
      return null;
    }

    return pending.profileId || null;
  };

  const syncProfilesOnActivation = async () => {
    await profileManager.syncCurrentAuthToMatchingProfile();
    const pendingProfileId = await consumePendingPostSwitchAuthSync();
    if (!pendingProfileId) {
      const windowActive = await profileManager.getWindowActiveProfileMatch();
      const restoredAuth = windowActive.profileId
        ? await profileManager.maybeSyncToCodexAuthFile(windowActive.profileId)
        : false;
      if (restoredAuth) {
        logger.info(
          'Restored the workspace account after VS Code startup; reloading once so Codex uses it.',
          { profileId: windowActive.profileId }
        );
        void vscode.commands.executeCommand('workbench.action.reloadWindow');
        return;
      }
      await rateLimitMonitor.refresh(true);
      await profileManager.createProfileBackup('activation');
      await profileManager.pruneAuthBackups();
      return;
    }

    logger.info('Applying startup Codex auth sync for a profile-switch reload.', {
      profileId: pendingProfileId
    });
    const restoredAuth = await profileManager.maybeSyncToCodexAuthFile(pendingProfileId);
    await profileManager.initializeWindowActiveProfileFromCurrentAuth(true);
    if (restoredAuth) {
      logger.info(
        'The selected workspace account changed during reload; reloading once more to apply it to Codex.',
        { profileId: pendingProfileId }
      );
      void vscode.commands.executeCommand('workbench.action.reloadWindow');
      return;
    }
    await rateLimitMonitor.refresh(true);
    await profileManager.createProfileBackup('activation');
    await profileManager.pruneAuthBackups();
  };

  const runPendingCodexPostSwitchWarmup = async () => {
    const pending = context.workspaceState.get(CODEX_POST_SWITCH_WARMUP_KEY);
    if (!pending || !pending.scheduledAt) {
      logger.debug('Codex restore debug: no pending post-switch warm-up found on activation.', {
        key: CODEX_POST_SWITCH_WARMUP_KEY
      });
      return;
    }

    logger.debug('Codex restore debug: pending post-switch warm-up found on activation.', {
      key: CODEX_POST_SWITCH_WARMUP_KEY,
      pending
    });
    await context.workspaceState.update(CODEX_POST_SWITCH_WARMUP_KEY, undefined);
    if (!isPendingCodexPostSwitchWarmupFresh(pending, Date.now(), DEFAULT_PENDING_WARMUP_MAX_AGE_MS)) {
      logger.warn('Skipped stale Codex post-switch warm-up.', {
        profileId: pending.profileId || null,
        scheduledAt: pending.scheduledAt,
        maxAgeMs: DEFAULT_PENDING_WARMUP_MAX_AGE_MS
      });
      return;
    }

    if (!isRestorableCodexChatContext(pending.restoreChatContext)) {
      logger.warn('Skipped unsafe post-switch Codex chat context.', {
        profileId: pending.profileId || null,
        restoreChatKind:
          pending.restoreChatContext && pending.restoreChatContext.kind
            ? pending.restoreChatContext.kind
            : null
      });
      return;
    }

    setTimeout(() => {
      logger.debug('Codex restore debug: running delayed after-reload post-switch warm-up.', {
        pending,
        restoreStrategy: pending.restoreStrategy || getPostSwitchRestoreStrategy()
      });
      void warmUpCodexOutsideCounterActivation('profile-switch-after-reload', {
        restoreChatContext: pending.restoreChatContext,
        restoreStrategy: pending.restoreStrategy || getPostSwitchRestoreStrategy()
      });
    }, DEFAULT_POST_SWITCH_WARMUP_DELAY_MS);
  };

  const getCurrentAuthNoticeKey = (authData) => {
    if (!authData) {
      return 'current-auth';
    }

    const identityParts = [
      authData.accountId,
      authData.defaultOrganizationId,
      authData.chatgptUserId,
      authData.userId,
      authData.subject,
      authData.email
    ]
      .map((value) => (typeof value === 'string' ? value.trim() : ''))
      .filter(Boolean);

    return identityParts.length ? identityParts.join('|') : 'current-auth';
  };

  const maybeNotifyUnmanagedCurrentProfile = async () => {
    if (
      !areProfileFeaturesEnabled() ||
      (vscode.window.state && vscode.window.state.focused === false)
    ) {
      return;
    }

    if (unmanagedAuthNoticeInFlight) {
      return;
    }
    unmanagedAuthNoticeInFlight = true;
    let shouldRecheckAfterNotice = false;

    try {
      const currentAuthMatch = await profileManager.getCurrentAuthProfileMatch();
      if (!currentAuthMatch.hasAuth) {
        lastUnmanagedAuthNoticeKey = undefined;
        if (context.globalState.get(UNMANAGED_AUTH_NOTICE_KEY) !== undefined) {
          await context.globalState.update(UNMANAGED_AUTH_NOTICE_KEY, undefined);
        }
        return;
      }

      if (currentAuthMatch.profileId) {
        lastUnmanagedAuthNoticeKey = undefined;
        if (context.globalState.get(UNMANAGED_AUTH_NOTICE_KEY) !== undefined) {
          await context.globalState.update(UNMANAGED_AUTH_NOTICE_KEY, undefined);
        }
        return;
      }

      const authData = await profileManager.loadCurrentAuthData();
      const noticeKey = getCurrentAuthNoticeKey(authData);
      if (
        noticeKey === lastUnmanagedAuthNoticeKey ||
        noticeKey === context.globalState.get(UNMANAGED_AUTH_NOTICE_KEY)
      ) {
        return;
      }

      // Only the currently focused VS Code window may own this cross-window notice. Checking
      // again after the file reads prevents a window that lost focus mid-refresh from showing it.
      if (vscode.window.state && vscode.window.state.focused === false) {
        return;
      }

      lastUnmanagedAuthNoticeKey = noticeKey;
      await context.globalState.update(UNMANAGED_AUTH_NOTICE_KEY, noticeKey);
      shouldRecheckAfterNotice = true;

      const addLabel = 'Add current profile';
      const manageLabel = 'Manage profiles';
      const selection = await vscode.window.showInformationMessage(
        `Current Codex account${displayAccountLabel(authData)} is not saved in Codex Multitool.`,
        addLabel,
        manageLabel
      );

      if (selection === addLabel) {
        await vscode.commands.executeCommand('codex-switch.profile.addFromCodexAuthFile');
      } else if (selection === manageLabel) {
        await vscode.commands.executeCommand('codex-switch.profile.manage');
      }
    } catch (error) {
      logger.error('Failed to notify about unmanaged current Codex account.', {
        error: error && error.message ? error.message : String(error)
      });
    } finally {
      unmanagedAuthNoticeInFlight = false;
      if (shouldRecheckAfterNotice) {
        void maybeNotifyUnmanagedCurrentProfile();
      }
    }
  };

  const refreshProfileUi = async (options = {}) => {
    const refreshId = ++latestProfileUiRefreshId;
    const shouldUpdateActiveWindowUsage = options.updateActiveWindowUsage !== false;

    try {
      if (!areProfileFeaturesEnabled()) {
        if (shouldUpdateActiveWindowUsage) {
          profileManager.clearActiveWindowProfileUsage();
        }
        profileStatusBarController.update(null, []);
        return;
      }

      const profiles = await profileManager.listProfiles();
      const activeProfileId = await profileManager.getActiveProfileId();
      if (refreshId !== latestProfileUiRefreshId) {
        return;
      }
      if (shouldUpdateActiveWindowUsage) {
        await updateActiveWindowProfileUsage(activeProfileId);
      }
      const otherWindowProfileUsageByProfileId =
        profileManager.getOtherActiveWindowProfileUsageByProfileId();

      if (!activeProfileId) {
        profileStatusBarController.update(null, profiles, otherWindowProfileUsageByProfileId);
        void maybeNotifyUnmanagedCurrentProfile();
        return;
      }

      const activeProfile = profiles.find((profile) => profile.id === activeProfileId);
      if (refreshId !== latestProfileUiRefreshId) {
        return;
      }

      if (!activeProfile) {
        await profileManager.setActiveProfileId(undefined);
        return;
      }

      profileStatusBarController.update(
        activeProfile,
        profiles,
        otherWindowProfileUsageByProfileId
      );
      void maybeNotifyUnmanagedCurrentProfile();
    } catch (error) {
      logger.error('Failed to refresh the Codex profile status UI.', {
        error: error && error.message ? error.message : String(error)
      });
      profileStatusBarController.update(null, []);
    }
  };

  const handleProfileWatcherChange = async (event = {}) => {
    if (event.source === 'windowUsage') {
      await refreshProfileUi({ updateActiveWindowUsage: false });
      return;
    }

    if (event.source === 'profiles') {
      await refreshProfileUi();
      return;
    }

    if (!areProfileFeaturesEnabled()) {
      await refreshProfileUi();
      return;
    }

    let shouldAcceptAuthChange = false;
    let settledAuthData = null;
    if (event.source === 'auth') {
      const authRefreshId = ++latestAuthWatcherRefreshId;
      const readiness = await profileManager.waitForCurrentAuthData({
        timeoutMs: AUTH_WATCHER_SETTLE_TIMEOUT_MS,
        intervalMs: 500,
        stableMs: 250
      });
      if (authRefreshId !== latestAuthWatcherRefreshId) {
        return;
      }

      if (readiness.authData) {
        logger.info('Codex auth.json watcher settled on a valid account.', {
          authPath: readiness.authPath,
          waitedMs: readiness.waitedMs
        });
      } else {
        logger.warn('Codex auth.json watcher did not see a valid account before refresh.', {
          authPath: readiness.authPath,
          waitedMs: readiness.waitedMs
        });
      }
      settledAuthData = readiness.authData;
      shouldAcceptAuthChange = await shouldAcceptAuthChangeForThisWindow(settledAuthData);
    }

    if (event.source === 'auth' && shouldAcceptAuthChange) {
      clearExpectedWindowAuthChange();
      await profileManager.initializeWindowActiveProfileFromCurrentAuth(true);
    }

    await profileManager.syncCurrentAuthToMatchingProfile();
    await refreshProfileUi();
    if (event.source === 'auth' && !shouldAcceptAuthChange) {
      return;
    }
    await rateLimitMonitor.refresh(true);
  };

  const reconcileFocusedWindowAuth = async () => {
    if (!areProfileFeaturesEnabled()) {
      return;
    }

    try {
      const activeActivation = getActiveCounterActivationOwner();
      if (activeActivation) {
        logger.info(
          'Kept this workspace account unchanged while counter activation owns auth.json.',
          { activationJobId: activeActivation.jobId }
        );
        return;
      }

      const windowActive = await profileManager.getWindowActiveProfileMatch();
      if (!windowActive.profileId) {
        await maybeNotifyUnmanagedCurrentProfile();
        return;
      }

      const current = await profileManager.getCurrentAuthProfileMatch();
      if (current.profileId === windowActive.profileId) {
        await maybeNotifyUnmanagedCurrentProfile();
        return;
      }

      markWindowAuthChangeExpected({ profileId: windowActive.profileId });
      const restored = await profileManager.maybeSyncToCodexAuthFile(
        windowActive.profileId
      );
      logger.info('Restored this workspace account after the VS Code window regained focus.', {
        profileId: windowActive.profileId,
        previousAuthProfileId: current.profileId || null,
        changedAuthFile: restored
      });
      await profileManager.syncCurrentAuthToMatchingProfile();
      await refreshProfileUi();
      await rateLimitMonitor.refresh(true);
    } catch (error) {
      logger.error('Failed to reconcile Codex account after window focus.', {
        error: error && error.message ? error.message : String(error)
      });
    }
  };

  registerProfileCommands(context, profileManager, rateLimitMonitor, refreshProfileUi, {
    markWindowAuthChangeExpected,
    onProfileSwitchCommitted: scheduleCodexPostSwitchWarmup
  });

  const ensureSendToCodexEnabled = async () => {
    if (isSendToCodexEnabled()) {
      return true;
    }

    const enableLabel = 'Enable Send to Codex';
    const selection = await vscode.window.showInformationMessage(
      'Send to Codex is currently disabled.',
      enableLabel
    );

    if (selection === enableLabel) {
      await vscode.workspace
        .getConfiguration(CONFIG_SECTION)
        .update(SEND_TO_CODEX_ENABLED_SETTING, true, vscode.ConfigurationTarget.Global);
      return true;
    }

    return false;
  };

  context.subscriptions.push(
    codexAvailabilityController.onDidChangeAvailability(() => {
      void editorStatusBarController.refresh();
      void statusBarController.refresh();
    }),
    profileManager.onDidChange(() => {
      void refreshProfileUi();
    }),
    rateLimitMonitor.onDidChange(() => {
      void refreshProfileUi();
    }),
    vscode.window.onDidChangeWindowState((windowState) => {
      if (windowState.focused) {
        void reconcileFocusedWindowAuth();
      }
    }),
    {
      dispose() {
        profileManager.clearActiveWindowProfileUsage();
      }
    },
    ...profileManager.createWatchers((event) => {
      void handleProfileWatcherChange(event);
    }),
    vscode.commands.registerCommand('codexTerminalRecorder.openLogDirectory', async () => {
      await manager.openLogDirectory();
    }),
    vscode.commands.registerCommand('codexTerminalRecorder.openDiagnosticsLog', async () => {
      if (!logger.isLogFileEnabled() && !logger.hasLogFile()) {
        void vscode.window.showInformationMessage(
          'Diagnostics log file is disabled. Enable it in settings or with the toggle command first.'
        );
        return;
      }

      logger.info('Opening diagnostics log from command.');
      await logger.flush();
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(logger.logFilePath));
      await vscode.window.showTextDocument(document, { preview: false });
    }),
    vscode.commands.registerCommand('codexTerminalRecorder.openActiveTerminalLog', async () => {
      await manager.openActiveTerminalLog();
    }),
    vscode.commands.registerCommand('codexTerminalRecorder.openSettings', async () => {
      await vscode.commands.executeCommand(
        'workbench.action.openSettings',
        `@ext:${context.extension.id}`
      );
    }),
    vscode.commands.registerCommand(
      'codexTerminalRecorder.internal.warmUpCodexAfterProfileSwitch',
      async () => {
        await warmUpCodexOutsideCounterActivation('manual-internal-command', {
          restoreChatContext: getCodexChatContextForProfileSwitch(),
          restoreStrategy: getPostSwitchRestoreStrategy()
        });
      }
    ),
    vscode.commands.registerCommand(
      'codexTerminalRecorder.toggleDiagnosticsLogging',
      async () => {
        const enabled = await toggleBooleanSetting(
          'diagnosticsLoggingEnabled',
          DIAGNOSTICS_LOGGING_ENABLED_DEFAULT
        );
        logger.reloadConfiguration();
        void vscode.window.showInformationMessage(
          `Send to Codex diagnostics logging ${enabled ? 'enabled' : 'disabled'}.`
        );
      }
    ),
    vscode.commands.registerCommand(
      'codexTerminalRecorder.toggleDiagnosticsLogFile',
      async () => {
        const configuration = vscode.workspace.getConfiguration(CONFIG_SECTION);
        const current = Boolean(
          configuration.get('diagnosticsLogFileEnabled', DIAGNOSTICS_LOG_FILE_ENABLED_DEFAULT)
        );
        const next = !current;

        await configuration.update(
          'diagnosticsLogFileEnabled',
          next,
          vscode.ConfigurationTarget.Global
        );
        if (next) {
          await configuration.update(
            'diagnosticsLoggingEnabled',
            true,
            vscode.ConfigurationTarget.Global
          );
        }

        logger.reloadConfiguration();
        void vscode.window.showInformationMessage(
          `Send to Codex diagnostics log file ${next ? 'enabled' : 'disabled'}.`
        );
      }),
    vscode.commands.registerCommand(
      'codexTerminalRecorder.addExplorerResourceToCodexChat',
      async (resource, selection) => {
        if (!(await ensureSendToCodexEnabled())) {
          return;
        }
        await explorerResourcesSender.sendExplorerResourcesToCodexChat(resource, selection);
      }
    ),
    vscode.commands.registerCommand(
      'codexTerminalRecorder.addExplorerFolderToCodexChat',
      async (resource, selection) => {
        if (!(await ensureSendToCodexEnabled())) {
          return;
        }
        await explorerResourcesSender.sendExplorerResourcesToCodexChat(resource, selection);
      }
    ),
    vscode.commands.registerCommand(
      'codexTerminalRecorder.locateActiveTerminalSelection',
      async () => {
        await selectionLocator.locateActiveTerminalSelection();
      }
    ),
    vscode.commands.registerCommand(
      'codexTerminalRecorder.sendActiveEditorSelectionToCodexChat',
      async () => {
        if (!(await ensureSendToCodexEnabled())) {
          return;
        }
        await editorSender.sendActiveEditorSelectionToCodexChat();
      }
    ),
    vscode.commands.registerCommand(
      'codexTerminalRecorder.sendActiveTerminalSelectionToCodexChat',
      async () => {
        if (!(await ensureSendToCodexEnabled())) {
          return;
        }
        await codexSender.sendActiveTerminalSelectionToCodexChat();
      }
    ),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(CONFIG_SECTION)) {
        logger.reloadConfiguration();
        void manager.reloadConfiguration(true);
        void codexAvailabilityController.refresh();
        void editorStatusBarController.refresh();
        void statusBarController.refresh();
      }

      if (
        event.affectsConfiguration('codexSwitch') ||
        event.affectsConfiguration('codexRatelimit')
      ) {
        void refreshProfileUi();
      }

      if (event.affectsConfiguration('codexSwitch.enabled') && areProfileFeaturesEnabled()) {
        void (async () => {
          await profileManager.syncCurrentAuthToMatchingProfile();
          await profileManager.initializeWindowActiveProfileFromCurrentAuth(true);
          await rateLimitMonitor.refresh(true);
        })();
      }
    })
  );

  const activeWindowUsageTimer = setInterval(() => {
    void refreshActiveWindowProfileUsage();
  }, ACTIVE_WINDOW_USAGE_HEARTBEAT_MS);
  context.subscriptions.push({
    dispose() {
      clearInterval(activeWindowUsageTimer);
    }
  });

  codexAvailabilityController.activate();
  rateLimitMonitor.activate();
  nativeSelectionOverlayController.activate();
  editorStatusBarController.activate();
  statusBarController.activate();
  logger.info('Extension controllers activated.', {
    diagnosticsLogPath: logger.logFilePath,
    outputChannelName: OUTPUT_CHANNEL_NAME,
    openAiExtensionInstalled: Boolean(vscode.extensions.getExtension('openai.chatgpt')),
    terminalWriteApiAvailable: isTerminalWriteApiAvailable()
  });
  void refreshProfileUi();
  void runPendingCodexPostSwitchWarmup();
  if (areProfileFeaturesEnabled()) {
    void syncProfilesOnActivation();
  }
  void manager.activate();
}

async function toggleBooleanSetting(settingName, defaultValue) {
  const configuration = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const next = !Boolean(configuration.get(settingName, defaultValue));
  await configuration.update(settingName, next, vscode.ConfigurationTarget.Global);
  return next;
}

function deactivate() {}

function isTerminalWriteApiAvailable() {
  try {
    return typeof vscode.window.onDidWriteTerminalData === 'function';
  } catch {
    return false;
  }
}

module.exports = {
  activate,
  deactivate
};
