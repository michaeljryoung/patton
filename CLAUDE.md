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
│   │   ├── paste-dialog.ts   # Multi-line paste confirmation
│   │   ├── context-menu.ts   # Right-click context menu
│   │   └── onboarding.ts     # First-run welcome overlay
│   └── services/
│       ├── tab-manager.ts    # Tab lifecycle + switching + reorder
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
- Auto-detection: alternate screen buffer + TUI escape sequences (cursor hide, mouse enable) + foreground process name polling (any non-shell foreground → passthrough)
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
Feature-complete with security hardening; builds and runs successfully. Ready for distribution testing.

## Last Session
**2026-03-06 (evening)**
- Fixed mode detection: added foreground-process polling to ModeDetector — auto-switches to passthrough when non-shell process is running (fixes arrow keys in Claude Code, fzf, etc.)
- Fixed all 12 ESLint errors (removed unused imports, replaced `any` types, fixed useless regex escapes, added targeted eslint-disable comments where needed)
- ModeDetector now learns the shell name on first poll, then switches to passthrough whenever a different process takes the foreground

## Next Steps
- [ ] Run `npm run make` to generate .dmg for distribution
- [ ] Test DMG install on a clean machine (Gatekeeper: right-click → Open)
- [ ] Consider Apple Developer ID ($99/yr) for notarization if distributing widely

## Decisions
- **No App Sandbox**: Electron's multi-process Mach port IPC + node-pty shell spawning are fundamentally incompatible with `com.apple.security.app-sandbox`. Kept JIT + unsigned-memory entitlements only.
- **Self-signed cert ("Patton Dev Signing")**: Provides stable code identity hash for TCC permission persistence across rebuilds. Not Apple-trusted, so recipients must right-click → Open.
- **Audit gate scoped to production**: Dev dependency vulnerabilities (electron-forge toolchain) are build-time only and don't affect the distributed app. `--omit=dev` prevents false build failures.
- **Dependency pinning (no ^ or ~)**: Prevents surprise breakage from transitive updates in a desktop app where reproducibility matters more than auto-patching.

## Gotchas
- **App Sandbox kills Electron**: `com.apple.security.app-sandbox` causes immediate crash with `FATAL:base/apple/mach_port_rendezvous_mac.cc` — Mach port bootstrap_check_in permission denied
- **Self-signed certs work unsigned**: macOS codesign accepts untrusted self-signed certs — they still produce stable identity hashes for TCC, just won't pass Gatekeeper without user override
- **`npm audit` blocks builds**: High-severity vulns in transitive devDeps (tar, tmp in electron-forge) fail `--audit-level=high`. Must use `--omit=dev` to scope to production deps
- **Electron 40 + TS 5.x**: Menu click handler receives `BaseWindow` not `BrowserWindow` — must cast to access `webContents`
- **ESLint 9 flat config**: Old `.eslintrc.json` format completely unsupported. `--ext` flag removed. Must use `eslint.config.mjs` with explicit globals
