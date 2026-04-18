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
**2026-04-18 (session 20)**
- Shipped renderer-crash hardening (Tier 1 + Tier 2 from the harden-patton-renderer-crashes plan): WebGL `onContextLoss` → DOM fallback, `render-process-gone` auto-reload, `unresponsive`/`responsive` breadcrumbs, `child-process-gone` logging for GPU/utility deaths, local-only `crashReporter` for post-mortem dumps.
- Ran a 10-agent epistemic review (`/reasoning`) plus UI/UX audit pass. Full report at `analysis/reasoning-modes/REPORT.md` (gitignored). 5 Kernel (HIGH-confidence) findings, 11 Supported, 10 Hypotheses, 2 Disputed.
- Worked through the **entire** resulting punch list in one session. Commit `34ce53e` covers 28 files, 683 insertions — grouped below.
- Crash resilience: crash counter (3-in-30s → static error page), `destroyByWindow()` before reload, session-clear after 2nd crash, `uncaughtException`/`unhandledRejection` handlers, WebGL 10s re-acquire retry + `refresh()` on fallback, synchronous PTY buffer flush in `destroy()`, graduated write-coalesce backoff (4/16/32ms tiers, 1MB hard cap).
- Security: store encryption replaced with random 32-byte key protected by `safeStorage` (Keychain) + legacy-key migration; modal confirmation on `startupCommand` change; `OnlyLoadAppFromAsar: true`; shell-setting allowlist alignment; `readonly` guard on `PATTON_SHELL_INTEGRATION_SCRIPT` in wrapper `.zshenv`; 100ms OSC 10/11 debounce; history control-char stripping; session-tree leaf cap; notification length caps + tabId validation; expanded env allowlist (CONDA, KUBECONFIG, ANDROID, DOTNET, AWS, GCLOUD, VIRTUAL_ENV, etc.).
- Command-done coordination: per-pane `fireCommandDone(source)` with 5s cross-source debounce; OSC 133 suppresses idle heuristic for 60s after any fire. Kills triple-notification.
- Session persistence: 30s periodic autosave (covers `beforeunload` teardown race); startup command waits for OSC 133;B prompt signal (1.5s fallback) instead of blind 500ms timer.
- Accessibility: `<html lang="en">`, global `prefers-reduced-motion`, reusable `services/focus-trap.ts` applied to 5 modals, quick-terminal ARIA + `aria-hidden` toggle, command-palette `id`+`aria-activedescendant`+combobox roles, tab-bar Arrow/Home/End roving-tabindex nav, global `services/announcer.ts` (aria-live) wired to tab ops / broadcast / settings / paste. Theme tokens `--broadcast`, `--prompt-ready`, `--prompt-ready-glow` replace hardcoded hex. Distinct "No command history yet" vs "No matches" empty states.
- Dead-code cleanup: removed `PTY_GET_DESCENDANTS` IPC chain (5 files, always returned `[]`).

**2026-04-15 (session 19)**
- Fixed persistent light-theme text readability — CLI tool text (Claude Code, etc.) was unreadable on light backgrounds despite COLORFGBG and OSC 10/11 fixes from prior sessions
- Root cause: xterm.js `minimumContrastRatio` was unset (defaults to 1 = disabled). VS Code uses the same ANSI palette but sets this to 4.5, which auto-corrects low-contrast colors. Patton copied the colors without the safety net.
- Fix 1: Added `minimumContrastRatio: 4.5` to Terminal constructor — xterm.js now auto-adjusts any foreground color below 4.5:1 contrast against the background
- Fix 2: Replaced 6 ANSI colors in LIGHT_THEME that had terrible inherent contrast (e.g. `brightWhite` was 2.4:1, `brightGreen` was 2.0:1 — WCAG AA requires 4.5:1)
- Previous sessions: OSC 10/11 responses (18), tab rename fix (17), COLORFGBG env var (16)

## Decisions
- **safeStorage-backed random key over deterministic SHA-256** — previous scheme was `SHA-256(homedir + ':' + username)`, reconstructable by any same-user process in milliseconds. New scheme generates a random 32-byte key, stores it in `userData/key.enc` encrypted by the OS keychain via `safeStorage`. Legacy key path retained only as a one-shot migration on first launch: probe with new key → on failure, try legacy → copy contents, delete file, reinit. Fallback to legacy deterministic key if `safeStorage.isEncryptionAvailable()` returns false (Linux without GNOME keyring), which is no worse than before.
- **CommandDoneCoordinator (coordinate, don't eliminate)** — three command-done signals coexist for a reason: OSC 133;D is authoritative when shell integration is on, idle heuristic covers children that never emit OSC 133 (Claude Code, npm, docker compose), bell is explicit. Per-pane coordinator debounces across all three (5s) and suppresses idle for 60s after any OSC 133 fire. Strictly better than picking any one.
- **Crash circuit breaker: 3 crashes in 30s → static error page** — below this, a transient GPU blip should auto-recover silently. Above it, a deterministic cause (corrupt session, specific escape sequence) would loop forever. Clearing saved session after the 2nd crash breaks restore-triggered loops before the hard cap trips.
- **Periodic 30s autosave over change-triggered debounce** — change-triggered needs hooks in tab create/close/reorder/rename/split/focus — 5+ wire points, easy to miss one. 30s interval is a single call-site, trades a periodic lsof roundtrip for coverage certainty. Migrate to change-triggered only if the lsof cost becomes a real problem.
- **Startup command waits for OSC 133;B, not a fixed timer** — slow shells (heavy .zshrc plugins) can exceed the old 500ms, making the command race a not-yet-ready shell. Listening for the first prompt-ready signal is readiness-based. 1.5s fallback covers shells without shell integration.
- **Shell allowlist single-sourced, not duplicated** — `ALLOWED_SHELLS` now exported from `pty-manager.ts` and imported by `store.ts`. Previous bug: permissive regex in store + strict set in pty-manager meant user could save a shell that silently fell back at spawn. Always consolidate enforcement points.
- **Crashpad `uploadToServer: false`** — local dumps only. Gives post-mortem diagnosis capability without establishing any network channel or privacy question.
- **ZDOTDIR for zsh shell integration** — overrides ZDOTDIR to a custom `.zshenv` that restores the user's real ZDOTDIR, sources their `.zshenv`, then sources the integration script. Same pattern VS Code uses. Avoids PTY write echo entirely.
- **--rcfile for bash shell integration** — custom init script that manually sources login files (`/etc/profile`, `~/.bash_profile`) + integration. Replaces `--login` flag since `--rcfile` requires non-login mode.
- **Kitty keyboard protocol for Shift+Enter** — sends `\x1b[13;2u` instead of `\r` so terminal apps can handle Shift+Enter as "newline without submit". Chosen over backslash-continuation (shell-only, breaks in apps like Claude Code) and compose-panel-open (too disruptive).
- **COLORFGBG from renderer, not just nativeTheme** — renderer passes `isDark` based on actual terminal background luminance (custom theme or system). Main process falls back to `nativeTheme.shouldUseDarkColors`. This handles custom light themes on dark system and vice versa.
- **OSC 10/11 color query responses** — CLI tools query fg/bg colors at runtime via OSC 10/11. xterm.js doesn't respond by default. Hooked `onData` in `terminal-view.ts` to detect queries and respond with actual theme colors. Complements COLORFGBG (env var = startup detection, OSC = runtime detection).
- **minimumContrastRatio: 4.5** — xterm.js auto-adjusts any foreground color below this contrast ratio against the background. This is the same approach VS Code uses. Without it, even correct light-mode detection doesn't help if ANSI palette colors themselves lack contrast. The palette fix provides better defaults; the ratio enforcement is the safety net for 256-color and true-color values from CLI apps.

## Gotchas
- `window.reload()` does NOT destroy main-process PTYs. Without an explicit `ptyManager.destroyByWindow(window)` before reload, each crash-recovery reload leaks PTYs — they keep running in main, sending PTY_DATA for ids the new renderer doesn't recognize, eventually hitting `MAX_PTY_PER_WINDOW`. Crash handling without PTY cleanup makes crashes *worse*.
- `beforeunload` is fire-and-forget and does NOT fire on renderer crash. A periodic autosave (30s) is the only way to keep persisted state close to reality for crash recovery.
- wrapper `.zshenv` in ZDOTDIR mode sources user's `.zshenv` AFTER ours runs but BEFORE Patton's integration script. A compromised user `.zshenv` can redirect `PATTON_SHELL_INTEGRATION_SCRIPT` to a malicious path unless we `typeset -r`/`readonly` the captured value first.
- Electron's `safeStorage` is only available after `app.ready`. Store must be lazy-initialized (first access inside `app.on('ready', ...)` is fine; at module load would fail).
- `electron-store` doesn't expose a "try decrypt" probe — any mismatch throws. Migration has to instantiate a temp store with the legacy key, snapshot `store.store`, delete the file, then reinit with the new key.
- xterm.js WebGL addon fires `onContextLoss` at runtime (sleep/wake, display unplug, GPU driver reset). A plain `try { loadAddon }` catches sync load errors only — runtime loss will take down the whole renderer unless you subscribe to `onContextLoss` and `dispose()` the addon (falls back to DOM). Identical pattern to `minimumContrastRatio` — VS Code does it, copying only the configuration values without the safety nets is a trap.
- Dead IPC surfaces accumulate. `PTY_GET_DESCENDANTS` returned `[]` for months with no callers but was still exposed via preload — potential attack surface for future renderer code. Periodically grep for IPC handlers and confirm callers exist.
- Shell validation drift: `store.ts` had a permissive regex (`/^\/[a-zA-Z0-9/._-]+$/`) while `pty-manager.ts` enforced a tight `ALLOWED_SHELLS` Set. User could save `/usr/local/bin/fish`, see it persist, silently get the default. Always single-source security-relevant allowlists.
- `stty -echo` on the same line as `source ...` does NOT prevent echo — the terminal driver echoes characters as they arrive, before the shell executes anything. Must inject via shell startup (ZDOTDIR, --rcfile) not PTY write.
- Idle detection fires on ANY PTY data, including prompt redraws and background trickle. Duration guard is essential — byte count alone isn't enough since small periodic output accumulates.
- xterm.js treats Shift+Enter identically to Enter (`\r`) by default. Must use `attachCustomKeyEventHandler` to intercept and send a distinct escape sequence.
- xterm.js `attachCustomKeyEventHandler` fires for BOTH `keydown` AND `keypress`. Returning `false` only on `keydown` still lets `keypress` through, causing xterm to send `\r`. Must return `false` for both event types.
- CLI apps (Claude Code, etc.) use `COLORFGBG` env var to detect light vs dark terminal backgrounds. Without it, they assume dark and render light-colored text — invisible on light backgrounds. Must set at PTY spawn time; can't change env vars for running PTYs.
- CLI apps also query terminal colors at runtime via OSC 10/11 escape sequences (`\x1b]10;?\x07` and `\x1b]11;?\x07`). xterm.js doesn't respond to these by default — must hook `onData` and write back `rgb:RR/GG/BB` responses.
- `tabBar.update()` rebuilds the entire DOM (`innerHTML = ''`). Any click-triggered callback that calls `updateTabBar` will destroy elements mid-interaction (e.g., breaking `dblclick` because the first click's target is gone). Guard with early-returns for no-op state transitions.
- Light terminal ANSI colors need explicit contrast checking. xterm.js default `minimumContrastRatio` is 1 (disabled). Colors like `#a5a5a5` (brightWhite) or `#14ce14` (brightGreen) are invisible on white. VS Code uses the same palette but enables contrast enforcement — copying just the colors without the setting is a trap.

## Key Files
- `analysis/reasoning-modes/REPORT.md` (gitignored) — session-20 triangulated synthesis of 10 epistemic reasoning modes + UI/UX audit. 5 Kernel findings, 11 Supported, 10 Hypotheses, 2 Disputed. Individual mode reports under `analysis/reasoning-modes/reports/`. Run `/reasoning` again to refresh.
- `~/.claude/plans/image-1-my-interfaces-keep-tender-harp.md` — the original crash-hardening plan that kicked off session 20.
- `src/renderer/services/focus-trap.ts` — reusable modal focus trap. Import as `trapFocus(container)` → returns release fn.
- `src/renderer/services/announcer.ts` — global aria-live regions. Import as `announce(msg, 'polite' | 'assertive')`.

## Next Steps
- [ ] Test CI-built DMG install on a clean machine (right-click → Open for Gatekeeper)
- [ ] Verify `brew tap michaeljryoung/patton && brew install --cask patton` installs latest
- [ ] Consider Apple Developer ID ($99/yr) for notarization if distributing widely
- [ ] End-to-end test all features in packaged app
- [ ] **Validate session 20 changes in a real session** — run for a day with the new autosave, crash counter, CommandDoneCoordinator, and `safeStorage` migration. Watch for: duplicate notifications still firing (K3 regression), `safeStorage` migration failures in logs, crash counter false-tripping on benign GPU losses.
- [ ] **Tab "awaiting input" indicator** (iTerm-style dot). When a tab's foreground process is idle/prompting (i.e., shell at prompt waiting for user input) show a small colored dot on the tab in the tab bar. Plumbing already exists: `terminal-view.ts` parses OSC 133 and emits `promptState` ('command' | 'idle'); `tab-manager.ts` already subscribes. Just need (a) a per-tab `awaitingInput` state set true on 'idle' when the tab is NOT the active tab (active tab is by definition where user attention is), cleared on tab focus or 'command' state; (b) a dot element in the tab DOM rendered when that state is true. Skip the indicator for the active tab. Consider: different dot color if the last command failed (exit code from OSC 133 ;D parameter).
- [ ] **Blind-spot passes** flagged by the reasoning synthesis (separate sessions):
  - CVE scan of dep tree (Electron 40, xterm.js 6, node-pty, electron-store, codemirror) — `npm audit` already clean but CVE-age matters
  - Audit the auto-release CI workflow + signing-key handling (highest-severity blind spot given self-signed distribution)
  - Empirical validation of K3/K5/S7 timing under real slow commands
- [ ] **Deferred from session-20 punch list** (all documented in `analysis/reasoning-modes/REPORT.md`):
  - S9: remove CSP `style-src 'unsafe-inline'` (needs empirical test that xterm + CodeMirror still render)
  - H1: test IME phantom composition with CJK input (requires CJK keyboard)
  - H3: document cross-tab PTY access as an architectural choice
  - H4: OSC 7 CWD push to replace polling (requires shell-integration script edits)
  - H6: refactor `swapPanes` to immutable (no confirmed aliasing bug — investigate first)
  - H7: PTY ID counter overflow guard (purely theoretical at 9e15 creations)
  - H10: per-window rate limiters keyed by `window.id` (substantial refactor)
  - UX F5: shell setting as a dropdown from `ALLOWED_SHELLS` instead of text input
  - UX F6: stale-settings indicator ("applies to new tabs" badge)
  - UX F7: diff-and-patch `tab-bar.ts` / `history-search.ts` instead of `innerHTML = ''` rebuilds
