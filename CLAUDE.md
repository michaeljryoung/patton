# Patton

Always-passthrough terminal with a floating compose panel for drafting multi-line input.

## Tech Stack
- **Electron** (v44) with Vite 8 + TypeScript via Electron Forge (v8; needs Node 22.13+)
- **xterm.js** v6 (`@xterm/xterm`) — terminal rendering (WebGL addon)
- **node-pty** — PTY spawning in main process
- **electron-store** — persistent settings + history

## Architecture
The source tree (main, preload, renderer, shared, resources, scripts) is drawn in `docs/reference/key-files.md` § Source tree, beside where each feature lives.

## Commands
- `npm start` — dev mode with hot reload
- `npm run package` — prod-dependency audit, then build through `scripts/forge-package.sh`, which installs over `/Applications/Patton.app` (`PATTON_NO_INSTALL=1` builds without installing)
- `npm run install-app` — the same build and install, without the audit
- `npm run make` — create DMG installer
- `npm run lint` — ESLint; `npx tsc --noEmit` — type check
- `npm run audit` — the prod-dependency CVE gate on its own
- `npm run health` — `scripts/patton-health.sh` diagnostics
- `npm run release [-- patch|minor|major]` — manual release (CI handles this automatically)

## Verifiers

```bash
npm run lint && npx tsc --noEmit && JSDOM_DIR=<folder with jsdom ≥ 30> npm run check && PATTON_NO_INSTALL=1 npm run package
```
A build is proven by the asar's mtime, not the exit code (`docs/reference/build-and-install.md`: Forge exit codes). `npm run check` (`scripts/run-checks.sh`, S46) runs every `scripts/check-*` and says which it skipped; until S46 none ran anywhere, and `check-close-guard.mjs` sat broken on main unnoticed. Where jsdom lives and how a worktree gets `node_modules`: `docs/reference/testing-and-checks.md`.

## Key Conventions
- All colors use CSS variables (`:root` + `@media prefers-color-scheme`)
- All interactive elements have ARIA attributes
- Resize observers are debounced (100ms)
- PTY data is write-coalesced (4ms buffer)
- electron-store needs CJS/ESM interop: `(mod.default || mod)`
- Entry files must match package.json `main` field naming: Forge 8's Vite plugin emits `.vite/build/main.cjs` and `preload.cjs`, so `main` is `.vite/build/main.cjs` and `window-manager.ts` loads `preload.cjs`

---

## Status
**v1.36.0 released, not installed (S60, 2026-11-22):** the session bar (v1.35.0) with its review fixes, the calmer notification sound, the cleaner bookmarks bar and link logging (v1.36.0); long drafts make room below and Ctrl-U (v1.34.0), the Stop hook's ambient-task fix (v1.34.1); casks match. /Applications is still v1.33.0. Next: install on his word with Patton quit, then the live checks from main.log (`bar_ship` in `docs/session-bar.md`, `room_ship`, `bar_ship` and `box_ship` in `docs/compose-box.md`, `groups_ship`). The review tab is designed (`docs/review-tab.md`) and waits for his word. Backlog: the typescript-eslint bump from 23 Nov, S20 punch-list.

## Mission Synthesis
Patton is a macOS Electron terminal (xterm.js, node-pty) that closes the gaps Claude Code leaves in stock terminals: attention signals, writing comfortably, and finding your way across many parallel sessions. It ships as a DMG and a Homebrew cask, CI-versioned on every push to main; the no-release marker is read from the head commit alone. He works inside the installed app, so code lives in `.worktrees/`, main moves by fast-forward, and an install waits for his word with Patton quit, proven by the asar's mtime, codesign and Info.plist, never by running the binary. A pane's state comes from Claude Code's OSC 7501 reports, with the Stop hook as fallback. The compose box lies over Claude Code's own input bar, found on screen, and goes under the terminal when the bar holds his text or can't be read; a long draft now grows down while the terminal gives up rows, never over Claude's output. S60 added the session bar: a permanent right-hand panel on Claude tabs listing running agents, shells and monitors (live, from the session's transcript, which main follows), loops, failures, the links Claude gave him, and the checkpoint clock moved off the tab strip, with a ⇥ button to fold it. Everything through v1.36.0 is released but not installed; the next arcs are his install and the live checks, then the review tab he asked for (`docs/review-tab.md`: faithful, printable Word files, sent to Drive as Google Docs, comments reaching the file and Claude). Lessons: sketch the screen and settle the design before briefing builders; checks written by an agent that didn't build, and fresh reviews with probes, catch what builders miss; fix every finding, minors included, but keep the loop fast: targeted checks per fix, the full suite once, slices small enough that no builder runs out of room.
## Session Log
### 2026-11-22 (Session 60 — long drafts room below, Ctrl-U, the session bar, sound, bookmarks; v1.34.0 → v1.36.0 released, not installed)
- His /compact screenshot ("the text box has expanded and started covering over some of what Claude is doing"): he chose "Room made below" (D15 in `docs/compose-box.md`); Ctrl-U deletes the line (D16). A real-Claude probe showed a resize repaints only the visible screen. Three reviews; slow-redraw probes found a flap and four stale-row cases, fixed with a settling state. v1.34.0; the Stop hook's ambient-task label fix (Claude sends "auto-mode scan", "memory import") v1.34.1.
- His "bar on right ... like the desktop app": sketch v3 (https://claude.ai/code/artifact/08d6e409-4c7d-4f4e-8fe1-ceb84b75c586), his choices: permanent with a minimize button ("i hate hvaing to remember" shortcuts), no checklist (0 of 61 sessions kept one) or changes, links and failures in, the checkpoint clock moved in. Built from `docs/session-bar.md` (D1–D13) by three parallel builders, an end-to-end check by an agent that didn't build (57 ok), three reviews (no major); v1.35.0.
- Then his four asks: calmer sound (soft chime default, choice, Preview, volume); bookmarks show names only; artifact bookmarks named by id start, with web opens logged (cause of his "don't really work" not yet seen); Office files open from links. v1.36.0, cask `31e8b956…` matches. The document viewer: four options confused him ("all your options look the same"), so `docs/review-tab.md` records one design from his four needs; not built.
- His "This is taking a very long time" and "I think minor things are worth fixing": memory `patton-fix-minors-fast-loop`. About 2–3% of his week.

### 2026-11-20 (Session 59 — v1.33.0 installed)
- Patton quit 16:22:52 (main.log) and the session ran in iTerm; his "do the update etc". Its crash reporter had already exited. Built from the tag in `.worktrees/install-1.33.0` (`npm run package`, prod audit 0), installed 16:24:11: Info.plist 1.33.0, codesign ok, asar byte-identical to `out/`; the extracted asar holds `[COMPOSE] place`, `bar not found` and `composeOverBar` and no `[OKAY]`; worktree removed. `bar_ship` now live.
- The "etc": the installed Stop hook is byte-identical to v1.33.0's (no hook change since v1.31.0); cask 1.33.0 `516e7a08…` equals the release DMG's digest; release run green.
- main.log since the 11:55 v1.31.0 install: `[COMPOSE] aside` (blocked) then `back` (unblocked) 195 s later at 13:28:45, and an aside for a menu back 42 ms later at 15:36:40, partial `box_ship` evidence; `[GROUP]` 0 lines.
- The notes commit `2826d19`, made with `PATTON_NO_INSTALL=1`, set off the post-commit rebuild in the background; it built into `out/` only and /Applications stayed at 16:24:11.

### 2026-11-20 (Session 58 — v1.32.0 one typing bar: the box over Claude Code's own bar; released not installed)
- Michael on v1.31.0 (screenshots): "I think the OK button is now in the wrong place", "we now have two typing bars, which just doesn't look very good". Claude Code v2.1.321 has no setting, environment switch or terminal capability that hides its bar (read in the binary); a pty capture replayed through xterm showed it parks the cursor on its `❯` line between `─` rules after every redraw (22 of 26 bursts mid-turn, the rest mid-redraw). Sketch A–D (https://claude.ai/code/artifact/8bf5f5bc-0dab-4cab-afa2-cd9219a9f1a8, `docs/mocks/one-typing-bar.html`); he chose A ("ok"). Design D8–D14 and the part-2 nodes in `docs/compose-box.md`; recorded screens in `scripts/fixtures/claude-bar-screens.json`.
- Mid-build: "when i paste an image into the text bar it only appears above, have we sorted this": not sorted, and as built a pasted `[Image #2]` would have sent the box under; he chose thumbnails "Left of the text" (D14). "Are we going to have the option to toggle this off anyway?": the `composeOverBar` setting.
- Builders: `dbcb1e2` reader, `b24a8bf` placement and setting, `4b82876` hidden aside, Okay? in the box, sends that don't move it, `addcde0` Type here, `d8a0a22` images, `5924108` fit padding (found by `check-compose-over.cjs`, a real-layout check by an agent that didn't build: 327 ok, 231 fail on the base). Three fresh reviews: 0, 0 and 1 major (the 400 ms counted from the last match, so after a still screen one mid-redraw chunk moved the box at once), fixed in `e8baa66`, `dc204e2` with assertions failing before. `npm run check` 33/33.
- Pushed `18de10e`; run 44757794817 green, v1.32.0, cask `906e8a04…` matches the DMG. Not installed: /Applications 1.31.0, untouched all session. About 1% of his week.
- After the checkpoint, Michael: "lets remove the okay button, its annoying me and looks odd - can we actually make it a claude command /ok where it gives chat status, checks shells, monitors and reports ... needs to be lean". `07dd5f5` removes it (975 lines, its check deleted, four checks assert none exists); v1.33.0, cask `516e7a08…` matches the DMG. `/ok` is `central-claude-md/commands/ok.md` (`2775fd2`, linked into `~/.claude/commands/`): cheap checks of the session's shells, agents, monitors and CI, an answer-first report, no new work; smoke-tested headless.

### 2026-11-20 (Session 57 — v1.31.0 installed; Homebrew, release and Stop hook checked)
- Patton quit 11:53:22 and the session ran in iTerm; his "Install v1.31.0 now". Stopped the 13 Nov crash reporter (pid 96466) still running out of /Applications, built from the tag in `.worktrees/install-1.31.0` (`npm run package`, prod audit 0), installed 11:55:30: Info.plist 1.31.0, codesign ok, file list identical to `out/`, `[COMPOSE] aside`, `[GROUP]`, `[OKAY]` and `cpd` in the bundle; worktree removed. `box_ship` and `groups_ship` now live.
- His "You sure everything's updated, Homebrew, etc.?": the tap's cask reads 1.31.0 with sha `65ad2b08…`, the release DMG's digest; every step of run 44728983899 succeeded; brew doesn't manage this Mac's copy; main past the tag holds notes and a dev-only lockfile. The Stop hook in userData was the copy shipped v1.14–v1.28: refreshed by hand to v1.31.0's at 12:03, probe passed.
- My mistakes: I told him Patton refreshes the hook only when Settings opens, having read the Settings path first; `ipc-handlers.ts` refreshes it at every packaged launch (since `ec60a3e`, 7 Nov), corrected in the same reply. And `npx asar extract-file` from the scratch worktree overwrote its `package.json` (as in S43 and S45); the worktree was removed, nothing real changed, and `docs/reference/build-and-install.md` now says to extract the whole asar into a scratch folder.

_Earlier entries archived → `docs/session-archive.md` (latest trim 2026-11-22, S60)._

## Decisions
- **2026-11-22 (S60) — The session bar reads the session's own transcript; no second hook.** Claude Code's 7501 carries agents but never shells, monitors or loops, and the Stop hook only speaks at turn end, so main maps a pane to its Claude process (`~/.claude/sessions/<pid>.json`) and follows its transcript (`src/main/session-*.ts`, `transcript-*.ts`); the Stop hook's `tl`/`cl` lists reconcile at each Stop, and a cut list ends nothing. The PostToolUse hook he agreed to was not needed. Office files (.docx/.xlsx/.pptx) open from links; macro-enabled ones are only revealed. All in `docs/session-bar.md`.

_Older Decisions archived → `docs/session-archive.md` (latest move 2026-11-07, S44 slimming; the index of earlier trims is under its "Archive pointers moved from CLAUDE.md" heading)._

_Older entries archived → `docs/session-archive.md` (latest move 2026-11-22, S60)._

## Gotchas
- **Every commit on main reinstalls /Applications/Patton.app, and Michael works inside it** (S41). The post-commit hook runs `scripts/forge-package.sh`, whose postPackage `ditto`s over the running app (survivable, but not wanted mid-session). Do code in a `.worktrees/` worktree (the hook exits there), verify with `PATTON_NO_INSTALL=1 npm run package`, move main with `git merge --ff-only` (no post-commit), and commit on main itself only with `PATTON_NO_INSTALL=1` in the environment (the hook inherits it). That includes `/checkpoint`: run `checkpoint-commit.py` with `PATTON_NO_INSTALL=1` (S44: without it, the checkpoint commit reinstalled the app from main, which reported "1.15.1+1" until the tag was reinstalled).
- **Main's IPC rate limiters refuse silently, so a burst caller loses data** (S43). `pty:get-cwd` (10/s) answered `''` past the limit and autosave saved it, so panes past the tenth reopened in `~` (v1.13.2); `settings:set` (10/s) dropped the last step of a slider drag or a held arrow (v1.14). Space burst calls (autosave refreshes cwds 120 ms apart), debounce rapid saves, and never persist a refused answer over a known value.
- **electron-store fills `defaults` only at the top level** (S42). Patton's settings are one nested object, so a field added later is absent from every saved file: read it as `=== true` (off by default) or `!== false` (on by default), never bare.
- **A new per-pane setting must be applied in `Tab.createPaneInstance`, not only to existing panes** (S40). Until `8af2355`, `Tab.setFont/Scrollback/Theme/Renderer/CopyOnSelect` looped over `_panes`, so a split pane got none of them — on the default DOM renderer a split silently ran WebGL. The review of compose-first found it; keep the values on `Tab` and apply them at pane creation.
- **Renderer `console.*` calls don't reach `main.log` unless they go through `rlog()`** (S27). `src/main/logger.ts` only tees the main-process console. Any new `[RENDER]` or other diagnostic line you want in the file log MUST use `rlog()` from `src/renderer/services/renderer-logger.ts` — `console.info` alone reaches DevTools only and is invisible to packaged-app launches. This is exactly the gap that made S25's "is the periodic timer firing?" question unanswerable for ~10 days. `rlog()` keeps the DevTools console output too, so it's a strict superset of `console.*` for diagnostic purposes.
- **A group's tabs are one unbroken run in `TabManager.tabs`, and tab ids are per-window counters** (S55). Every path that splices the tab order (createTab, reorder, drag, wake, discardTab, close, restore) must keep each group's run whole, through the helpers in `services/tab-groups.ts`. `tab-N` exists in every window, so a tab id arriving from outside the strip (drag data) is trusted only for a drag that began there (`draggedId`): before `7f092d8` a tab dragged in from another window moved this window's tab of the same id.
- **Anything that types into Claude gates on the live 7501 `blocked` fact, never a debounced copy** (S56). The compose box first held sends only once its 250 ms aside had begun, so an Enter in that gap approved the prompt's default option (second review, probe A1); broadcast had the same hole. Debounce what he sees, not what is sent.
- **The box finds Claude Code's bar on screen, so a Claude Code redesign of that bar quietly puts the box back under the terminal** (S58). `services/claude-bar.ts` needs the cursor's row to start with `❯` between two all-`─` rows; Claude's hint text is dim, his typed text is not. When the box stops covering the bar, `grep '\[COMPOSE\] bar not found' main.log` gives why (no-glyph, no-rule-above, no-rule-below); then re-record `scripts/fixtures/claude-bar-screens.json` from the new Claude Code (a pty capture with `--settings '{"disableAllHooks":true}'`; run from inside a Claude session, its transcripts stay off).
- **After Patton resizes a terminal, Claude's bar is unreadable until Claude redraws** (S60). xterm's shrink drops the lines below the cursor first, which takes Claude's lower rule and footer; Claude repaints only the visible screen on any resize. Anything keyed on the bar's row waits for the first fresh reading after Patton's own resize (the compose box's "settling", D15), never for a fixed delay.
- **A hook's `terminalSequence` over 4096 bytes is dropped whole by Claude Code** (S60, read in 2.1.321). The Stop hook keeps its sequence under 3,500 by cutting its lists, never the sequence; a renderer that reads a list must treat a short one (fewer items than `tasks`) as cut.
- **Fit the terminal through `services/terminal-fit.ts` (`fitGrid`), never `fitAddon.fit()`** (S58). The addon sizes from the container's computed size, which under `border-box` includes `.terminal-container`'s padding: at UI scale 1.5 the last row was cut by 2.4 px.


_Older Gotchas archived → `docs/session-archive.md` (latest move 2026-11-07, S44 slimming; the index of earlier trims is under its "Archive pointers moved from CLAUDE.md" heading)._

_Older entries archived → `docs/session-archive.md` (latest move 2026-11-22, S60)._

## Reference docs
Topic files, read only when the task needs them (moved word for word from Gotchas and Key Files, S44 and S46 slimming):
- `docs/reference/homebrew-tap.md` — the cask template, the tap's deploy key, the manual fallback. Read when the release's Homebrew step fails or a cask needs fixing.
- `docs/reference/xterm-internals.md` — xterm.js swallowing paste events and firing the key handler twice. Read before touching paste, key handling or any listener on the terminal's DOM.
- `docs/reference/upgrades.md` — npm 12's install-script approval and Electron 42+ changes. Read before adding or bumping a dependency (native ones above all) or upgrading npm or Electron.
- `docs/reference/build-and-install.md` — Forge exit codes, GitHub 504s, the CVE gate, hot-swap, reading the asar, launching an untried build as "Patton Test" (a second Patton shares the real one's userData). Read before building, packaging, installing or launching a build, or when a build or release step fails.
- `docs/reference/claude-state-and-links.md` — OSC 7501 probe, file-link policy, the `cc` startup command, OSC 133. Read before touching Claude state detection, file links, bookmark launch or the startup command.
- `docs/reference/fonts-and-rendering.md` — why 'SF Mono' never drew; `backgroundThrottling` and `document.hidden`. Read before touching fonts or any "is the window in view?" test.
- `docs/reference/testing-and-checks.md` — headless jsdom checks of renderer components. Read before writing one.
- `docs/reference/key-files.md` — where each feature lives, with its check scripts. Read to find the code for a feature.

## Key Files
Moved to `docs/reference/key-files.md` (S46 slimming): read it to find where a feature lives.

## Next Steps
See `docs/NEXT_STEPS.md`.
