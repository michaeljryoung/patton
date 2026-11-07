# xterm.js internals

Read before touching paste handling, key handling or any listener on the terminal's DOM. Moved word for word from CLAUDE.md's Gotchas (S44 slimming, 2026-11-07).

- **xterm.js swallows paste events** (S40). Its textarea/`.xterm` paste listener calls `stopPropagation()`, so a bubble-phase `paste` handler on an ancestor never fires for terminal pastes — Patton's sanitise-and-confirm path had been dead since it was written. Use a capture-phase listener and hand text to `terminal.paste()` (keeps bracketed paste), never `pty.write`.
- **xterm.js `attachCustomKeyEventHandler` fires for BOTH `keydown` AND `keypress`.** Returning `false` only on `keydown` still lets `keypress` through, causing xterm to send `\r`. Must return `false` for both event types.
