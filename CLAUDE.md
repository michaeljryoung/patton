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
**v1.33.0 released, not installed (S58, 2026-11-20 15:35):** one typing bar (v1.32.0): the compose box lies over Claude Code's own input bar, found from the screen, with pasted images inside it; v1.33.0 removes the Okay? button at Michael's word (a Claude Code `/ok` command, central-claude-md, replaces it); also a `composeOverBar` setting to switch the overlay off, and the terminal fit counting its padding (`docs/compose-box.md` D8–D14). Both releases green; cask 1.33.0 `516e7a08…` matches its DMG. /Applications is still 1.31.0 (S57). Next: install v1.33.0 on his word with Patton quit (hand-off in `docs/NEXT_STEPS.md`), then the live checks from main.log (`bar_ship`, `box_ship`, `groups_ship`, THE MAP's open nodes). Backlog: the typescript-eslint bump from 23 Nov (his `min-release-age`), S20 punch-list.

## Mission Synthesis
Patton is a macOS Electron terminal (xterm.js, node-pty) that closes the gaps Claude Code exposes in stock terminals: colour queries, contrast, attention signals, writing comfortably and finding your way across many parallel sessions. It ships as a DMG and a Homebrew cask, CI-versioned on every push to main (patch ≤500 lines, else minor); the no-release marker is read from the head commit's whole message alone and skips the entire push, so a code commit goes on top and builder commits are checked for a stray marker. He works inside the installed app, so code lives in `.worktrees/`, main moves by fast-forward, and an install waits for his word and for Patton to be quit: built from the tag in a scratch worktree, run from another terminal after stopping any crash reporter a quit Patton left running, and proven by the asar's mtime, codesign and Info.plist, never by running the binary. A pane's state comes from Claude Code's OSC 7501 reports, with the Stop hook and title glyphs as fallback: green needs him, the hollow ring waits on background work, yellow marks `wake`, red a finished checkpoint (`cpd`). Tabs open on a board of his projects, take their project or worktree's name and fold into ink-drawn groups. The compose box is always open under Claude tabs and, from v1.32.0, lies over Claude Code's own input bar so there is one place to type: Patton finds that bar on screen (the cursor parked on its `❯` line between two `─` rules), docks the box when he scrolls up, drops it under the terminal when the bar holds his own text or can't be recognised, hides it while 7501 reports a question, and never sends into one. Pasted images sit inside it; the Okay? button went in v1.33.0 at his word, replaced by a Claude Code `/ok` command. v1.33.0 is released, 1.31.0 installed. Next: the install, then the live checks from main.log. Lessons: record real screens and replay them before trusting a signal; sketch a screen first; settle the design before briefing builders, and settle each gap a builder finds in the design doc; a real-layout check written by an agent that didn't build catches what jsdom can't; fresh reviews with probes catch what builders miss.
## Session Log
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

### 2026-11-20 (Session 56 — v1.31.0 the always-open compose box; asar bump; map reality check; released not installed)
- Michael, on a Windows review recommending the desktop app's "proper compose box": "How do we get that?", then on a box opened by hand: "what's the point of one that I have to open manually … I don't know which prompt I'm going to need it for", then "ok" to an always-open box that steps aside when Claude asks (page https://claude.ai/code/artifact/503c49fd-8ae5-4501-be32-fe371f388337). Evidence: 6 Nov compose-first (main.log.1) had 25 click hand-offs and 20 reclaims in seven hours before going off; main.log 10–20 Nov holds 25 real question episodes, 3 under 0.1 s. Claude Code's Ctrl+G editor hand-off was probed (works on v2.1.321) and dropped as opened by hand.
- Built in worktrees: `eac1ef3` setting, `3a3094b` aside, menu and clicks, `ee2b218` file drop, `0465dab` replay check; review 1 (2 major) → `b7e0bac`, `03b1c02`; layout `6ef83af`; review 2 (1 major: Enter inside the 250 ms hold approved a prompt) → `2ebb0a7`, `0a7af2f` (broadcast skips a pane that's asking). `npm run check` 30/30 (`check-compose-box.mjs` 255, `check-file-drop.mjs` 48, `check-ui-text-scale.cjs` 210).
- Pushed `eef0399`; run 44728983899 green, v1.31.0, cask `65ad2b08…` matches the DMG. Not installed: he quits Patton and installs from Terminal.app (hand-off in `docs/NEXT_STEPS.md`).
- His "do 2 and 3 now": `@electron/asar` 4.3.2 (`2f83e1d`; audit 12 → 10, prod 0; typescript-eslint 8.73.0 waits on his `min-release-age` until 23 Nov). Reality check by a fresh auditor: done 25 → 30, none downgraded, 13 retired, `compose_box` pointer added, 11 open.
- My mistake: running `/Applications/Patton.app/Contents/MacOS/Patton --version` started a second Patton on his data, which died of EPIPE ("Patton fatal error"); his Patton untouched, its autosave rewrote `config.json` 30 s later; note in `docs/reference/build-and-install.md`.

### 2026-11-19 (Session 55 — v1.30.0 tab groups; released not installed)
- Michael: "something like Google Chrome's tab groups, so you can then group some of the tabs and minimize the group or something?", "and name group". A working sketch first (artifact: the strip in Patton's own styles, two looks); he answered "yes", "ink". Own map `docs/tab-groups.md` (five nodes would pass the main map's 40-node cap), pointer node `tab_groups`.
- Builder `e36f4f1` (model, session save and main's sanitiser, chip, fold, menus, hover list, `[GROUP]` logs) ran out of context before its checks; three fresh agents wrote `check-tab-groups.mjs` (187 after fixes), `check-tab-groups-strip.mjs` (105 after the first fixes, then drop and clamp checks) and 27 chip measures in `check-ui-text-scale.cjs`; every group check fails on the base; two strip bugs fixed in `ad4cb19`.
- Two fresh reviews, each cut off by context, together covered code, fixes and probes: 0 majors. Fixed: Move Left/Right take one step (`b5564f5`), discardTab into a folded group (`5c102b2`), a doubled window drag on a chip (`2001a64`), ⌘W answering Close Group (`77073ee`), palette numbering (`1cb8090`), the list clamp (`73487d4`, `58ec6eb`), a drop from another window moving this window's tab of the same id, older than groups (`7f092d8`). Two claims proved false; two nits left (chip role inside the tablist, a click lost across a rebuild).
- `npm run check` 28/28, lint, tsc, no-install asar 12:51; ff-merged and pushed `6a31a51`, run 44527919306 green, v1.30.0, cask `84fbe52e…` matches the DMG. Not installed: /Applications 1.26.1, untouched all session.

_Earlier entries archived → `docs/session-archive.md` (latest trim 2026-11-20, S58)._

## Decisions
- **2026-11-20 (S56, S58) — One always-open compose box, laid over Claude Code's own bar.** The box is always open under Claude tabs (S56, Michael: "I don't know which prompt I'm going to need it for") and follows 7501 `blocked` to step aside; from S58 it lies over Claude Code's bar, found on screen, because Claude Code can't hide its bar ("two typing bars … doesn't look very good"; sketch A). My calls: under the terminal whenever the bar holds his text or isn't recognised, so it never covers what it can't read; a 400 ms wait counted from the first miss, a 1.5 s window after the pane's own sends and Okay? asks, and at most one resize-causing move a second; `[Image #N]` counts as images; no × on chips in the box (the old × hid only the preview); `composeOverBar` (on) to switch it off. S56's calls (250 ms hold, 1 s typing grace, clicks keep the box's keyboard) stand; all in `docs/compose-box.md`.

_Older Decisions archived → `docs/session-archive.md` (latest move 2026-11-07, S44 slimming; the index of earlier trims is under its "Archive pointers moved from CLAUDE.md" heading)._

_Older entries archived → `docs/session-archive.md` (latest move 2026-11-20, S58)._

## Gotchas
- **Every commit on main reinstalls /Applications/Patton.app, and Michael works inside it** (S41). The post-commit hook runs `scripts/forge-package.sh`, whose postPackage `ditto`s over the running app (survivable, but not wanted mid-session). Do code in a `.worktrees/` worktree (the hook exits there), verify with `PATTON_NO_INSTALL=1 npm run package`, move main with `git merge --ff-only` (no post-commit), and commit on main itself only with `PATTON_NO_INSTALL=1` in the environment (the hook inherits it). That includes `/checkpoint`: run `checkpoint-commit.py` with `PATTON_NO_INSTALL=1` (S44: without it, the checkpoint commit reinstalled the app from main, which reported "1.15.1+1" until the tag was reinstalled).
- **Main's IPC rate limiters refuse silently, so a burst caller loses data** (S43). `pty:get-cwd` (10/s) answered `''` past the limit and autosave saved it, so panes past the tenth reopened in `~` (v1.13.2); `settings:set` (10/s) dropped the last step of a slider drag or a held arrow (v1.14). Space burst calls (autosave refreshes cwds 120 ms apart), debounce rapid saves, and never persist a refused answer over a known value.
- **electron-store fills `defaults` only at the top level** (S42). Patton's settings are one nested object, so a field added later is absent from every saved file: read it as `=== true` (off by default) or `!== false` (on by default), never bare.
- **A new per-pane setting must be applied in `Tab.createPaneInstance`, not only to existing panes** (S40). Until `8af2355`, `Tab.setFont/Scrollback/Theme/Renderer/CopyOnSelect` looped over `_panes`, so a split pane got none of them — on the default DOM renderer a split silently ran WebGL. The review of compose-first found it; keep the values on `Tab` and apply them at pane creation.
- **Renderer `console.*` calls don't reach `main.log` unless they go through `rlog()`** (S27). `src/main/logger.ts` only tees the main-process console. Any new `[RENDER]` or other diagnostic line you want in the file log MUST use `rlog()` from `src/renderer/services/renderer-logger.ts` — `console.info` alone reaches DevTools only and is invisible to packaged-app launches. This is exactly the gap that made S25's "is the periodic timer firing?" question unanswerable for ~10 days. `rlog()` keeps the DevTools console output too, so it's a strict superset of `console.*` for diagnostic purposes.
- **A linked worktree resolves to its main repo, so anything keyed by `project.root` is shared by the repo and every worktree** (S52). The tab-name store was: a name set from the LifeSci worktree's tab renamed `next-venture` and its Defence worktree too (fixed in v1.27.0 by keying on `worktree.path`). Before keying new per-project state on `root`, decide whether a worktree should share it.
- **A group's tabs are one unbroken run in `TabManager.tabs`, and tab ids are per-window counters** (S55). Every path that splices the tab order (createTab, reorder, drag, wake, discardTab, close, restore) must keep each group's run whole, through the helpers in `services/tab-groups.ts`. `tab-N` exists in every window, so a tab id arriving from outside the strip (drag data) is trusted only for a drag that began there (`draggedId`): before `7f092d8` a tab dragged in from another window moved this window's tab of the same id.
- **The first Stop after a /checkpoint is not its finish** (S54). Its turn can end parked on its own background job, or he interrupts it and talks about something else; anything meaning "checkpoint finished" keys on the hook's `cpd`, never `cpt` (its start) or the first Stop after it. Check such a signal against real transcripts and main.log, not only synthetic probes.
- **Anything that types into Claude gates on the live 7501 `blocked` fact, never a debounced copy** (S56). The compose box first held sends only once its 250 ms aside had begun, so an Enter in that gap approved the prompt's default option (second review, probe A1); broadcast had the same hole. Debounce what he sees, not what is sent.
- **The box finds Claude Code's bar on screen, so a Claude Code redesign of that bar quietly puts the box back under the terminal** (S58). `services/claude-bar.ts` needs the cursor's row to start with `❯` between two all-`─` rows; Claude's hint text is dim, his typed text is not. When the box stops covering the bar, `grep '\[COMPOSE\] bar not found' main.log` gives why (no-glyph, no-rule-above, no-rule-below); then re-record `scripts/fixtures/claude-bar-screens.json` from the new Claude Code (a pty capture with `--settings '{"disableAllHooks":true}'`; run from inside a Claude session, its transcripts stay off).
- **Fit the terminal through `services/terminal-fit.ts` (`fitGrid`), never `fitAddon.fit()`** (S58). The addon sizes from the container's computed size, which under `border-box` includes `.terminal-container`'s padding: at UI scale 1.5 the last row was cut by 2.4 px.


_Older Gotchas archived → `docs/session-archive.md` (latest move 2026-11-07, S44 slimming; the index of earlier trims is under its "Archive pointers moved from CLAUDE.md" heading)._

_Older entries archived → `docs/session-archive.md` (latest move 2026-11-14, S53)._

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
