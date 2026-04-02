# Patton

Always-passthrough terminal with a floating compose panel for drafting multi-line input.

## Tech Stack
- **Electron** (v40) with Vite + TypeScript via Electron Forge
- **xterm.js** v6 (`@xterm/xterm`) — terminal rendering (WebGL addon)
- **node-pty** — PTY spawning in main process
- **electron-store** — persistent settings + history

## Architecture

```
src/
├── main/           # Electron main process (PTY, IPC, menus, settings store)
├── preload/        # contextBridge API (type-safe IPC bridge)
├── renderer/       # UI components, services, styles
│   ├── components/ # Tab, Terminal, Compose Panel, Settings, Command Palette, etc.
│   ├── services/   # Tab manager, history, keybindings
│   └── styles/     # CSS with design tokens + auto dark/light mode
├── shared/         # IPC channel constants + shared TypeScript types
└── resources/      # Shell integration scripts (zsh, bash)
```

## Commands
- `npm start` — dev mode with hot reload
- `npm run package` — build distributable
- `npm run make` — create DMG installer
- `npm run lint` — ESLint
- `npm run release [-- patch|minor|major]` — manual release (CI handles this automatically)

## Verifiers

```bash
npm run lint && npm run package
```

## Key Conventions
- All colors use CSS variables (`:root` + `@media prefers-color-scheme`)
- All interactive elements have ARIA attributes
- Resize observers are debounced (100ms)
- PTY data is write-coalesced (4ms buffer)
- electron-store needs CJS/ESM interop: `(mod.default || mod)`
- Entry files must match package.json `main` field naming (main.ts → main.js, preload.ts → preload.js)

---

## Status
Feature-complete, distributed. Automated CI/CD pipeline with auto-versioning.

## Last Session
**2026-04-02 (session 16)**
- Fixed invisible text in CLI app dropdowns (Claude Code) on light backgrounds
- Root cause: PTY env missing `COLORFGBG` — CLI apps couldn't detect light/dark background, defaulted to dark and used light text
- Set `COLORFGBG` based on active theme's background luminance (ITU-R BT.601 weighted), passed from renderer to main process
- Also set `TERM_PROGRAM=Patton` for terminal identification
- Built and installed locally via `npm run make`

## Decisions
- **ZDOTDIR for zsh shell integration** — overrides ZDOTDIR to a custom `.zshenv` that restores the user's real ZDOTDIR, sources their `.zshenv`, then sources the integration script. Same pattern VS Code uses. Avoids PTY write echo entirely.
- **--rcfile for bash shell integration** — custom init script that manually sources login files (`/etc/profile`, `~/.bash_profile`) + integration. Replaces `--login` flag since `--rcfile` requires non-login mode.
- **Kitty keyboard protocol for Shift+Enter** — sends `\x1b[13;2u` instead of `\r` so terminal apps can handle Shift+Enter as "newline without submit". Chosen over backslash-continuation (shell-only, breaks in apps like Claude Code) and compose-panel-open (too disruptive).
- **COLORFGBG from renderer, not just nativeTheme** — renderer passes `isDark` based on actual terminal background luminance (custom theme or system). Main process falls back to `nativeTheme.shouldUseDarkColors`. This handles custom light themes on dark system and vice versa.

## Gotchas
- `stty -echo` on the same line as `source ...` does NOT prevent echo — the terminal driver echoes characters as they arrive, before the shell executes anything. Must inject via shell startup (ZDOTDIR, --rcfile) not PTY write.
- Idle detection fires on ANY PTY data, including prompt redraws and background trickle. Duration guard is essential — byte count alone isn't enough since small periodic output accumulates.
- xterm.js treats Shift+Enter identically to Enter (`\r`) by default. Must use `attachCustomKeyEventHandler` to intercept and send a distinct escape sequence.
- xterm.js `attachCustomKeyEventHandler` fires for BOTH `keydown` AND `keypress`. Returning `false` only on `keydown` still lets `keypress` through, causing xterm to send `\r`. Must return `false` for both event types.
- CLI apps (Claude Code, etc.) use `COLORFGBG` env var to detect light vs dark terminal backgrounds. Without it, they assume dark and render light-colored text — invisible on light backgrounds. Must set at PTY spawn time; can't change env vars for running PTYs.

## Next Steps
- [ ] Test CI-built DMG install on a clean machine (right-click → Open for Gatekeeper)
- [ ] Verify `brew tap michaeljryoung/patton && brew install --cask patton` installs latest
- [ ] Consider Apple Developer ID ($99/yr) for notarization if distributing widely
- [ ] End-to-end test all features in packaged app
