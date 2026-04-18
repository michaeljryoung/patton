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

## Session Log
**2026-04-15 (session 19)**
- Fixed persistent light-theme text readability — CLI tool text (Claude Code, etc.) was unreadable on light backgrounds despite COLORFGBG and OSC 10/11 fixes from prior sessions
- Root cause: xterm.js `minimumContrastRatio` was unset (defaults to 1 = disabled). VS Code uses the same ANSI palette but sets this to 4.5, which auto-corrects low-contrast colors. Patton copied the colors without the safety net.
- Fix 1: Added `minimumContrastRatio: 4.5` to Terminal constructor — xterm.js now auto-adjusts any foreground color below 4.5:1 contrast against the background
- Fix 2: Replaced 6 ANSI colors in LIGHT_THEME that had terrible inherent contrast (e.g. `brightWhite` was 2.4:1, `brightGreen` was 2.0:1 — WCAG AA requires 4.5:1)
- Previous sessions: OSC 10/11 responses (18), tab rename fix (17), COLORFGBG env var (16)

## Decisions
- **ZDOTDIR for zsh shell integration** — overrides ZDOTDIR to a custom `.zshenv` that restores the user's real ZDOTDIR, sources their `.zshenv`, then sources the integration script. Same pattern VS Code uses. Avoids PTY write echo entirely.
- **--rcfile for bash shell integration** — custom init script that manually sources login files (`/etc/profile`, `~/.bash_profile`) + integration. Replaces `--login` flag since `--rcfile` requires non-login mode.
- **Kitty keyboard protocol for Shift+Enter** — sends `\x1b[13;2u` instead of `\r` so terminal apps can handle Shift+Enter as "newline without submit". Chosen over backslash-continuation (shell-only, breaks in apps like Claude Code) and compose-panel-open (too disruptive).
- **COLORFGBG from renderer, not just nativeTheme** — renderer passes `isDark` based on actual terminal background luminance (custom theme or system). Main process falls back to `nativeTheme.shouldUseDarkColors`. This handles custom light themes on dark system and vice versa.
- **OSC 10/11 color query responses** — CLI tools query fg/bg colors at runtime via OSC 10/11. xterm.js doesn't respond by default. Hooked `onData` in `terminal-view.ts` to detect queries and respond with actual theme colors. Complements COLORFGBG (env var = startup detection, OSC = runtime detection).
- **minimumContrastRatio: 4.5** — xterm.js auto-adjusts any foreground color below this contrast ratio against the background. This is the same approach VS Code uses. Without it, even correct light-mode detection doesn't help if ANSI palette colors themselves lack contrast. The palette fix provides better defaults; the ratio enforcement is the safety net for 256-color and true-color values from CLI apps.

## Gotchas
- `stty -echo` on the same line as `source ...` does NOT prevent echo — the terminal driver echoes characters as they arrive, before the shell executes anything. Must inject via shell startup (ZDOTDIR, --rcfile) not PTY write.
- Idle detection fires on ANY PTY data, including prompt redraws and background trickle. Duration guard is essential — byte count alone isn't enough since small periodic output accumulates.
- xterm.js treats Shift+Enter identically to Enter (`\r`) by default. Must use `attachCustomKeyEventHandler` to intercept and send a distinct escape sequence.
- xterm.js `attachCustomKeyEventHandler` fires for BOTH `keydown` AND `keypress`. Returning `false` only on `keydown` still lets `keypress` through, causing xterm to send `\r`. Must return `false` for both event types.
- CLI apps (Claude Code, etc.) use `COLORFGBG` env var to detect light vs dark terminal backgrounds. Without it, they assume dark and render light-colored text — invisible on light backgrounds. Must set at PTY spawn time; can't change env vars for running PTYs.
- CLI apps also query terminal colors at runtime via OSC 10/11 escape sequences (`\x1b]10;?\x07` and `\x1b]11;?\x07`). xterm.js doesn't respond to these by default — must hook `onData` and write back `rgb:RR/GG/BB` responses.
- `tabBar.update()` rebuilds the entire DOM (`innerHTML = ''`). Any click-triggered callback that calls `updateTabBar` will destroy elements mid-interaction (e.g., breaking `dblclick` because the first click's target is gone). Guard with early-returns for no-op state transitions.
- Light terminal ANSI colors need explicit contrast checking. xterm.js default `minimumContrastRatio` is 1 (disabled). Colors like `#a5a5a5` (brightWhite) or `#14ce14` (brightGreen) are invisible on white. VS Code uses the same palette but enables contrast enforcement — copying just the colors without the setting is a trap.

## Next Steps
- [ ] Test CI-built DMG install on a clean machine (right-click → Open for Gatekeeper)
- [ ] Verify `brew tap michaeljryoung/patton && brew install --cask patton` installs latest
- [ ] Consider Apple Developer ID ($99/yr) for notarization if distributing widely
- [ ] End-to-end test all features in packaged app
- [ ] **Tab "awaiting input" indicator** (iTerm-style dot). When a tab's foreground process is idle/prompting (i.e., shell at prompt waiting for user input) show a small colored dot on the tab in the tab bar. Plumbing already exists: `terminal-view.ts` parses OSC 133 and emits `promptState` ('command' | 'idle'); `tab-manager.ts` already subscribes. Just need (a) a per-tab `awaitingInput` state set true on 'idle' when the tab is NOT the active tab (active tab is by definition where user attention is), cleared on tab focus or 'command' state; (b) a dot element in the tab DOM rendered when that state is true. Skip the indicator for the active tab. Consider: different dot color if the last command failed (exit code from OSC 133 ;D parameter).
