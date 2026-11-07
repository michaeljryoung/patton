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

### Content Security
- Content Security Policy enforced via `onHeadersReceived`
- Navigation to external URLs is blocked
- `window.open` is denied
- URL validation: WebLinksAddon only opens `http://` and `https://` links
- Paste sanitization: control characters stripped; multi-line pastes (3+ lines) ask first only when Settings → "Confirm multi-line pastes" is on (off by default since v1.13.1: dictation tools paste their text, so the dialog fired on every dictated message). With it off, a shell without bracketed paste (macOS's built-in bash 3.2) runs each pasted line as it arrives; zsh, bash 5.1+ and Claude Code hold the paste until Enter. Pastes are caught by a capture-phase listener that runs before xterm's own (which stops propagation), and the text goes in through `terminal.paste()`, keeping bracketed paste.

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
