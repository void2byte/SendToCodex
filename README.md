![ezgif-666ed7ed9c4d2843](https://github.com/user-attachments/assets/17727aad-e997-42b6-8c34-e566323cedef)


# Send to Codex

VS Code extension that captures integrated terminal output, resolves terminal selections back to recorded source lines, and sends the result to Codex with native selection actions on Windows and macOS.

GitHub project: https://github.com/void2byte/SendToCodex

## What it does

- Captures rolling plain-text output for each integrated terminal.
- Maintains a line index sidecar to make terminal selection matching more reliable.
- Sends terminal context to Codex as a compact Markdown bundle file.
- Creates immutable per-selection terminal snapshots and reuses the previous snapshot file when the buffer did not change.
- Supports editor selections and Explorer file or folder attachments in addition to terminal selections.
- Shows a native platform popup near terminal and editor selections on Windows and macOS, with optional status bar fallback buttons.
- Can write a diagnostics log for troubleshooting activation, selection detection, and Codex integration.

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

The status bar buttons are disabled by default and exist as a fallback when the native popup is not desired.

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

## Settings

- `codexTerminalRecorder.enabled`: enable or disable terminal capture.
- `codexTerminalRecorder.terminalContextSendMode`: choose between `contextBundle`, `attachmentFile`, and `editorSelection`.
- `codexTerminalRecorder.selectionTrackingStrategy`: choose how terminal selection text is captured and mapped back to the log files.
- `codexTerminalRecorder.selectionContextLines`: number of surrounding lines to include in the context preview.
- `codexTerminalRecorder.showNativeTerminalSelectionPopup`: show the native platform popup for terminal selections.
- `codexTerminalRecorder.showNativeEditorSelectionPopup`: show the native platform popup for editor selections.
- `codexTerminalRecorder.showCodexSelectionButton`: show the fallback terminal status bar button.
- `codexTerminalRecorder.showCodexEditorSelectionButton`: show the fallback editor status bar button.
- `codexTerminalRecorder.maxFileSizeMb`: rolling size limit per terminal log.
- `codexTerminalRecorder.logDirectory`: target directory for recordings. Leave empty to use extension storage outside the workspace.
- `codexTerminalRecorder.diagnosticsLoggingEnabled`: enable diagnostic logging.
- `codexTerminalRecorder.diagnosticsLogFileEnabled`: also write diagnostics to a log file on disk.

## Platform support

- Windows: native popup support and clipboard change tracking are included out of the box.
- macOS: native popup support and clipboard change tracking are supported via the system Swift runtime at `/usr/bin/swift`.

## Credits

- macOS popup and clipboard tracking support were expanded with a contribution from [git-pi-e](https://github.com/git-pi-e).

## Requirements and limitations

The extension expects a recent stable VS Code build and the OpenAI VS Code extension so the Codex attach commands are available.

Windows is supported out of the box. On macOS, native popups and clipboard change tracking use the system Swift runtime at `/usr/bin/swift`, which keeps the packaged extension small and avoids bundling extra native binaries.

Existing terminal scrollback is not backfilled. Capture starts after the extension begins tracking a terminal and new output is produced. If the raw data stream is unavailable in a particular VS Code build, the extension falls back to shell integration command capture. If that still does not provide enough data, opening the active terminal log or sending terminal context can trigger an on-demand snapshot of the visible terminal buffer.
