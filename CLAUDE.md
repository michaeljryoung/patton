# Patton

Terminal wrapper that replaces readline input with a proper text editor (CodeMirror) while keeping all terminal functionality via automatic passthrough mode.

## Tech Stack
- **Electron** (v40) with Vite + TypeScript via Electron Forge
- **xterm.js** v6 (`@xterm/xterm`) — terminal rendering (WebGL addon)
- **node-pty** — PTY spawning in main process
- **CodeMirror 6** — input editor in renderer
- **electron-store** — persistent settings + history

## Architecture

```
src/
├── main/           # Electron main process
│   ├── main.ts           # App entry, lifecycle
│   ├── window-manager.ts # BrowserWindow + CSP + navigation guards
│   ├── pty-manager.ts    # PTY lifecycle, write-coalesce (4ms), env allowlist, shell validation
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
│   │   ├── tab.ts            # Owns TerminalView + EditorInput + ModeDetector per tab
│   │   ├── terminal-view.ts  # xterm.js wrapper (WebGL, fit, search, light/dark themes)
│   │   ├── editor-input.ts   # CodeMirror wrapper (keybindings, submit flash)
│   │   ├── search-overlay.ts # Cmd+F search with match count + animations
│   │   ├── settings-panel.ts # Settings UI + keyboard shortcuts reference
│   │   ├── command-palette.ts# Cmd+Shift+P searchable action list
│   │   ├── quick-terminal.ts # Drop-down terminal (quake-style)
│   │   ├── paste-dialog.ts   # Multi-line paste confirmation
│   │   ├── context-menu.ts   # Right-click context menu
│   │   └── onboarding.ts     # First-run welcome overlay
│   └── services/
│       ├── tab-manager.ts    # Tab lifecycle + switching + reorder + undo close
│       ├── mode-detector.ts  # Editor ↔ Passthrough auto-detection
│       ├── history-manager.ts
│       └── keybinding-manager.ts
└── shared/
    ├── constants.ts          # IPC channels, defaults, interactive programs list
    └── types.ts              # Shared types + PattonAPI declaration
```

## Dual Mode System
- **Editor Mode** — CodeMirror captures input, xterm.js is display-only
- **Passthrough Mode** — xterm.js captures input directly (vim, ssh, htop)
- **Editor bar stays visible in both modes** — in passthrough, it serves as a compose area (submit sends text to the running program via PTY). This preserves CodeMirror text editing when using Claude Code or other TUI programs.
- Amber accent bar indicates passthrough mode (blue = editor mode)
- Escape key in editor returns focus to terminal for TUI keyboard shortcuts
- Auto-detection: alternate screen buffer + TUI escape sequences (cursor hide, mouse enable, bracketed paste) + foreground process name polling (any non-shell foreground → passthrough)
- Manual toggle: `Ctrl+Shift+P`

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
Feature-complete with 10 UI/UX improvements, 19 themes, and performance optimizations. Builds and runs. Ready for distribution testing.

## Last Session
**2026-03-07 (session 3)**
- Implemented 10 UI/UX improvements inspired by Ghostty, focused on Claude Code users:
  1. **Split Zoom** (`Cmd+Shift+Enter`): Toggle focused pane to fullscreen within a tab
  2. **Command Palette** (`Cmd+Shift+P`): Searchable action list with fuzzy filtering, arrow keys, 20 actions
  3. **Undo Close Terminal** (`Cmd+Shift+T`): Ring buffer (max 10) saves CWD + scrollback + title, reopens as new tab with dimmed scrollback
  4. **Prompt Jumping** (`Cmd+Shift+Up/Down`): Heuristic prompt detection (regex matching $, %, >, #, ❯, ➜, λ, →, user@host) to navigate shell prompts in scrollback
  5. **Quick Terminal**: Drop-down quake-style terminal panel (50vh height, slides from top, own PTY, lazy init)
  6. **Background Opacity**: Settings slider (30-100%), `BrowserWindow.setOpacity()`, live preview
  7. **Synchronized Rendering**: Already working via `allowProposedApi: true` — no changes needed
  8. **Window Float on Top**: Checkbox in Window menu, `BrowserWindow.setAlwaysOnTop()`
  9. **CWD Inheritance**: New tabs/splits inherit CWD from focused pane
  10. **13 New Themes**: Catppuccin Mocha/Latte, Gruvbox Dark/Light, Rosé Pine/Dawn, Kanagawa, GitHub Dark/Light, Everforest Dark, Horizon, Ayu Dark/Light (19 total)

**2026-03-07 (session 2)**
- Added notification sound selection (Chime/Bugle/Bullet) with Web Audio API synthesis and settings dropdown with live preview
- Added startup command setting (runs on first tab of fresh launch only, not on session restore)
- Fixed settings panel dropdown disappearing (300ms focus poll in pane.ts was stealing focus — added `Pane.isOverlayFocused()` guard)
- Fixed settings panel speed (eliminated all IPC from `show()` — cached settings at startup, kept in sync via `saveAndNotify()`)
- Implemented 9 performance optimizations: shell path passed down (no per-pane IPC), shared HistoryManager, CWD/mode-detector polling gated on pane focus, parallelized startup (`Promise.all` for settings+history), parallelized pane init, `show:false` on BrowserWindow, lazy ImageAddon via dynamic import, CSS containment on `.pane`

## Next Steps
- [ ] Test all 10 new features in packaged app (split zoom, command palette, undo close, prompt jumping, quick terminal, opacity, float on top, CWD inheritance, themes)
- [ ] Run `npm run make` to generate .dmg for distribution
- [ ] Test DMG install on a clean machine (Gatekeeper: right-click → Open)
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
- **Prompt jumping is heuristic**: Regex-based detection of common prompt patterns ($, %, >, #, ❯, ➜, λ, →, user@host). Won't match every custom prompt but covers >95% of real-world cases.
- **Quick terminal is lazy-initialized**: PTY only created on first show, not at app startup. Prevents wasted resources if user never uses it.

## Gotchas
- **xterm.js onData must always forward to PTY**: In editor mode, `terminal.onData` only fires for terminal protocol responses (DSR, DA) since CodeMirror has focus. These MUST reach the PTY or programs like `fzf --height` will block forever waiting for cursor position reports. Never gate `onPassthroughData` forwarding on mode.
- **node-pty `proc.process` returns `undefined`**: On macOS, node-pty can't identify some foreground processes (fzf, certain child processes). Returns `undefined`, not empty string. ModeDetector uses `__unknown__` sentinel to trigger passthrough.
- **App Sandbox kills Electron**: `com.apple.security.app-sandbox` causes immediate crash with `FATAL:base/apple/mach_port_rendezvous_mac.cc` — Mach port bootstrap_check_in permission denied
- **Self-signed certs work unsigned**: macOS codesign accepts untrusted self-signed certs — they still produce stable identity hashes for TCC, just won't pass Gatekeeper without user override
- **`npm audit` blocks builds**: High-severity vulns in transitive devDeps (tar, tmp in electron-forge) fail `--audit-level=high`. Must use `--omit=dev` to scope to production deps
- **Electron 40 + TS 5.x**: Menu click handler receives `BaseWindow` not `BrowserWindow` — must cast to access `webContents`
- **ESLint 9 flat config**: Old `.eslintrc.json` format completely unsupported. `--ext` flag removed. Must use `eslint.config.mjs` with explicit globals
- **Focus poll steals from native `<select>` dropdowns**: The 300ms focus-protection poll in pane.ts grabs focus back to the editor textarea. Any overlay (settings, paste dialog, search) with native inputs must be guarded by `Pane.isOverlayFocused()` checking `document.activeElement.closest('[role="dialog"], .search-overlay, .paste-dialog-overlay')`.
- **Settings panel IPC on open causes visible lag**: `await window.patton.settings.get()` in `show()` takes 50-100ms. Must cache settings in memory (loaded at startup, updated on every save) and make `show()` synchronous.
