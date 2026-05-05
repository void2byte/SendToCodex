<img width="1000" height="563" alt="Codex Multitool demo" src="media/codex-multitool-demo.gif" />


# Codex Multitool

Three-in-one VS Code extension for Send to Codex, Codex account switching, and per-profile rate-limit tracking.

It captures integrated terminal output, resolves terminal selections back to recorded source lines, and sends the result to Codex with native selection actions on Windows, macOS, and Linux.

It also includes an embedded Codex account switcher and a per-profile rate-limit monitor, with compact 5-hour and weekly limits shown in the QuickPick and status bar.

The three parts can be used together or independently: profiles and limits can be disabled so the extension behaves like the original Send to Codex workflow, and Send to Codex itself can be turned off from the profile menu when needed.

GitHub project: https://github.com/void2byte/SendToCodex

## 3 in 1

- Send terminal selections, editor selections, and Explorer resources to Codex.
- Switch between multiple saved Codex accounts inside VS Code.
- Track 5-hour and weekly rate limits per saved profile.

## What it does

- Captures rolling plain-text output for each integrated terminal.
- Maintains a line index sidecar to make terminal selection matching more reliable.
- Sends terminal context to Codex as a compact Markdown bundle file.
- Creates immutable per-selection terminal snapshots, retains the latest terminal selection/snapshot file pairs, and reuses the previous snapshot file when the buffer did not change.
- Supports editor selections and Explorer file or folder attachments in addition to terminal selections.
- Shows a native platform popup near terminal and editor selections on Windows, macOS, and Linux, with optional status bar fallback buttons.
- Can write a diagnostics log for troubleshooting activation, selection detection, and Codex integration.
- Saves multiple Codex auth profiles and switches the active `auth.json` from inside VS Code.
- Tracks Codex session rate-limit windows per saved profile and shows cooldown time remaining for each account.

## Codex profiles and limits

- Use `Codex Multitool: Manage Profiles` to import accounts from the current `~/.codex/auth.json`, from another file, or from a previous exported profile bundle.
- The account status bar item shows compact 5-hour and weekly limit state for the active account.
- The profile switcher QuickPick shows each saved account with compact per-profile limit state, plus toggles for VS Code reload-after-switch and Send to Codex on or off.
- `Codex Rate Limit: Show Details` opens a panel with the active profile's latest observed limit windows plus a summary table for every saved profile.

## How terminal sending works

1. The extension resolves the active terminal selection using the configured strategy.
2. It captures or reuses an immutable snapshot of the terminal buffer for that selection.
3. It generates a `terminal-xxx-<name>.selection-yyy.md` file with the snapshot path, resolved source range, selected text, related command, and nearby numbered context.
4. In `contextBundle` and `attachmentFile` modes, only that Markdown file is attached to Codex. The snapshot `.txt` file stays on disk and is referenced from the bundle.
5. In `editorSelection` mode, the extension opens the relevant terminal text in an editor and sends it as a normal editor selection.

## Files and storage

When `codexTerminalRecorder.logDirectory` is empty, recordings are stored outside the workspace in the extension global storage directory. This is the default and recommended setup because it keeps generated files out of your repo.

Typical output files:

- `terminal-001-bash.txt`: rolling terminal text log
- `terminal-001-bash.lines.json`: line index sidecar
- `terminal-001-bash.selection-001.md`: context bundle attached to Codex
- `terminal-001-bash.snapshot-001.txt`: immutable terminal snapshot referenced from the bundle

If a new selection snapshot matches the previous snapshot for the same terminal, the extension reuses the existing `.snapshot-xxx.txt` path instead of writing a duplicate file.

By default, the latest 50 terminal selection/snapshot file pairs are retained in the recordings folder even after the terminal is closed or VS Code restarts. Change `codexTerminalRecorder.selectionPairRetentionCount` to keep a different number of pairs.

Use `Send to Codex: Open Log Directory` to open the current recordings folder.

## Selection tracking strategies

- `terminalSelectionTextSearch`: reads the live terminal selection and finds its last occurrence in the plain-text terminal log.
- `indexedTerminalSelectionSearch`: reads the live terminal selection and resolves its location using the plain-text log plus the line index sidecar.
- `clipboardTextSearch`: reads copied terminal text from the clipboard and finds its last occurrence in the plain-text terminal log. Useful when direct terminal selection access is unavailable or unreliable on both Windows and macOS.

Use `Send to Codex: Locate Active Terminal Selection` to inspect how the current strategy resolves the active selection.

## Usage

- Select text in the terminal and use the native popup, terminal context menu, or `Ctrl+Shift+L` / `Cmd+Shift+L` to send it to Codex.
- Select text in an editor and use the popup or `Ctrl+Shift+L` / `Cmd+Shift+L` to send the editor selection.
- Right-click a file or folder in Explorer and use `Add to Codex Chat` or `Add Folder to Codex Chat`.

The selection-sending status bar buttons are disabled by default and exist as a fallback when the native popup is not desired. Send to Codex settings are available from the Codex accounts hover tooltip.

## Development without repackaging

When working on this repository, connect the current folder to VS Code as a development extension instead of rebuilding a VSIX for every change.

- In this workspace, press `F5` and use `Run Codex Multitool`; `.vscode/launch.json` passes `--extensionDevelopmentPath=${workspaceFolder}`.
- Use `Terminal: Run Task` -> `Open Codex Multitool Extension Host` to open a new VS Code window with this folder loaded as the development extension.
- From a terminal, you can also run `code --extensionDevelopmentPath "<repo path>" --enable-proposed-api=screph.codex-terminal-recorder`.

## Commands

- `Send to Codex`
- `Send Selection to Codex`
- `Send to Codex: Locate Active Terminal Selection`
- `Send to Codex: Open Active Terminal Log`
- `Send to Codex: Open Log Directory`
- `Send to Codex: Open Diagnostics Log`
- `Send to Codex: Open Settings`
- `Send to Codex: Toggle Diagnostics Logging`
- `Send to Codex: Toggle Diagnostics Log File`
- `Codex Multitool: Manage Profiles`
- `Codex Multitool: Switch Profile`
- `Codex Multitool: Login via Codex CLI`
- `Codex Multitool: Re-authenticate Active Profile`
- `Codex Multitool: Export Profiles`
- `Codex Multitool: Import Profiles`
- `Codex Rate Limit: Refresh Statistics`
- `Codex Rate Limit: Show Details`

## Settings

- `codexSwitch.enabled`: enable or disable Codex profiles and rate limits.
- `codexTerminalRecorder.sendToCodexEnabled`: enable or disable the full Send to Codex workflow from the profile switcher menu.
- `codexTerminalRecorder.enabled`: enable or disable terminal capture.
- `codexTerminalRecorder.terminalContextSendMode`: choose between `contextBundle`, `attachmentFile`, and `editorSelection`.
- `codexTerminalRecorder.selectionTrackingStrategy`: choose how terminal selection text is captured and mapped back to the log files.
- `codexTerminalRecorder.selectionContextLines`: number of surrounding lines to include in the context preview.
- `codexTerminalRecorder.selectionPairRetentionCount`: number of terminal selection/snapshot file pairs to retain across terminal close and VS Code restarts.
- `codexTerminalRecorder.showNativeTerminalSelectionPopup`: show the native platform popup for terminal selections.
- `codexTerminalRecorder.showNativeEditorSelectionPopup`: show the native platform popup for editor selections.
- `codexTerminalRecorder.showCodexSelectionButton`: show the fallback terminal status bar button.
- `codexTerminalRecorder.showCodexEditorSelectionButton`: show the fallback editor status bar button.
- `codexTerminalRecorder.maxFileSizeMb`: rolling size limit per terminal log.
- `codexTerminalRecorder.logDirectory`: target directory for recordings. Leave empty to use extension storage outside the workspace.
- `codexTerminalRecorder.diagnosticsLoggingEnabled`: enable diagnostic logging.
- `codexTerminalRecorder.diagnosticsLogFileEnabled`: also write diagnostics to a log file on disk.
- `codexSwitch.activeProfileScope`: keep the active Codex account global or workspace-local.
- `codexSwitch.storageMode`: choose between SecretStorage and shared remote files for saved tokens.
- `codexSwitch.reloadWindowAfterProfileSwitch`: reload the current VS Code window after switching accounts by default; the profile switcher includes a checkbox for this.
- The profile switcher also includes a checkbox for temporarily disabling Send to Codex without turning off profiles.
- `codexSwitch.statusBarClickBehavior`: cycle through profiles or jump back to the previous one.
- `codexRatelimit.sessionPath`: override the default `~/.codex/sessions` lookup path.
- `codexRatelimit.refreshInterval`: choose how often cooldown data refreshes.
- `codexRatelimit.color.*`: customize warning and critical colors for the combined profile status bar item.

## Platform support

- Windows: native popup support and clipboard change tracking are included out of the box.
- macOS: native popup support and clipboard change tracking are supported via the system Swift runtime at `/usr/bin/swift`.
- Linux: native popup support is included through Python Tkinter when available, often packaged as `python3-tk`, but this button has not been tested on Linux yet.

## Credits

- macOS popup and clipboard tracking support were expanded with a contribution from [git-pi-e](https://github.com/git-pi-e).

## Requirements and limitations

The extension expects a recent stable VS Code build and the OpenAI VS Code extension so the Codex attach commands are available.

Windows is supported out of the box. On macOS, native popups and clipboard change tracking use the system Swift runtime at `/usr/bin/swift`, which keeps the packaged extension small and avoids bundling extra native binaries. On Linux, the native popup uses Python Tkinter when available, often packaged as `python3-tk`; the implementation exists, but its operability has not been tested on Linux yet.

Existing terminal scrollback is not backfilled. Capture starts after the extension begins tracking a terminal and new output is produced. If the raw data stream is unavailable in a particular VS Code build, the extension falls back to shell integration command capture. If that still does not provide enough data, opening the active terminal log or sending terminal context can trigger an on-demand snapshot of the visible terminal buffer.

If Codex reports that a refresh token was revoked, run `Codex Multitool: Re-authenticate Active Profile`. The command clears the current Codex auth with `codex logout`, starts `codex login`, and then updates the saved profile from the new `auth.json`.
