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
├── main/           # Electron main process
│   ├── main.ts           # App entry, lifecycle
│   ├── window-manager.ts # BrowserWindow + CSP + navigation guards
│   ├── pty-manager.ts    # PTY lifecycle, write-coalesce (4ms), env allowlist, shell validation, shell integration injection
│   ├── ipc-handlers.ts   # IPC routing with PTY ownership validation
│   ├── menu.ts           # macOS menu bar
│   └── store.ts          # electron-store with settings validation
├── preload/
│   └── preload.ts        # contextBridge API (type-safe)
├── renderer/
│   ├── index.html / index.ts
│   ├── styles/           # CSS with design tokens + dark mode via prefers-color-scheme
│   ├── components/
│   │   ├── app.ts            # Root controller
│   │   ├── tab-bar.ts        # Tab headers (drag-to-reorder, ARIA, middle-click close)
│   │   ├── tab.ts            # Owns TerminalView + EditorInput (compose panel) per pane
│   │   ├── terminal-view.ts  # xterm.js wrapper (WebGL, fit, search, OSC 133, light/dark themes)
│   │   ├── editor-input.ts   # Compose panel (collapsed by default, Cmd+E to expand)
│   │   ├── search-overlay.ts # Cmd+F search with match count + animations
│   │   ├── settings-panel.ts # Settings UI + keyboard shortcuts reference
│   │   ├── command-palette.ts# Cmd+Shift+P searchable action list
│   │   ├── quick-terminal.ts # Drop-down terminal (quake-style)
│   │   ├── paste-dialog.ts   # Multi-line paste confirmation
│   │   ├── context-menu.ts   # Right-click context menu
│   │   └── onboarding.ts     # First-run welcome overlay
│   └── services/
│       ├── tab-manager.ts    # Tab lifecycle + switching + reorder + undo close
│       ├── history-manager.ts
│       └── keybinding-manager.ts
├── shared/
│   ├── constants.ts          # IPC channels, defaults
│   └── types.ts              # Shared types + PattonAPI declaration
└── resources/
    ├── shell-integration-zsh.zsh   # OSC 133 markers for zsh
    └── shell-integration-bash.sh   # OSC 133 markers for bash
```

## Input Model
- **xterm.js always owns keyboard input** — never disabled, never gated
- **Compose panel** = thin bar at bottom, expands on `Cmd+E` (or click)
- When compose panel is focused: user edits multi-line text, `Enter` sends to PTY, `Escape` dismisses
- When compose panel is not focused: terminal works exactly like iTerm2/Terminal.app
- **No mode detection, no mode switching** — all the complexity of ModeDetector was removed
- **OSC 133** (optional): shell integration scripts make the compose bar context-aware (green glow at prompts, dimmed during execution)

## Security Model
- `sandbox: true` on renderer
- PTY ownership validation on all IPC (write/resize/destroy/getProcess)
- Content Security Policy via `onHeadersReceived`
- Navigation blocked to external URLs, `window.open` denied
- Environment variables: allowlist only (HOME, PATH, LANG, USER, etc.)
- Shell paths: validated against allowlist of known shells
- Settings: type/range validated before persisting
- PTY rate limit: max 50 per window
- IPC rate limiting: sliding-window (5000/s PTY_WRITE, 10/s SETTINGS_SET)
- Encrypted store: machine-specific key via SHA-256(hostname+username)
- History auto-expiry: entries older than 90 days purged
- URL validation: WebLinksAddon only opens http/https
- Paste sanitization: strips control chars, confirms multi-line pastes
- Dependencies: pinned versions, production audit gate on build
- Self-signed code signing: stable identity for TCC persistence
- `[SECURITY]` logging on all validation/rate-limit/ownership failures

## Verifiers

```bash
# Full verification chain
npm run lint && npm run package

# Quick verification (lint only)
npm run lint

# Security audit (production deps)
npm audit --omit=dev --audit-level=high
```

## Commands
- `npm start` — dev mode with hot reload
- `npm run package` — build distributable
- `npm run make` — create installer

## Key Conventions
- All colors use CSS variables (`:root` + `@media prefers-color-scheme`)
- All interactive elements have ARIA attributes
- Resize observers are debounced (100ms)
- PTY data is write-coalesced (4ms buffer)
- electron-store needs CJS/ESM interop: `(mod.default || mod)`
- Entry files must match package.json `main` field naming (main.ts → main.js, preload.ts → preload.js)

---

## Status
Feature-complete, distributed. Public GitHub release with DMG installer.

## Last Session
**2026-03-09 (session 7)**
- Fixed 33 issues from debug scan (3 CRITICAL, 12 HIGH, 10 MEDIUM, 8 LOW): CWD validation, scrollback cap, session save resilience, double-submit race, memory leaks across 7 UI components (disposables pattern), ownership-before-rate-limit, store corruption recovery, SESSION_SET type guard, dead code removal
- Fixed notification sounds: bullet redesigned for laptop speakers, trigger wired to OSC 133 command-finished
- Fixed shell integration injection: replaced exec/ZDOTDIR approaches with simple PTY write after 500ms delay
- Compose panel hidden when collapsed (was showing thin bar)
- Cmd+W on last tab now closes app instead of opening new tab
- Created GitHub Release v1.0.0 with DMG: https://github.com/michaeljryoung/patton/releases/tag/v1.0.0
- Made repo public

## Next Steps
- [ ] Test all features in packaged app end-to-end
- [ ] Test DMG install on a clean machine (right-click → Open for Gatekeeper)
- [ ] Consider Apple Developer ID ($99/yr) for notarization if distributing widely

## Decisions
- **No App Sandbox**: Electron's multi-process Mach port IPC + node-pty shell spawning are fundamentally incompatible with `com.apple.security.app-sandbox`. Kept JIT + unsigned-memory entitlements only.
- **Self-signed cert ("Patton Dev Signing")**: Provides stable code identity hash for TCC permission persistence across rebuilds. Not Apple-trusted, so recipients must right-click → Open.
- **Audit gate scoped to production**: Dev dependency vulnerabilities (electron-forge toolchain) are build-time only and don't affect the distributed app. `--omit=dev` prevents false build failures.
- **Dependency pinning (no ^ or ~)**: Prevents surprise breakage from transitive updates in a desktop app where reproducibility matters more than auto-patching.
- **Shared HistoryManager**: One instance per TabManager, shared across all panes. Each pane's up/down cursor is independent (per-pane state), but the entry list and IPC load happen once. Avoids N IPC calls on restore.
- **Lazy ImageAddon via dynamic import**: `@xterm/addon-image` allocates a 16MB pixel buffer. Deferred via `import()` + `requestAnimationFrame` so first paint isn't blocked. If image protocol data arrives before load completes, it's benignly dropped (no crash).
- **Notification sounds synthesized, not files**: Web Audio API oscillators/noise buffers for all 3 sounds. No audio file dependencies, zero network, instant playback. Bullet = white noise crack + low-freq whoosh.
- **Undo close uses ring buffer, not stack**: Max 10 saved panes. Saves CWD + scrollback text + title. Reopened tabs show previous scrollback as dimmed text (`\x1b[2m`) to distinguish from new output.
- **Prompt jumping is heuristic + OSC 133**: Regex-based detection covers >95% of cases. OSC 133 shell integration provides precise prompt markers when available.
- **Quick terminal is lazy-initialized**: PTY only created on first show, not at app startup. Prevents wasted resources if user never uses it.
- **Always-passthrough over dual-mode**: The ModeDetector required 20+ bug-fix commits. Unreliable heuristics, focus management bugs, and two competing input targets are eliminated entirely. Terminal works like any native terminal; compose panel is purely additive.
- **Shell integration via PTY write**: After 500ms delay, writes ` source "/path/to/script" && clear\r` to PTY. Leading space avoids shell history, `clear` hides the command. Simpler and more reliable than exec/ZDOTDIR approaches which caused double-spawn or silent failures.
- **Startup command runs regardless of restore**: All restored PTYs are fresh shells (session restore only recovers tab layout + dimmed scrollback), so the startup command is always safe to inject.

## Gotchas
- **App Sandbox kills Electron**: `com.apple.security.app-sandbox` causes immediate crash with `FATAL:base/apple/mach_port_rendezvous_mac.cc` — Mach port bootstrap_check_in permission denied
- **Self-signed certs work unsigned**: macOS codesign accepts untrusted self-signed certs — they still produce stable identity hashes for TCC, just won't pass Gatekeeper without user override
- **`npm audit` blocks builds**: High-severity vulns in transitive devDeps (tar, tmp in electron-forge) fail `--audit-level=high`. Must use `--omit=dev` to scope to production deps
- **Electron 40 + TS 5.x**: Menu click handler receives `BaseWindow` not `BrowserWindow` — must cast to access `webContents`
- **ESLint 9 flat config**: Old `.eslintrc.json` format completely unsupported. `--ext` flag removed. Must use `eslint.config.mjs` with explicit globals
- **Settings panel IPC on open causes visible lag**: `await window.patton.settings.get()` in `show()` takes 50-100ms. Must cache settings in memory (loaded at startup, updated on every save) and make `show()` synchronous.
- **`npm start` changes don't affect `/Applications/Patton.app`**: Dev mode runs from source; the packaged app is a separate build. Always run `npm run package` after code changes to update the installed app.
