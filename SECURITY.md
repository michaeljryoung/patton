# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in Patton, please report it responsibly:

1. **Do not** open a public GitHub issue
2. Email **michael@lindus.health** with the subject line `[Patton Security]`
3. Include a description of the vulnerability, steps to reproduce, and potential impact

I'll acknowledge receipt within 48 hours and aim to release a fix within 7 days for critical issues.

## Security Model

Patton implements defense-in-depth for a desktop Electron application:

### Process Isolation
- Renderer process runs with `sandbox: true`
- All main-process communication goes through a type-safe `contextBridge` API
- No `nodeIntegration`, no `remote` module

### PTY Security
- PTY ownership validation on all IPC calls (write, resize, destroy, getProcess)
- Shell paths validated against an allowlist of known shells
- Environment variables filtered to an allowlist (HOME, PATH, LANG, USER, etc.)
- `FORCE_HYPERLINK=1` (tells Claude Code to print OSC 8 links) is exported only into the pane that runs the startup command, not every shell: tools using `supports-hyperlinks` honour it even when their output is piped, so it puts OSC 8 escape bytes into logs and JSON. It is still inherited by everything that shell and Claude start (Claude's Bash-tool commands included) and stays set after Claude exits.
- Rate limiting: sliding-window (5000/s for PTY writes, 10/s for settings changes)
- Maximum 50 PTYs per window
- Closing a window with live shells asks first (main's close guard; ⌘Q asks in `before-quit`). ⌘W on a window's last tab asks in the app instead, and on confirm the renderer pre-confirms the close (`window:preconfirm-close`) and then asks main to close its window (`window:close`, `BrowserWindow.close()`, so the guard and shell cleanup run; a page's own `window.close()` skips the `'close'` event on Electron 44.9.3), so the native box isn't shown twice. Main's `'closed'` handler ends any shells still left, and the renderer does not close at all when main never answered the close-info query (`window:close-info`). That record covers only the sender's own window, is consumed by its next close and expires after 5 s (`src/main/close-preconfirm.ts`), so a renderer can at most close its own window without the native prompt, which it can already do by ending its own shells (`pty:destroy`) and then calling `window.close()`; the red button and ⌘Q keep the native guard.

### Content Security
- Content Security Policy enforced via `onHeadersReceived`
- Navigation to external URLs is blocked
- `window.open` is denied
- URL validation: web links open only `http://` and `https://`, and main opens the normalised URL (`URL.href`), the same text the OSC 8 hover shows
- File links (bare paths, markdown links, OSC 8 `file://`) are judged in main on the resolved file (symlinks followed; `src/main/link-open-policy.ts`): the code editor CLI (argv, no shell) for text and code when one is found; the default app only for regular, non-executable files of a view-only type (text, markdown, JSON, CSV, log, images, PDF, HTML/SVG); everything else (app bundles, executables, `.command`/`.pkg`/`.dmg`/`.jar`/`.workflow`/`.mobileconfig`/`.scpt`/`.webloc`/`.fileloc`, unknown types, scripts with no editor) is only revealed in Finder. A double-click on a link never launches a program; HTML, SVG and PDF open in their default viewer (browser or PDF reader), where page or PDF script can run.
- Paste sanitization: control characters stripped; multi-line pastes (3+ lines) ask first only when Settings → "Confirm multi-line pastes" is on (off by default since v1.13.1: dictation tools paste their text, so the dialog fired on every dictated message). With it off, a shell without bracketed paste (macOS's built-in bash 3.2) runs each pasted line as it arrives; zsh, bash 5.1+ and Claude Code hold the paste until Enter. Pastes are caught by a capture-phase listener that runs before xterm's own (which stops propagation), and the text goes in through `terminal.paste()`, keeping bracketed paste.
- Program status (OSC 7501, the protocol Claude Code reports its state with): the only thing written back is the fixed answer to `OSC 7501 ; ?`, which holds nothing from a report. Reports are untrusted: the spec's size limits are enforced (a report over any is dropped whole), free text must be valid base64 of UTF-8 with no control character (else the report is dropped), direction overrides and invisible formatting are removed, and the text only reaches the tab's tooltip and accessible name as plain text, never markup. Any program writing to a pane can send reports, as it can a bell: the worst a spoof does is raise, park or hide that pane's own dot. Records are capped at 64 per pane, and the log records states and counts, never report text.
- System fonts: `fonts:getSystem` takes no argument. Main reads SF Mono's four faces from two fixed directories inside Terminal.app (never a path from the renderer), skips anything that is not a regular file or is over 4 MB, and hands the bytes to the renderer, which registers them with `document.fonts`. The files are read at runtime, never copied into the repo or the app bundle, and a font that fails to parse is skipped and logged.

### Data Security
- Settings stored via electron-store with machine-specific encryption key (SHA-256 of hostname + username)
- Command history auto-expires after 90 days
- No telemetry, no analytics, no network calls beyond what the user's shell does

### Build Security
- All dependencies pinned to exact versions (no `^` or `~`)
- Production dependency audit gate on build (`npm audit --omit=dev --audit-level=high`)
- Self-signed code signing for stable TCC identity

## Supported Versions

| Version | Supported |
|---------|-----------|
| 1.0.x   | Yes       |
