'use strict';
const vscode = require('vscode');
const {
  CONFIG_SECTION,
  DIAGNOSTICS_LOG_FILE_ENABLED_DEFAULT,
  DIAGNOSTICS_LOGGING_ENABLED_DEFAULT,
  OUTPUT_CHANNEL_NAME
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
const { NativeSelectionOverlayController } = require('./ui/NativeSelectionOverlayController');
const { EditorSelectionStatusBarController } = require('./ui/EditorSelectionStatusBarController');
const { RecorderSettingsStatusBarController } = require('./ui/RecorderSettingsStatusBarController');
const { SelectionPopupSuppression } = require('./ui/SelectionPopupSuppression');
const { TerminalSelectionStatusBarController } = require('./ui/TerminalSelectionStatusBarController');

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
  const recorderSettingsStatusBarController = new RecorderSettingsStatusBarController(
    codexAvailabilityController,
    manager,
    logger
  );
  const statusBarController = new TerminalSelectionStatusBarController(
    codexAvailabilityController,
    logger
  );
  context.subscriptions.push(codexAvailabilityController);
  context.subscriptions.push(nativeSelectionOverlayController);
  context.subscriptions.push(editorStatusBarController);
  context.subscriptions.push(recorderSettingsStatusBarController);
  context.subscriptions.push(statusBarController);

  context.subscriptions.push(
    codexAvailabilityController.onDidChangeAvailability(() => {
      void editorStatusBarController.refresh();
      void recorderSettingsStatusBarController.refresh();
      void statusBarController.refresh();
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
        `@ext:${context.extension.id} ${CONFIG_SECTION}`
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
        await explorerResourcesSender.sendExplorerResourcesToCodexChat(resource, selection);
      }
    ),
    vscode.commands.registerCommand(
      'codexTerminalRecorder.addExplorerFolderToCodexChat',
      async (resource, selection) => {
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
        await editorSender.sendActiveEditorSelectionToCodexChat();
      }
    ),
    vscode.commands.registerCommand(
      'codexTerminalRecorder.sendActiveTerminalSelectionToCodexChat',
      async () => {
        await codexSender.sendActiveTerminalSelectionToCodexChat();
      }
    ),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(CONFIG_SECTION)) {
        logger.reloadConfiguration();
        void manager.reloadConfiguration(true);
        void codexAvailabilityController.refresh();
        void editorStatusBarController.refresh();
        void recorderSettingsStatusBarController.refresh();
        void statusBarController.refresh();
      }
    })
  );

  codexAvailabilityController.activate();
  nativeSelectionOverlayController.activate();
  editorStatusBarController.activate();
  recorderSettingsStatusBarController.activate();
  statusBarController.activate();
  logger.info('Extension controllers activated.', {
    diagnosticsLogPath: logger.logFilePath,
    outputChannelName: OUTPUT_CHANNEL_NAME,
    openAiExtensionInstalled: Boolean(vscode.extensions.getExtension('openai.chatgpt')),
    terminalWriteApiAvailable: isTerminalWriteApiAvailable()
  });
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
