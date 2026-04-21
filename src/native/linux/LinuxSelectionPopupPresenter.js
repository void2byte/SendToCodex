'use strict';

const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

class LinuxSelectionPopupPresenter {
  constructor(logger) {
    this.logger = logger;
    this.popupScriptPath = path.join(__dirname, 'action_popup.py');
    this.pythonExecutablePath = getPythonExecutablePath();
    this.activeChild = null;
  }

  isSupported() {
    return process.platform === 'linux' && Boolean(this.pythonExecutablePath);
  }

  async showAction(payload) {
    if (!this.isSupported()) {
      return {
        action: 'unsupported',
        message: 'Native selection popup is only available on Linux with Python Tkinter.'
      };
    }

    if (this.activeChild) {
      return {
        action: 'busy',
        message: 'Native selection popup is already open.'
      };
    }

    this.logger &&
      this.logger.info('Opening native selection popup for Linux.', {
        payload,
        popupScriptPath: this.popupScriptPath,
        pythonExecutablePath: this.pythonExecutablePath
      });

    return new Promise((resolve) => {
      const child = spawn(this.pythonExecutablePath, [this.popupScriptPath], {
        cwd: path.dirname(this.popupScriptPath),
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

      const consumeStdout = () => {
        const lines = stdout.split(/\r?\n/);
        stdout = lines.pop() || '';

        for (const line of lines) {
          const candidate = line.trim();
          if (!candidate.startsWith('{') || !candidate.endsWith('}')) {
            continue;
          }

          try {
            const message = JSON.parse(candidate);
            if (message && message.action) {
              finish(message);
              break;
            }
          } catch {
            // Ignore partial or non-JSON output and keep reading.
          }
        }
      };

      if (child.stdout) {
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk) => {
          stdout += chunk;
          consumeStdout();
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
        consumeStdout();
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
        this.logger.warn('Failed to terminate native Linux selection popup process.', {
          error: error && error.message ? error.message : String(error)
        });
    } finally {
      this.activeChild = null;
    }
  }
}

function getPythonExecutablePath() {
  if (process.platform !== 'linux') {
    return undefined;
  }

  const candidates = [
    process.env.CODEX_TERMINAL_RECORDER_PYTHON,
    process.env.PYTHON,
    'python3',
    'python'
  ].filter(Boolean);
  const uniqueCandidates = Array.from(new Set(candidates));

  for (const executablePath of uniqueCandidates) {
    const result = spawnSync(executablePath, ['-c', 'import tkinter'], {
      stdio: 'ignore',
      timeout: 1500
    });

    if (!result.error && result.status === 0) {
      return executablePath;
    }
  }

  return undefined;
}

module.exports = {
  LinuxSelectionPopupPresenter
};
