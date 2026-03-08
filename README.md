# Patton

A modern terminal emulator for macOS that replaces readline input with a proper text editor (CodeMirror) while keeping all terminal functionality via automatic passthrough mode. Built for developers who use Claude Code and other CLI tools that benefit from rich text editing.

## Features

- **Dual Mode System** -- Automatically switches between a full CodeMirror editor and raw terminal passthrough based on what's running (vim, ssh, htop, Claude Code)
- **Split Panes** -- Vertical and horizontal splits with drag-to-resize dividers
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
| `Cmd+K` | Clear terminal |
| `Cmd+F` | Find |
| `Cmd+,` | Settings |
| `Cmd+=` / `Cmd+-` | Font size up / down |
| `Ctrl+Shift+P` | Toggle passthrough mode |
| `Ctrl+R` | History search |

## Installation

### Prerequisites

- macOS (Apple Silicon or Intel)
- [Node.js](https://nodejs.org/) v20+
- npm v10+

### Build from Source

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

### macOS Gatekeeper

Since Patton is self-signed, macOS will block it on first launch. To open it:

1. Right-click `Patton.app` in Finder
2. Select **Open**
3. Click **Open** in the dialog

This only needs to be done once.

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
- [CodeMirror](https://codemirror.net/) 6
- [node-pty](https://github.com/niccholas/node-pty) for PTY management
- [electron-store](https://github.com/niccholas/electron-store) for persistent settings
- TypeScript + Vite via [Electron Forge](https://www.electronforge.io/)

## Architecture

```
src/
├── main/           # Electron main process (PTY, IPC, menus, settings store)
├── preload/        # contextBridge API (type-safe IPC bridge)
├── renderer/       # UI components, services, styles
│   ├── components/ # Tab, Pane, Editor, Terminal, Settings, Command Palette, etc.
│   ├── services/   # Tab manager, mode detector, history, keybindings
│   └── styles/     # CSS with design tokens + auto dark/light mode
└── shared/         # IPC channel constants + shared TypeScript types
```

## License

[MIT](LICENSE)
