# Patton — Next Steps

Last updated: 2026-05-07 (Session 27)

CLAUDE.md's `## Next Steps` section points here; this is the canonical list. Items leave only via `[x] DONE — Session N`, `[~] SUPERSEDED — <pointer>`, or `[-] DROPPED: <reason>`. Marked items linger 10 checkpoints, then sweep to `docs/session-archive.md`.

---

## Live

- [ ] **System-level font-cache reset (immediate priority — likely the actual fix).** User confirmed the garbled-glyph bug also reproduces in **iTerm2** late S27, suggesting the cause is not Patton-specific. User-level CoreText cache already cleared via `atsutil databases -remove`. Still to do: (1) `! sudo atsutil databases -remove` then restart Mac (rebuilds system-wide glyph cache); (2) reproduce check in Apple Terminal.app (CoreGraphics, no Metal — discriminates GPU vs font layer); (3) check macOS update history around ~Apr 30 when bug started; (4) report back whether the bug persists after restart. If it persists → Metal/GPU layer (Phase 2 Canvas renderer becomes more attractive). If it goes away → confirmed font-cache, document in Patton CLAUDE.md as a system-level recovery recipe.
- [ ] **Validate session 27 defences in real use, starting at the relaunch immediately following 2026-05-07.** Watch in `main.log`: (1) `[RENDERER] [RENDER] resume atlas flush` on every Cmd+Tab back to Patton (confirms visibility+focus handlers fired AND the new IPC log bridge is working — solves the S25-era observability gap); (2) `[RENDERER] [RENDER] periodic atlas flush` every 2 min/pane (timer alive); (3) zero `[RENDERER] [RENDER] WebGL context lost` lines (or if any, an immediate `WebGL renderer re-acquired after context loss` follow-up); (4) **no garbled-glyphs recurrence in normal use** — the load-bearing signal. If recurrence persists with `resume atlas flush` lines confirming the handler fired, the corruption is below xterm's WebGL addon (Chromium ANGLE/Metal or GPU driver state) and Phase 2 (Canvas renderer fallback) becomes the right escalation.
- [ ] **Push S25 + S27 commits to main when ready** — `89404e4` (S25 atlas-eviction fix) + `3cd768c` (S27 comprehensive fix). Triggers CI auto-release to GitHub releases + Homebrew tap. Local laptop already on S27 via `npm run package`; pushing only propagates to other machines.
- [ ] **Phase 2 escalation if needed: Canvas renderer fallback.** Add `@xterm/addon-canvas` dependency, settings toggle "Renderer: WebGL (default) / Canvas (safer, slower)". Canvas rasterizes per-frame with no glyph atlas — immune to this class of bug. Trade-off: ~3–5× slower frame rendering on heavy bursts, imperceptible at typical terminal load. Plan stub: `~/.claude/plans/see-this-screenshot-that-smooth-cake.md`.
- [ ] **Carried forward from S24**: does `event.detail === 2` actually fire from xterm's link dispatch? If double-click empirically does nothing (xterm may collapse to single-click activation with detail always 1), fallback is a native `dblclick` listener on `terminal.element` that hit-tests against the active link ranges. First post-S27-relaunch double-click on a path/URL is the test.
- [ ] **`/mcp`-auth Enter unresponsiveness — watching brief** (S23). On next recurrence of any Claude Code blocking prompt where Enter appears dead: (1) press Ctrl+C — if it aborts, stdin is flowing, it's a Claude Code bug, stop here. (2) press any letter key — if nothing happens, it's Patton keystroke-delivery; add a dev-toggleable keystroke tracer to `terminal-view.ts` that file-logs every `onKey` event and repro. Notes in `~/.claude/plans/enchanted-sauteeing-moonbeam.md`.
- [ ] **Validate session 22 changes in real use** — Path A (command-done) verified live. Path B (Claude Code title prefix) and Path C (OSC 9) still need observation in everyday Claude Code workflow. Quit-confirmation dialog still needs a real-world trigger to confirm UX.
- [ ] **Validate session 20+21 changes in real use** — `patton-health` alias + file logger ready. Watch for: duplicate notifications firing (K3 regression), `safeStorage` migration failures, crash counter false-tripping, unexpected WebGL context-loss rate.

## Distribution / packaging

- [ ] Test CI-built DMG install on a clean machine (right-click → Open for Gatekeeper).
- [ ] Verify `brew tap michaeljryoung/patton && brew install --cask patton` installs latest.
- [ ] End-to-end test all features in packaged app.
- [ ] Consider Apple Developer ID ($99/yr) for notarization if distributing widely.

## Considered / low-priority

- [ ] **Install VS Code for `:line:col` jump** — without it, file-path double-clicks fall through to `shell.openPath` (macOS default app). Opens but loses line/column. Most useful when Claude Code output has `path.ts:42` references.
- [ ] **Failed-command indicator variant** — OSC 133 `;D` carries an exit code; show a red dot variant on inactive tabs whose last command exited non-zero. Would need to plumb the exit code through `onPromptState` (currently emits state enum only) — more invasive than the green-dot impl.
- [ ] **Blind-spot passes** flagged by S20 reasoning synthesis (separate sessions): CVE scan of dep tree (Electron 40, xterm.js 6, node-pty, electron-store, codemirror); audit auto-release CI workflow + signing-key handling (highest-severity blind spot for self-signed distribution); empirical validation of K3/K5/S7 timing under real slow commands.

## Deferred from S20 punch list (`analysis/reasoning-modes/REPORT.md`)

- [ ] S9: remove CSP `style-src 'unsafe-inline'` (needs empirical test that xterm + CodeMirror still render).
- [ ] H1: test IME phantom composition with CJK input (requires CJK keyboard).
- [ ] H3: document cross-tab PTY access as an architectural choice.
- [ ] H4: OSC 7 CWD push to replace polling (requires shell-integration script edits).
- [ ] H6: refactor `swapPanes` to immutable (no confirmed aliasing bug — investigate first).
- [ ] H7: PTY ID counter overflow guard (purely theoretical at 9e15 creations).
- [ ] H10: per-window rate limiters keyed by `window.id` (substantial refactor).
- [ ] UX F5: shell setting as a dropdown from `ALLOWED_SHELLS` instead of text input.
- [ ] UX F6: stale-settings indicator ("applies to new tabs" badge).
- [ ] UX F7: diff-and-patch `tab-bar.ts` / `history-search.ts` instead of `innerHTML = ''` rebuilds.

## Deferred from S24 (`~/.claude/plans/see-the-screenshot-saved-glowing-kahn-findings-links.md`)

- [ ] OSC 8 hyperlink handler (explicit-hyperlink escape, no handler currently registered).
- [ ] Context-menu integration for links (right-click → "Open link" / "Copy path").
- [ ] `editorCommand` setting in AppSettings for vim/emacs/Sublime users.
- [ ] Hybrid UX: keep single-click for URLs, double-click for files (user picked unified double-click for now; revisit if muscle-memory friction surfaces).

---

## Recent transitions (visible 10 checkpoints, then archived)

- [x] **DONE — Session 27**: **Comprehensive S25-binary recurrence fix** (commit `3cd768c`). `backgroundThrottling: false` + `visibilitychange`+`window.focus` atlas-flush handlers + auto-reload-on-flush-error + periodic interval 10→2 min + renderer log bridge to `main.log` (closes S25-era observability gap) + `document.hidden`→`hasFocus` migration. ~186 LOC across 8 modified files + 1 new (`renderer-logger.ts`). Lint + package + asar verified.
- [~] **SUPERSEDED — see S27 Decisions** (2026-05-07): Validate session 25 changes (atlas-eviction Phase 1) in real use. Bug recurred ~Apr 30 ON the S25 binary (multi times per session, triggered by Cmd+Tab). Saturation-only theory now known incomplete; S27 added the missing focus/refocus defences. Validation clock restarts at S27 relaunch.
- [~] **SUPERSEDED — see S25 Decisions** (2026-04-27): Validate session 24 changes in real use. The (b) garbled-glyphs question is resolved (recurred → diagnosed → fixed via Phase 1 in S25). The (a) double-click `event.detail === 2` question carries forward as a separate live item.
- [x] **DONE — Session 24**: **Render-corruption defensive hardening** (commit `968870e`, v1.3.0). WebGL atlas flushed on `setCustomTheme()`, public `resetRenderer()` + "Reset Renderer" command-palette entry, context-loss log upgraded with GPU vendor/renderer breadcrumbs.
- [x] **DONE — Session 24**: **Double-click link activation across URLs, paths, markdown** (commit `c19f1a4`, v1.2.0). WebLinksAddon + FileLinkProvider both gate on `event.detail === 2`. New MD_LINK_RE pass for `[text](path)` syntax.
- [x] **DONE — Session 24**: **Fix VS Code CLI ENOENT** (commit `3118108`, v1.1.21). Priority cascade: app-bundle CLI → `code` on PATH → `shell.openPath` fallback. No more silent ENOENT spam in `main.log`.
- [x] **DONE — Session 22**: **Confirm before quit when PTYs are alive** (commit `f600248`). Catches ⌘Q and close-last-window.
- [x] **DONE — Session 22**: **Tab "awaiting input" indicator** (iTerm-style dot) — shipped in S21, fully wired in S22 (S21 impl listened to the wrong signal and never fired in practice).
