# Patton

A modern terminal emulator for macOS with split panes, tabs, a compose panel for drafting multi-line input, and 19 color themes. Built for developers who use Claude Code and other CLI tools.

## Download

**[Download Patton v1.0.0 (DMG, Apple Silicon)](https://github.com/michaeljryoung/patton/releases/download/v1.0.0/Patton-1.0.0-arm64.dmg)**

> Patton is self-signed (not notarized by Apple). See [macOS Gatekeeper](#macos-gatekeeper) below for first-launch instructions.

### Install via Homebrew

```bash
brew tap michaeljryoung/patton
brew install --cask patton
```

Homebrew automatically clears the quarantine flag — no Gatekeeper workaround needed.

## macOS Gatekeeper

Since Patton is self-signed, macOS will block it on first launch. Choose one of these methods:

**Method 1: Right-click to open (easiest)**

1. Right-click `Patton.app` in Finder
2. Select **Open**
3. Click **Open** in the dialog

This only needs to be done once.

**Method 2: Remove quarantine flag**

```bash
xattr -cr /Applications/Patton.app
```

Then open the app normally. This clears the macOS quarantine attribute entirely.

**Method 3: System Settings**

1. Try to open Patton normally (it will be blocked)
2. Go to **System Settings > Privacy & Security**
3. Scroll down — you'll see "Patton was blocked"
4. Click **Open Anyway**

## Features

- **Always-Passthrough Terminal** -- Full terminal input at all times (xterm.js), no mode switching
- **Compose Panel** -- Expandable multi-line editor for drafting commands (`Cmd+E`)
- **Split Panes** -- Vertical and horizontal splits with drag-to-resize dividers (up to 5 per tab)
- **Tabs** -- Drag-to-reorder, middle-click close, tab renaming
- **Command Palette** -- Quick access to all actions via fuzzy search (`Cmd+Shift+P`)
- **Quick Terminal** -- Drop-down terminal panel that slides from the top of the window
- **Prompt Jumping** -- Navigate between shell prompts in scrollback (`Cmd+Shift+Up/Down`)
- **Split Zoom** -- Toggle focused pane to fullscreen within a tab (`Cmd+Shift+Enter`)
- **Undo Close** -- Reopen recently closed terminals with CWD and scrollback restored (`Cmd+Shift+T`)
- **19 Color Themes** -- Dracula, Nord, Solarized, One Dark, Monokai, Tokyo Night, Catppuccin, Gruvbox, Kanagawa, GitHub, Everforest, Horizon, Ayu, and more
- **Window Opacity** -- Adjustable transparency (30-100%)
- **Notification Sounds** -- Configurable alert when long-running commands finish
- **Startup Command** -- Auto-run a command on launch (e.g., `claude`)
- **Session Restore** -- Tabs, splits, and CWD are restored on restart
- **Find** -- In-terminal search with match highlighting (`Cmd+F`)
- **Copy on Select** -- Optional auto-copy to clipboard
- **CWD Inheritance** -- New tabs and splits inherit the current directory
- **Shell Integration** -- Optional OSC 133 prompt markers for zsh and bash

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Cmd+T` | New tab |
| `Cmd+W` | Close pane / tab |
| `Cmd+D` | Split pane right |
| `Cmd+Shift+D` | Split pane down |
| `Cmd+Opt+Arrow` | Navigate between panes |
| `Cmd+Shift+Enter` | Zoom split pane |
| `Cmd+Shift+T` | Reopen closed tab |
| `Cmd+Shift+P` | Command palette |
| `Cmd+Shift+Up/Down` | Jump between prompts |
| `Cmd+E` | Toggle compose panel |
| `Cmd+K` | Clear terminal |
| `Cmd+F` | Find |
| `Cmd+,` | Settings |
| `Cmd+=` / `Cmd+-` | Font size up / down |
| `Ctrl+R` | History search |

## Installation

### Download DMG

Grab the latest release from the [Releases page](https://github.com/michaeljryoung/patton/releases). Open the DMG, drag Patton to Applications, then follow the [Gatekeeper instructions](#macos-gatekeeper) above.

### Build from Source

**Prerequisites:** macOS, [Node.js](https://nodejs.org/) v20+, npm v10+

```bash
git clone https://github.com/michaeljryoung/patton.git
cd patton
npm install
npm run package
```

The packaged app will be installed to `/Applications/Patton.app`.

To create a DMG installer:

```bash
npm run make
```

### Verify Download (optional)

After downloading the DMG, you can verify its integrity:

```bash
shasum -a 256 Patton-1.0.0-arm64.dmg
```

Expected: `2b7bbf37319366faf78c909972b10ca889c0b99295c8ead48e1f75ac13527837`

## Development

```bash
npm start        # Dev mode with hot reload
npm run package  # Build distributable
npm run make     # Create DMG installer
npm run lint     # Run ESLint
```

## Tech Stack

- [Electron](https://www.electronjs.org/) v40
- [xterm.js](https://xtermjs.org/) v6 with WebGL rendering
- [node-pty](https://github.com/microsoft/node-pty) for PTY management
- [electron-store](https://github.com/sindresorhus/electron-store) for persistent settings
- TypeScript + Vite via [Electron Forge](https://www.electronforge.io/)

## Architecture

```
src/
├── main/           # Electron main process (PTY, IPC, menus, settings store)
├── preload/        # contextBridge API (type-safe IPC bridge)
├── renderer/       # UI components, services, styles
│   ├── components/ # Tab, Terminal, Compose Panel, Settings, Command Palette, etc.
│   ├── services/   # Tab manager, history, keybindings
│   └── styles/     # CSS with design tokens + auto dark/light mode
└── shared/         # IPC channel constants + shared TypeScript types
```

## Security

See [SECURITY.md](SECURITY.md) for the security model and how to report vulnerabilities.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
