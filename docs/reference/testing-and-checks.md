# Testing and checks

Read before writing or running a headless check of a renderer component. Moved word for word from CLAUDE.md's Gotchas (S46 slimming, 2026-11-08).

- **Renderer components can be checked headlessly in jsdom** (S41). Bundle the component with `node_modules/.bin/esbuild <entry> --bundle --format=cjs --platform=browser --loader:.css=empty`, set jsdom's window and document as globals with a stub `window.patton`, and dispatch events (drag events: a plain `Event` with `dataTransfer` and `clientY` defined on it). Install jsdom in the scratchpad, not the project. jsdom does no layout, so rect-based logic is only half-tested.
- **Where jsdom lives, and `node_modules` in a worktree** (S49; moved word for word from CLAUDE.md's Verifiers, S49 slimming). jsdom lives in a session scratchpad (S49 used `/private/tmp/claude-501/-Users-sparelaptop-Projects-betterterm/9465ed59-8ecb-4b39-9aa3-7c98657a3d46/scratchpad/jsdom`, 30.1.3); if it is gone, `npm i jsdom@30` in this session's scratchpad. A worktree gets `node_modules` by `cp -cR node_modules .worktrees/<name>/` (APFS clone, about 5 s), enough for lint, checks and a no-install package.
