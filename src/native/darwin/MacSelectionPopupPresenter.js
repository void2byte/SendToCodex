'use strict';

const path = require('node:path');
const { spawn } = require('node:child_process');
const { getSwiftExecutablePath } = require('./swiftRuntime');

class MacSelectionPopupPresenter {
  constructor(logger) {
    this.logger = logger;
    this.swiftScriptPath = path.join(__dirname, 'ActionPopup.swift');
    this.swiftExecutablePath = getSwiftExecutablePath();
    this.activeChild = null;
  }

  isSupported() {
    return process.platform === 'darwin' && Boolean(this.swiftExecutablePath);
  }

  async showAction(payload) {
    if (!this.isSupported()) {
      return {
        action: 'unsupported',
        message: 'Native selection popup is only available on macOS with /usr/bin/swift.'
      };
    }

    if (this.activeChild) {
      return {
        action: 'busy',
        message: 'Native selection popup is already open.'
      };
    }

    this.logger &&
      this.logger.info('Opening native selection popup for macOS.', {
        payload,
        swiftExecutablePath: this.swiftExecutablePath,
        swiftScriptPath: this.swiftScriptPath
      });

    return new Promise((resolve) => {
      const child = spawn(this.swiftExecutablePath, [this.swiftScriptPath], {
        cwd: path.dirname(this.swiftScriptPath),
        stdio: ['pipe', 'pipe', 'pipe']
      });

      this.activeChild = child;
      let settled = false;
      let stderr = '';
      let stdout = '';

      const finish = (result) => {
        if (settled) {
          return;
        }

        settled = true;
        if (this.activeChild === child) {
          this.activeChild = null;
        }

        resolve({
          ...(result || { action: 'dismiss' }),
          stderr: stderr.trim() || undefined,
          stdout: stdout.trim() || undefined
        });
      };

      if (child.stdout) {
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk) => {
          stdout += chunk;

          for (const line of stdout.split('\n')) {
            const candidate = line.trim();
            if (!candidate.startsWith('{') || !candidate.endsWith('}')) {
              continue;
            }

            try {
              const message = JSON.parse(candidate);
              if (message && message.action) {
                finish(message);
                child.kill();
                break;
              }
            } catch {
              // Ignore partial or non-JSON output and keep reading.
            }
          }
        });
      }

      if (child.stderr) {
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', (chunk) => {
          stderr += chunk;
        });
      }

      child.once('error', (error) => {
        finish({
          action: 'error',
          message: error && error.message ? error.message : String(error)
        });
      });

      child.once('exit', (code, signal) => {
        if (!settled) {
          finish(
            code && code !== 0
              ? {
                  action: 'error',
                  message: `Native selection popup process exited with code ${code}.`,
                  signal
                }
              : {
                  action: 'dismiss',
                  signal
                }
          );
        }
      });

      try {
        child.stdin.write(JSON.stringify(payload || {}));
        child.stdin.end();
      } catch (error) {
        finish({
          action: 'error',
          message: error && error.message ? error.message : String(error)
        });
      }
    });
  }

  dispose() {
    if (!this.activeChild) {
      return;
    }

    try {
      this.activeChild.kill();
    } catch (error) {
      this.logger &&
        this.logger.warn('Failed to terminate native selection popup process.', {
          error: error && error.message ? error.message : String(error)
        });
    } finally {
      this.activeChild = null;
    }
  }
}

module.exports = {
  MacSelectionPopupPresenter
};
