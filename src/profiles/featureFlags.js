'use strict';

const vscode = require('vscode');

function areProfileFeaturesEnabled() {
  return Boolean(vscode.workspace.getConfiguration('codexSwitch').get('enabled', true));
}

async function setProfileFeaturesEnabled(enabled) {
  await vscode.workspace
    .getConfiguration('codexSwitch')
    .update('enabled', Boolean(enabled), vscode.ConfigurationTarget.Global);
}

module.exports = {
  areProfileFeaturesEnabled,
  setProfileFeaturesEnabled
};
