'use strict';

function decideObservedAuthChange(options = {}) {
  if (options.windowFocused !== false) {
    return { accept: true, reason: 'focused-window' };
  }

  const expectedChange = options.expectedChange;
  if (!expectedChange) {
    return { accept: false, reason: 'background-unexpected' };
  }

  if (!expectedChange.profileId) {
    return { accept: true, reason: 'expected-login' };
  }

  if (options.actualProfileId === expectedChange.profileId) {
    return { accept: true, reason: 'expected-profile' };
  }

  return { accept: false, reason: 'background-profile-mismatch' };
}

module.exports = {
  decideObservedAuthChange
};
