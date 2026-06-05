# Patton — Next Steps

Last updated: 2026-06-05 (Session 29)

CLAUDE.md's `## Next Steps` section points here; this is the canonical list. Items leave only via `[x] DONE — Session N`, `[~] SUPERSEDED — <pointer>`, or `[-] DROPPED: <reason>`. Marked items linger 10 checkpoints, then sweep to `docs/session-archive.md`.

---

## Live

- [ ] **Confirm the DOM/Compatibility renderer actually kills the glyphs over sustained use** (S29). User switched and said "seems to be working"; the old bug hit *loads*/session, so a full day+ of real use (esp. long Claude Code sessions + Cmd+Tab) with zero garbling = confident. If it holds → consider DOM as default vs leaving opt-in. If it STILL garbles on DOM → it's system-level (macOS 26.4.1 / M5 Pro Metal/CoreText), not Patton — reproduce in **Apple Terminal.app** (CoreGraphics, no Metal) to discriminate; `sudo atsutil databases -remove` + restart resets CoreText's glyph cache.
- [ ] **Dev-dependency CVE pass** (S29). 42 dev-only audit findings remain (webpack/inquirer/`tmp` via electron-forge tooling) — they don't ship in the app and don't block the `--omit=dev` build gate, so deferred to a deliberate dep-upgrade pass (risky major bumps). Prod `fast-uri` already patched via `overrides`. Continuation of the old "CVE scan of dep tree" blind-spot.
- [ ] **Revoke the burned `github_pat_` PAT** (security, S28). A fine-grained PAT was pasted into another chat transcript and is now on disk → revoke at https://github.com/settings/personal-access-tokens regardless of which token GitHub's expiry email named. User action only; nothing in Patton's auth path uses it (local push = gh keyring `gho_` OAuth, no expiry).
- [ ] **Validate the S24 double-click links in real use** (carried from S24/S27). Does `event.detail === 2` actually fire from xterm's link dispatch? First double-click on a path/URL/MD-link in the v1.4.0 build is the test. If double-click does nothing (xterm may collapse to detail=1), the fallback is a native `dblclick` listener on `terminal.element` hit-testing the active link range. See `src/renderer/services/file-link-provider.ts`.
- [ ] **`/mcp`-auth Enter unresponsiveness — watching brief** (S23). On next recurrence of any Claude Code blocking prompt where Enter appears dead: (1) press Ctrl+C — if it aborts, stdin is flowing, it's a Claude Code bug, stop here. (2) press any letter key — if nothing happens, it's Patton keystroke-delivery; add a dev-toggleable keystroke tracer to `terminal-view.ts` that file-logs every `onKey` event and repro. Notes in `~/.claude/plans/enchanted-sauteeing-moonbeam.md`.
- [ ] **Validate session 22 changes in real use** — Path A (command-done) verified live. Path B (Claude Code title prefix) and Path C (OSC 9) still need observation in everyday Claude Code workflow. Quit-confirmation dialog still needs a real-world trigger to confirm UX.
- [ ] **Validate session 20+21 changes in real use** — `patton-health` alias + file logger ready. Watch for: duplicate notifications firing (K3 regression), `safeStorage` migration failures, crash counter false-tripping, unexpected WebGL context-loss rate.

## Distribution / packaging

- [ ] Test CI-built DMG install on a clean machine (right-click → Open for Gatekeeper).
- [ ] Verify `brew tap michaeljryoung/patton && brew install --cask patton` installs latest (blocked until `HOMEBREW_PAT` refreshed — tap is stuck at v1.3.0).
- [ ] End-to-end test all features in packaged app.
- [ ] Consider Apple Developer ID ($99/yr) for notarization if distributing widely.

## Considered / low-priority

- [ ] **Refresh `HOMEBREW_PAT` if/when the brew channel is wanted again** (S28). It expired (set 2026-03-09) → the release workflow's cask-update step fails (the GitHub release + DMG are unaffected). Fix: generate a fine-grained PAT scoped to `homebrew-patton` (Contents: read/write), then `gh secret set HOMEBREW_PAT --repo michaeljryoung/patton`. User deprioritized brew, so no rush.
- [ ] **Harden `release.yml`'s `HOMEBREW_PAT` guard** (S28). `if [ -z "$HOMEBREW_PAT" ]` catches unset but not expired — an expired token fails the cask step (red ✗ on an otherwise-successful release) instead of skipping gracefully. Either test token validity before the clone, or accept the cosmetic red ✗.
- [ ] **Install the actual v1.4.0 DMG locally for a correct version string** (S28, cosmetic). The local `npm run package` build self-reports 1.0.0 though its code is byte-equivalent to v1.4.0. Reinstall the DMG from the release only if the version label matters.
- [ ] **Install VS Code for `:line:col` jump** — without it, file-path double-clicks fall through to `shell.openPath` (macOS default app). Opens but loses line/column. Most useful when Claude Code output has `path.ts:42` references.
- [ ] **Failed-command indicator variant** — OSC 133 `;D` carries an exit code; show a red dot variant on inactive tabs whose last command exited non-zero. Would need to plumb the exit code through `onPromptState` (currently emits state enum only) — more invasive than the green-dot impl.
- [ ] **Blind-spot passes** flagged by S20 reasoning synthesis (separate sessions): CVE scan of dep tree (Electron 40, xterm.js 6, node-pty, electron-store, codemirror) — **prod `fast-uri` patched S29; dev-tree scan still owed (see "Dev-dependency CVE pass" in Live)**; audit auto-release CI workflow + signing-key handling (highest-severity blind spot for self-signed distribution); empirical validation of K3/K5/S7 timing under real slow commands.

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

- [x] **DONE — Session 29**: **Shipped the renderer toggle → v1.5.0** (commit `6f9504f`) — persisted WebGL⇄DOM switch (command palette + Settings "Text Renderer"), the DOM-renderer escape hatch for glyph corruption (all panes + quick terminal, sticky across relaunches). `Patton-1.5.0-arm64.dmg` + GitHub release published; only the Homebrew-cask step failed (expired PAT).
- [x] **DONE — Session 29**: **Option+drag text selection** during mouse mode (`macOptionClickForcesSelection: true`) — previously no selection modifier worked on macOS while an app (Claude Code fullscreen, vim, tmux) held the mouse.
- [x] **DONE — Session 29**: **Diagnosed Claude Code v2.1.x fullscreen rendering** as the single cause of the selection breakage + "Jump to bottom" button + glyph-corruption recurrence. Disable via `/tui default` or `CLAUDE_CODE_DISABLE_MOUSE=1`.
- [x] **DONE — Session 29**: **`fast-uri` ^3.1.2 security pin** — closed the prod path-traversal advisory + unblocked the `npm audit` build gate (partial close of "CVE scan of dep tree").
- [x] **DONE — Session 28**: **Shipped v1.4.0** — pushed the 5 local commits (S25 `89404e4` + S27 `3cd768c` + 3 checkpoints); CI published the GitHub release + `Patton-1.4.0-arm64.dmg` + SHA-256. Only the Homebrew-cask step failed (expired `HOMEBREW_PAT`); the release is intact.
- [x] **DONE — Session 28**: **Validated S27 render defences** — user-confirmed zero garbled-glyph recurrence since ~2026-05-18; `main.log` shows the visibility/focus + periodic flushes firing 60k+ times, 10/10 context losses self-healed, 0 manual resets. Render-corruption saga (S24–S27) closed.
- [-] **DROPPED (S28): System-level font-cache reset** (was immediate-priority). It was the fallback for if S27 failed; S27 held (~2 weeks clean). The 2026-05-18 reboot may or may not have run `atsutil`, but it's moot. Discriminator recipe (Apple Terminal.app repro) preserved in CLAUDE.md Gotchas. WHY: S28 Decisions.
- [-] **DROPPED (S28): Phase 2 Canvas-renderer fallback.** Contingent on recurrence inside the flush window; the contingency never fired in ~2 weeks of validated use. Plan stub `~/.claude/plans/see-this-screenshot-that-smooth-cake.md` preserved if it ever returns. WHY: S28 Decisions.
- [x] **DONE — Session 27**: **Comprehensive S25-binary recurrence fix** (commit `3cd768c`). `backgroundThrottling: false` + `visibilitychange`+`window.focus` atlas-flush handlers + auto-reload-on-flush-error + periodic interval 10→2 min + renderer log bridge to `main.log` (closes S25-era observability gap) + `document.hidden`→`hasFocus` migration. ~186 LOC across 8 modified files + 1 new (`renderer-logger.ts`). Shipped to users in v1.4.0 (S28).
- [~] **SUPERSEDED — see S27 Decisions** (2026-05-07): Validate session 25 changes (atlas-eviction Phase 1) in real use. Bug recurred ~Apr 30 ON the S25 binary (multi times per session, triggered by Cmd+Tab). Saturation-only theory now known incomplete; S27 added the missing focus/refocus defences.
- [~] **SUPERSEDED — see S25 Decisions** (2026-04-27): Validate session 24 changes in real use. The (b) garbled-glyphs question is resolved (recurred → diagnosed → fixed via Phase 1 in S25). The (a) double-click question carries forward as a separate live item.
- [x] **DONE — Session 24**: **Render-corruption defensive hardening** (commit `968870e`, v1.3.0). WebGL atlas flushed on `setCustomTheme()`, public `resetRenderer()` + "Reset Renderer" command-palette entry, context-loss log upgraded with GPU vendor/renderer breadcrumbs.
- [x] **DONE — Session 24**: **Double-click link activation across URLs, paths, markdown** (commit `c19f1a4`, v1.2.0). WebLinksAddon + FileLinkProvider both gate on `event.detail === 2`. New MD_LINK_RE pass for `[text](path)` syntax.
- [x] **DONE — Session 24**: **Fix VS Code CLI ENOENT** (commit `3118108`, v1.1.21). Priority cascade: app-bundle CLI → `code` on PATH → `shell.openPath` fallback. No more silent ENOENT spam in `main.log`.
- [x] **DONE — Session 22**: **Confirm before quit when PTYs are alive** (commit `f600248`). Catches ⌘Q and close-last-window.
- [x] **DONE — Session 22**: **Tab "awaiting input" indicator** (iTerm-style dot) — shipped in S21, fully wired in S22 (S21 impl listened to the wrong signal and never fired in practice).
