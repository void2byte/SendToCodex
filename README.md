# Send to Codex

Local VS Code extension that keeps a rolling plain-text record for each integrated terminal.

## What it does

- Creates one plain-text recording file per terminal.
- Writes a line index sidecar for selection matching.
- Keeps only the most recent `N` megabytes per file.
- Deletes the log file when its terminal closes.
- Cleans up leftover dead terminal log files on startup.
- Lets you configure the directory and size limit from VS Code settings.
- Can optionally write a diagnostics log file for troubleshooting extension activation, Codex integration, and button visibility.
- Adds `Explorer` context menu actions for files and folders: `Add to Codex Chat` and `Add Folder to Codex Chat`.

## Selection tracking strategies

- `terminalSelectionTextSearch`: read the current terminal selection and search in the plain-text log.
- `indexedTerminalSelectionSearch`: read the current terminal selection and resolve it with the plain-text log plus the line index sidecar.
- `clipboardTextSearch`: read copied terminal text from the clipboard and search in the plain-text log.

Use the `Send to Codex: Locate Active Terminal Selection` command to test the currently selected strategy.
Use `Send to Codex` to send the resolved terminal context to Codex.
Use `codexTerminalRecorder.terminalContextSendMode` to choose between a structured Markdown context bundle, a separate attachment file, and the legacy editor-selection flow.
Use `codexTerminalRecorder.attachSnapshotFileInContextBundle` to control whether `contextBundle` also attaches the full terminal snapshot `.txt` file.
On Windows, the extension can surface a compact native popup action near the cursor for editor and terminal selections, with a close action on the right edge.
The `Ctrl+Shift+L` shortcut remains available for both editor and terminal selections.
The optional status bar buttons are kept as a disabled-by-default fallback and can be enabled in settings.
When Codex is available, the status bar also shows a settings badge with the number of currently captured terminals.
Use `Send to Codex: Open Diagnostics Log` to inspect the extension file log.

## Current limitation

This version uses the proposed `terminalDataWriteEvent` API because the stable VS Code API does not expose the full integrated terminal stream.
Existing terminal scrollback is not backfilled: logging starts only after the extension begins tracking a terminal and new output is produced.
When the raw data stream is unavailable, the extension falls back to shell integration command capture when VS Code reports shell execution events.
If those events still do not arrive, opening the active terminal log or sending terminal context will attempt an on-demand snapshot of the visible terminal buffer.

To run it locally you need:

1. VS Code Insiders or extension development mode.
2. The proposed API enabled for this extension:

```powershell
code-insiders --enable-proposed-api=local.codex-terminal-recorder
```

## Settings

- `codexTerminalRecorder.enabled`
- `codexTerminalRecorder.maxFileSizeMb`
- `codexTerminalRecorder.logDirectory`
- `codexTerminalRecorder.diagnosticsLoggingEnabled`
- `codexTerminalRecorder.diagnosticsLogFileEnabled`
- `codexTerminalRecorder.selectionTrackingStrategy`
- `codexTerminalRecorder.selectionContextLines`
- `codexTerminalRecorder.terminalContextSendMode`
- `codexTerminalRecorder.attachSnapshotFileInContextBundle`
- `codexTerminalRecorder.showNativeTerminalSelectionPopup`
- `codexTerminalRecorder.showNativeEditorSelectionPopup`
- `codexTerminalRecorder.showCodexSelectionButton`
- `codexTerminalRecorder.showCodexEditorSelectionButton`
