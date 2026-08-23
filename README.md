<img width="1000" height="563" alt="Codex Multitool demo" src="media/codex-multitool-demo.gif" />


# Codex Multitool

Manage Codex accounts, usage limits and protected notes, and send terminal or editor context to Codex without leaving VS Code.

Codex Multitool combines an account manager, per-profile usage monitor and context-sending workflow for the official OpenAI Codex extension. Use the parts together or disable the ones you do not need.

[Install from Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=screph.codex-terminal-recorder) · [Source and issues](https://github.com/void2byte/SendToCodex)

## Highlights

- Switch between saved Codex accounts and see each profile's primary and weekly usage windows in the status bar, QuickPick and account manager.
- Keep private per-account notes and locally generated TOTP codes in VS Code SecretStorage.
- Recover profiles from rotating encrypted snapshots or maintain a password-encrypted portable vault.
- Activate unused rate-limit counters in an isolated worker window or through the Codex app server, with a detailed sanitized report.
- Send terminal selections, editor selections, files and folders to Codex with focused, reproducible context.
- Keep concurrent VS Code windows synchronized without losing profile or rate-limit updates.

## What's new in 0.0.93

- Protected account notebooks with TOTP support.
- Encrypted daily recovery snapshots and a portable encrypted profile vault.
- Workspace-aware active accounts and coordinated multi-window refreshes.
- Explicit reset handling with `starts on first use` state for inactive counters.
- Two isolated counter-activation methods with per-account diagnostics and visual reports.
- Safer defaults: terminal recording and local diagnostic logs stay off until enabled on that machine.

## What it does

- Captures rolling plain-text output for each integrated terminal.
- Maintains a line index sidecar to make terminal selection matching more reliable.
- Sends terminal context to Codex as a compact Markdown bundle file.
- Creates immutable per-selection terminal snapshots, retains the latest terminal selection/snapshot file pairs, and reuses the previous snapshot file when the buffer did not change.
- Supports editor selections and Explorer file or folder attachments in addition to terminal selections.
- Shows a native platform popup near terminal and editor selections on Windows, macOS, and Linux, with optional status bar fallback buttons.
- Can write a diagnostics log for troubleshooting activation, selection detection, and Codex integration when explicitly enabled on the current machine.
- Saves multiple Codex auth profiles and switches the active `auth.json` from inside VS Code.
- Adds a private notebook to every saved account; notes and optional TOTP/2FA secrets are kept in VS Code SecretStorage, are excluded from manual profile exports, and are removed with the account.
- Keeps one encrypted local profile snapshot per day for seven days. Snapshots include profile metadata, tokens, private notes, TOTP configuration, and active/previous account state; their AES key remains in VS Code SecretStorage.
- Can maintain a password-encrypted portable vault in the extension global-storage folder. The vault is updated after profile changes and contains profile metadata, tokens, private notes, TOTP configuration, saved limit records, and active/previous account state. A detected vault can be merged from the account-manager settings and optionally attached for continuing automatic synchronization.
- Tracks Codex session rate-limit windows per saved profile and shows cooldown time remaining for each account.
- Coordinates account refreshes across VS Code windows, keeps concurrent profile updates intact, and retains last-known API values through temporary refresh failures.
- Suppresses informational background toasts; critical errors use a short notification that closes automatically.

## Codex profiles and limits

- Use `Codex Multitool: Manage Profiles` to import accounts from the current `~/.codex/auth.json`, from another file, or from a previous exported profile bundle.
- The account status bar item shows compact 5-hour and weekly limit state for the active account.
- Each workspace window remembers and displays its own active account. A normal VS Code restart restores that workspace account; a reload triggered by profile switching applies the newly selected account.
- The profile switcher QuickPick shows each saved account with compact per-profile limit state, plus toggles for VS Code reload-after-switch and Send to Codex on or off.
- After a detected or manual limit reset, locally stored usage percentages and reset timestamps are cleared together. The affected window is marked `starts on first use`, and its countdown remains stopped until Codex reports a new authoritative `resetsAt` value.
- `Codex Multitool: Activate Unused Rate-Limit Counters` offers two explicit methods. **Codex extension window (recommended on Windows)** switches `auth.json` in a uniquely named worker window, reloads that window, opens a new panel of the official `openai.chatgpt` extension, types `тест` only after Windows confirms that exact worker window is foreground, and waits for the official extension's conversation and completed response. It keeps the answer visible briefly and closes only the exact editor tab it opened. The thread remains in Codex history because the official extension does not expose an archive command to other extensions. **Codex app-server only** uses a direct, read-only app-server turn without opening or controlling the official Codex UI; its service thread is archived after the response and is the supported choice on non-Windows platforms. The two methods are also available directly as `Codex Multitool: Activate Counters via Codex Extension` and `Codex Multitool: Activate Counters via App Server`.
- Both methods use the dedicated worker window to isolate account switching, wait up to one additional minute for the Usage API to confirm the new counter, restore the original account, and close the worker when the batch completes. The UI method requires a versioned worker marker and verifies the same unique native window before opening the Codex panel and again before typing; a legacy worker or changed window handle is rejected without sending input. While a batch owns the Codex UI, every other VS Code window suppresses Multitool chat restoration so the activation chat cannot be opened in the window where you are working. Start from a trusted local folder: the worker is created as an ignored child of that folder so it inherits Workspace Trust without another prompt.
- The worker tracks chat state instead of treating an open tab as success: Codex UI startup, account/auth check, prompt entry, conversation creation, answer in progress, completed response, early tab closure, empty/failed/timed-out turn, cancellation, and usage confirmation. Server-side authentication failures such as `401 token_revoked`, an ended session, a revoked refresh token, or managed login/workspace restrictions are reported as **Sign-in required** for that account, then the batch safely advances.
- When the run ends, a report panel opens with the selected method, a compact summary, and collapsible per-account diagnostics, timelines, sanitized Codex output, machine-readable JSON, and a visual snapshot of every `тест`/response chat. Authentication tokens and saved credentials are never included. The account manager exposes the method chooser as a button; the paid-limit reset dialog can launch the same chooser.
- Hover over the notebook icon in the account manager to preview and edit the protected note, copy individual lines, and use locally generated TOTP codes. Click the icon to open the full editor. Notes and separately configured 2FA secrets are stored in VS Code SecretStorage and are never written to `profiles.json` or shared remote profile files; only encrypted rotating recovery snapshots contain them outside SecretStorage.
- The note editor recognizes `otpauth://totp/...` links and Base32 secrets preceded by `2FA:`, `TOTP:`, `OTP:`, `secret:`, `секрет:`, or `ключ:`. It displays the current code and expiry timer without exporting or logging the secret.
- If `profiles.json` is unreadable, the extension offers to restore the latest encrypted snapshot or choose an older one. The account manager also exposes manual profile recovery. Existing `auth.json` switch backups are pruned to two per day for seven days (14 maximum).
- The account manager's **Portable encrypted profile vault** card can create the vault, import a detected vault once, import and keep it synchronized, change its password, or stop synchronization without deleting the file. The password is requested before encryption and retained only in VS Code SecretStorage on the current computer.

## How terminal sending works

1. The extension resolves the active terminal selection using the configured strategy.
2. It captures or reuses an immutable snapshot of the terminal buffer for that selection.
3. It generates a `terminal-xxx-<name>.selection-yyy.md` file with the snapshot path, resolved source range, selected text, related command, and nearby numbered context.
4. In `contextBundle` and `attachmentFile` modes, only that Markdown file is attached to Codex. The snapshot `.txt` file stays on disk and is referenced from the bundle.
5. In `editorSelection` mode, the extension opens the relevant terminal text in an editor and sends it as a normal editor selection.

## Files and storage

Terminal recording is disabled by default so Marketplace installations do not create recording files. Enable `codexTerminalRecorder.enabled` on a machine that should record terminals. When `codexTerminalRecorder.logDirectory` is empty, enabled recordings are stored outside the workspace in the extension global storage directory.

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
- From a terminal, you can also run `code --extensionDevelopmentPath "<repo path>" --enable-proposed-api screph.codex-terminal-recorder`.
- After changing extension JavaScript, restart the `F5` session or reload the Extension Development Host window. Rebuilding or reinstalling a VSIX is not required.

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

## Settings

- `codexSwitch.enabled`: enable or disable Codex profiles and rate limits.
- `codexTerminalRecorder.sendToCodexEnabled`: enable or disable the full Send to Codex workflow from the profile switcher menu.
- `codexTerminalRecorder.enabled`: enable local terminal capture on this machine; disabled by default.
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
- `codexSwitch.profileActivityLogEnabled`: write profile/account-switch activity events on this machine; disabled by default.
- `codexSwitch.storageMode`: choose between SecretStorage and shared remote files for saved tokens.
- `codexSwitch.reloadWindowAfterProfileSwitch`: reload the current VS Code window after switching accounts by default; the profile switcher includes a checkbox for this.
- Only open central Codex conversation-editor tabs are explicitly restored after reload. Sidebar history is left to VS Code and the official Codex extension; Codex Multitool never infers a current chat from historical `Codex.log` entries.
- `codexSwitch.postSwitchRestoreStrategy`: choose a restore strategy for central Codex conversation-editor tabs.
- The profile switcher also includes a checkbox for temporarily disabling Send to Codex without turning off profiles.
- `codexSwitch.statusBarClickBehavior`: cycle through profiles or jump back to the previous one.
- `codexSwitch.profileQuickPick.hiddenSections`: hide selected account groups from the profile switcher popup.
- `codexSwitch.profileQuickPick.sectionOrder`: choose account group order in the profile switcher popup.
- `codexSwitch.profileQuickPick.profileSort`: choose account ordering in the popup, including reset-time and remaining-limit presets. The popup includes `Sort accounts...` and `Tie-break sort...` controls for changing these modes in place. Availability keeps status groups; other modes globally sort all visible inactive accounts.
- `codexSwitch.profileQuickPick.roundLowWeeklyRemainingToZero`: optionally display weekly remaining usage below the configured threshold as 0% in the profile switcher popup.
- Account timestamps use the unambiguous local format `YYYY-MM-DD HH:mm:ss UTC±HH:mm`. Limit tables label used and remaining percentages explicitly; primary-window durations can differ by plan.
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

If Codex reports that a refresh token was revoked, run `Codex Multitool: Re-authenticate Active Profile`. The command resolves the Codex CLI bundled with the official OpenAI extension (or a CLI already on `PATH`), clears the current Codex auth with `codex logout`, starts `codex login`, and then updates the saved profile from the new `auth.json`.
