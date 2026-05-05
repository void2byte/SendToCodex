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
const { EditorSelectionCodexSender } = require('./codex/EditorSelectionCodexSender');
const { ExplorerResourcesCodexSender } = require('./codex/ExplorerResourcesCodexSender');
const { TerminalSelectionCodexSender } = require('./codex/TerminalSelectionCodexSender');
const { createSelectionPopupPresenter } = require('./native/presenter');
const { registerProfileCommands } = require('./profiles/commands');
const { areProfileFeaturesEnabled } = require('./profiles/featureFlags');
const { ProfileManager } = require('./profiles/profileManager');
const { RateLimitMonitor } = require('./profiles/rateLimitMonitor');
const { NativeSelectionOverlayController } = require('./ui/NativeSelectionOverlayController');
const { EditorSelectionStatusBarController } = require('./ui/EditorSelectionStatusBarController');
const { ProfileStatusBarController } = require('./profiles/statusBar');
const { SelectionPopupSuppression } = require('./ui/SelectionPopupSuppression');
const { TerminalSelectionStatusBarController } = require('./ui/TerminalSelectionStatusBarController');

const CODEX_POST_SWITCH_WARMUP_KEY = 'codexSwitch.pendingCodexPostSwitchWarmup';

function activate(context) {
  const output = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);
  context.subscriptions.push(output);

  const logger = new FileLogger(context.logUri.fsPath, output);
  logger.reloadConfiguration();
  logger.info('Send to Codex extension activated.', {
    vscodeVersion: vscode.version,
    logFilePath: logger.logFilePath
  });

  const manager = new TerminalLogManager(context, output, logger);
  context.subscriptions.push(manager);
  const profileManager = new ProfileManager(context, logger);
  const profileStatusBarController = new ProfileStatusBarController();
  const rateLimitMonitor = new RateLimitMonitor(profileManager, logger);
  context.subscriptions.push(profileManager);
  context.subscriptions.push(profileStatusBarController);
  context.subscriptions.push(rateLimitMonitor);
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
  let lastUnmanagedAuthNoticeKey;
  let unmanagedAuthNoticeInFlight = false;
  let acceptWindowAuthChangesUntil = 0;

  const markWindowAuthChangeExpected = () => {
    acceptWindowAuthChangesUntil = Math.max(
      acceptWindowAuthChangesUntil,
      Date.now() + 10 * 60 * 1000
    );
  };

  const shouldAcceptAuthChangeForThisWindow = () => {
    if (vscode.window.state && vscode.window.state.focused) {
      return true;
    }
    return acceptWindowAuthChangesUntil > Date.now();
  };

  const warmUpCodexAfterProfileSwitch = async (reason) => {
    const codexExtension = vscode.extensions.getExtension('openai.chatgpt');
    if (!codexExtension) {
      return;
    }

    try {
      if (!codexExtension.isActive) {
        await codexExtension.activate();
      }
      await new Promise((resolve) => setTimeout(resolve, 1200));
      await vscode.commands.executeCommand('chatgpt.openSidebar');
      logger.info('Warmed up Codex after profile switch.', { reason });
    } catch (error) {
      logger.warn('Failed to warm up Codex after profile switch.', {
        reason,
        error: error && error.message ? error.message : String(error)
      });
    }
  };

  const scheduleCodexPostSwitchWarmup = async (profileId, options = {}) => {
    if (!profileId || !options.changedProfile) {
      return;
    }

    if (options.willReloadWindow) {
      await context.workspaceState.update(CODEX_POST_SWITCH_WARMUP_KEY, {
        profileId,
        scheduledAt: Date.now()
      });
      return;
    }

    setTimeout(() => {
      void warmUpCodexAfterProfileSwitch('profile-switch-no-reload');
    }, 1200);
  };

  const runPendingCodexPostSwitchWarmup = async () => {
    const pending = context.workspaceState.get(CODEX_POST_SWITCH_WARMUP_KEY);
    if (!pending || !pending.scheduledAt) {
      return;
    }

    await context.workspaceState.update(CODEX_POST_SWITCH_WARMUP_KEY, undefined);
    if (Date.now() - Number(pending.scheduledAt) > 2 * 60 * 1000) {
      return;
    }

    setTimeout(() => {
      void warmUpCodexAfterProfileSwitch('profile-switch-after-reload');
    }, 1200);
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
    if (!areProfileFeaturesEnabled()) {
      return;
    }

    let shouldRecheckAfterNotice = false;
    if (unmanagedAuthNoticeInFlight) {
      return;
    }

    try {
      const currentAuthMatch = await profileManager.getWindowActiveProfileMatch();
      if (!currentAuthMatch.hasAuth) {
        lastUnmanagedAuthNoticeKey = undefined;
        return;
      }

      if (currentAuthMatch.profileId) {
        lastUnmanagedAuthNoticeKey = undefined;
        return;
      }

      const authData = await profileManager.loadCurrentAuthData();
      const noticeKey = getCurrentAuthNoticeKey(authData);
      if (noticeKey === lastUnmanagedAuthNoticeKey) {
        return;
      }

      lastUnmanagedAuthNoticeKey = noticeKey;
      unmanagedAuthNoticeInFlight = true;
      shouldRecheckAfterNotice = true;

      const addLabel = 'Add current profile';
      const manageLabel = 'Manage profiles';
      const email =
        authData && typeof authData.email === 'string' && authData.email !== 'Unknown'
          ? authData.email.trim().replace(/\s+/g, ' ')
          : '';
      const accountLabel =
        email ? ` (${email})` : '';
      const selection = await vscode.window.showInformationMessage(
        `Current Codex account${accountLabel} is not saved in Codex Multitool.`,
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

  const refreshProfileUi = async () => {
    const refreshId = ++latestProfileUiRefreshId;

    try {
      if (!areProfileFeaturesEnabled()) {
        profileStatusBarController.update(null, []);
        return;
      }

      const profiles = await profileManager.listProfiles();
      const activeProfileId = await profileManager.getActiveProfileId();
      if (refreshId !== latestProfileUiRefreshId) {
        return;
      }

      if (!activeProfileId) {
        profileStatusBarController.update(null, profiles);
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

      profileStatusBarController.update(activeProfile, profiles);
    } catch (error) {
      logger.error('Failed to refresh the Codex profile status UI.', {
        error: error && error.message ? error.message : String(error)
      });
      profileStatusBarController.update(null, []);
    }
  };

  const handleProfileWatcherChange = async (event = {}) => {
    if (!areProfileFeaturesEnabled()) {
      await refreshProfileUi();
      return;
    }

    if (event.source === 'auth' && shouldAcceptAuthChangeForThisWindow()) {
      acceptWindowAuthChangesUntil = 0;
      await profileManager.initializeWindowActiveProfileFromCurrentAuth(true);
    }

    await profileManager.syncCurrentAuthToMatchingProfile();
    await refreshProfileUi();
    await rateLimitMonitor.refresh(true);
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
          await profileManager.syncActiveProfileToCodexAuthFile();
          await rateLimitMonitor.refresh(true);
        })();
      }
    })
  );

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
    void (async () => {
      await profileManager.syncCurrentAuthToMatchingProfile();
      await profileManager.syncActiveProfileToCodexAuthFile();
      await rateLimitMonitor.refresh(true);
    })();
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
