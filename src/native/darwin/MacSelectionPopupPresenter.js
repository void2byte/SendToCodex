'use strict';

const path = require('path');
const { spawn } = require('node:child_process');

class MacSelectionPopupPresenter {
  constructor(logger) {
    this.logger = logger;
    this.swiftScriptPath = path.join(__dirname, 'ActionPopup.swift');
    this.activeChild = null;
  }

  isSupported() {
    return process.platform === 'darwin';
  }

  async showAction(payload) {
    if (!this.isSupported()) {
      return {
        action: 'unsupported',
        message: 'Native selection popup is only available on macOS.'
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
        swiftScriptPath: this.swiftScriptPath
      });

    return new Promise((resolve) => {
      // Run the Swift script using the 'swift' interpreter.
      // This is slightly slower than a compiled binary but avoids compilation steps.
      const child = spawn('swift', [this.swiftScriptPath], {
        cwd: path.dirname(this.swiftScriptPath),
        env: {
          ...process.env
        },
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
          
          // Try to parse JSON from stdout
          try {
            const lines = stdout.split('\n');
            for (const line of lines) {
              if (line.trim().startsWith('{') && line.trim().endsWith('}')) {
                const message = JSON.parse(line);
                if (message && message.action) {
                  finish(message);
                  child.kill();
                  break;
                }
              }
            }
          } catch (e) {
            // Not JSON yet
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
        // Send payload via stdin
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
