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
