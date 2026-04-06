'use strict';

const { WindowsSelectionPopupPresenter } = require('./windows/WindowsSelectionPopupPresenter');
const { MacSelectionPopupPresenter } = require('./darwin/MacSelectionPopupPresenter');

function createSelectionPopupPresenter(logger) {
  if (process.platform === 'win32') {
    return new WindowsSelectionPopupPresenter(logger);
  } else if (process.platform === 'darwin') {
    return new MacSelectionPopupPresenter(logger);
  }
  
  // Return a dummy presenter for other platforms
  return {
    showAction: async () => ({ action: 'unsupported' }),
    isSupported: () => false,
    dispose: () => {}
  };
}

module.exports = {
  createSelectionPopupPresenter
};
