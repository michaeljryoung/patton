# Testing and checks

Read before writing or running a headless check of a renderer component. Moved word for word from CLAUDE.md's Gotchas (S46 slimming, 2026-11-08).

- **Renderer components can be checked headlessly in jsdom** (S41). Bundle the component with `node_modules/.bin/esbuild <entry> --bundle --format=cjs --platform=browser --loader:.css=empty`, set jsdom's window and document as globals with a stub `window.patton`, and dispatch events (drag events: a plain `Event` with `dataTransfer` and `clientY` defined on it). Install jsdom in the scratchpad, not the project. jsdom does no layout, so rect-based logic is only half-tested.
