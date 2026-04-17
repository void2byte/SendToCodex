'use strict';

const { MacSelectionPopupPresenter } = require('./darwin/MacSelectionPopupPresenter');
const { WindowsSelectionPopupPresenter } = require('./windows/WindowsSelectionPopupPresenter');

function createUnsupportedPresenter(message) {
  return {
    showAction: async () => ({
      action: 'unsupported',
      message
    }),
    isSupported: () => false,
    dispose: () => {}
  };
}

function createSelectionPopupPresenter(logger) {
  if (process.platform === 'win32') {
    return new WindowsSelectionPopupPresenter(logger);
  }

  if (process.platform === 'darwin') {
    const presenter = new MacSelectionPopupPresenter(logger);
    if (presenter.isSupported()) {
      return presenter;
    }

    logger &&
      logger.warn('Native macOS popup support is unavailable because Swift was not found.', {
        expectedExecutablePath: presenter.swiftExecutablePath
      });

    return createUnsupportedPresenter(
      'Native selection popup is unavailable because /usr/bin/swift was not found.'
    );
  }

  return createUnsupportedPresenter('Native selection popup is unavailable on this platform.');
}

module.exports = {
  createSelectionPopupPresenter
};
