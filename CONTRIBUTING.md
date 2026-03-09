# Contributing to Patton

Thanks for your interest in contributing to Patton!

## Getting Started

```bash
git clone https://github.com/michaeljryoung/patton.git
cd patton
npm install
npm start
```

This launches Patton in dev mode with hot reload.

## Development Commands

```bash
npm start        # Dev mode with hot reload
npm run package  # Build distributable (installs to /Applications)
npm run make     # Create DMG installer
npm run lint     # Run ESLint
```

## Making Changes

1. Fork the repo and create a branch from `main`
2. Make your changes
3. Run `npm run lint` to check for lint errors
4. Run `npm run package` to verify the build succeeds
5. Open a pull request

## Code Style

- TypeScript strict mode
- ESLint with `@typescript-eslint` rules (flat config)
- All colors use CSS custom properties (supports auto dark/light mode)
- All interactive elements should have ARIA attributes
- Resize observers are debounced (100ms)
- PTY data is write-coalesced (4ms buffer)

## Architecture Notes

- **Main process** (`src/main/`): PTY management, IPC routing, settings store, menus
- **Preload** (`src/preload/`): Type-safe contextBridge API — all renderer↔main communication goes through here
- **Renderer** (`src/renderer/`): UI components and services — no direct Node.js access
- **Shared** (`src/shared/`): IPC channel constants and TypeScript types used by both processes

The terminal is always in passthrough mode (xterm.js owns keyboard input). The compose panel (`Cmd+E`) is an additive overlay for drafting multi-line commands.

## Reporting Bugs

Open a [GitHub issue](https://github.com/michaeljryoung/patton/issues) with:

- macOS version and chip (Apple Silicon / Intel)
- Steps to reproduce
- Expected vs actual behavior
- Terminal output or screenshots if relevant

## Security Issues

See [SECURITY.md](SECURITY.md) for responsible disclosure instructions. Do not open public issues for security vulnerabilities.
