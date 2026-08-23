'use strict';

const vscode = require('vscode');

const TRANSIENT_ERROR_DURATION_MS = 2_500;
const POLICY_MARKER = Symbol('codexMultitoolNotificationPolicy');

function hasActionItems(argumentsList) {
  return argumentsList.some((value) => {
    if (typeof value === 'string') {
      return value.length > 0;
    }
    return Boolean(
      value &&
      typeof value === 'object' &&
      typeof value.title === 'string' &&
      value.title.length > 0
    );
  });
}

function showTransientError(message) {
  const text = String(message || 'Codex Multitool operation failed.');
  if (!vscode.window || typeof vscode.window.withProgress !== 'function') {
    return Promise.resolve();
  }

  const progressLocation = vscode.ProgressLocation && vscode.ProgressLocation.Notification;
  if (progressLocation == null) {
    return Promise.resolve();
  }

  return vscode.window.withProgress(
    {
      location: progressLocation,
      title: `$(error) ${text}`,
      cancellable: false
    },
    () => new Promise((resolve) => {
      setTimeout(resolve, TRANSIENT_ERROR_DURATION_MS);
    })
  );
}

function installNotificationPolicy(logger) {
  if (!vscode.window || vscode.window[POLICY_MARKER]) {
    return;
  }

  const originalInfo = vscode.window.showInformationMessage;
  const originalWarning = vscode.window.showWarningMessage;
  const originalError = vscode.window.showErrorMessage;
  if (
    typeof originalInfo !== 'function' ||
    typeof originalWarning !== 'function' ||
    typeof originalError !== 'function'
  ) {
    return;
  }

  const policy = { originalInfo, originalWarning, originalError };

  try {
    // Suppress passive informational toasts that every open VS Code window may emit, but
    // never swallow a prompt that expects the user to choose an action.
    vscode.window.showInformationMessage = (message, ...items) => {
      if (hasActionItems(items)) {
        return originalInfo.call(vscode.window, message, ...items);
      }
      if (logger && typeof logger.debug === 'function') {
        logger.debug('Suppressed Codex Multitool informational notification.', { message });
      }
      return Promise.resolve(undefined);
    };

    vscode.window.showWarningMessage = (message, ...items) => {
      if (hasActionItems(items)) {
        return originalWarning.call(vscode.window, message, ...items);
      }
      if (logger && typeof logger.debug === 'function') {
        logger.debug('Suppressed Codex Multitool warning notification.', { message });
      }
      return Promise.resolve(undefined);
    };

    vscode.window.showErrorMessage = (message, ...items) => {
      if (hasActionItems(items)) {
        return originalError.call(vscode.window, message, ...items);
      }
      if (logger && typeof logger.error === 'function') {
        logger.error('Codex Multitool transient error notification.', { message });
      }
      return showTransientError(message);
    };

    Object.defineProperty(vscode.window, POLICY_MARKER, {
      configurable: false,
      enumerable: false,
      value: policy,
      writable: false
    });
  } catch (error) {
    // VS Code normally exposes writable API methods. If a future host freezes the API object,
    // leave its methods untouched and report the compatibility issue through diagnostics only.
    if (logger && typeof logger.warn === 'function') {
      logger.warn('Could not install Codex Multitool notification policy.', {
        error: error && error.message ? error.message : String(error)
      });
    }
  }
}

module.exports = {
  TRANSIENT_ERROR_DURATION_MS,
  installNotificationPolicy,
  showTransientError
};
