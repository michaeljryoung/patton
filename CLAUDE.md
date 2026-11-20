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
**v1.31.0 released (S56) and installed (S57, 2026-11-20 11:55, from the tag with Patton quit; codesign ok):** an always-open compose box under Claude tabs that steps aside while Claude Code reports a question or after his own `/` command, and keeps the keyboard through clicks into the terminal; dropped files add their paths (own map `docs/compose-box.md`; run 44728983899 green, cask `65ad2b08…` matches the DMG). v1.30.0 (S55): Chrome-style tab groups, named and folded to one chip, in ink (own map `docs/tab-groups.md`; run 44527919306 green, cask `84fbe52e…` matches the DMG). v1.29.0 (S54) made the red checkpoint circle rise when a checkpoint finishes (`ckpt_finished`), and v1.28.0 added an "Okay?" row under each Claude pane (`okay_button`). /Applications runs v1.31.0, so v1.27–v1.31 are live from his next launch, which also refreshes the installed Stop hook. Next: the live checks, read from main.log once he has worked in it: `box_ship`, `groups_ship` and THE MAP's open nodes (S56 reality check: 11 open). Backlog: the typescript-eslint bump from 23 Nov (his `min-release-age`), S20 punch-list.

## Mission Synthesis
Patton is a macOS Electron terminal (xterm.js, node-pty) that closes the gaps Claude Code exposes in stock terminals: colour queries, contrast, attention signals, writing comfortably and finding your way across many parallel sessions. It ships as a DMG and a Homebrew cask, CI-versioned on every push to main (patch ≤500 lines, else minor); the no-release marker is read from the head commit's whole message alone and skips the entire push, so a code commit goes on top and builder commits are checked for a stray marker. v1.31.0 (Electron 44.9.3, Forge 8) is released and installed; an install needs Patton quit, so it runs from a Terminal.app session built from the tag, and the installed binary is never run for its version (that starts a second Patton on his data). A pane's state comes from Claude Code's OSC 7501 reports, with the Stop hook and title glyphs as fallback: green needs him, the hollow ring waits on background work, yellow marks `wake`, red marks a checkpoint that finished (the hook's `cpd`, never its start). Every new tab opens on a board of his projects; tabs are named for their project or worktree, fill the strip, and fold into ink-drawn groups, colour kept for status alone. Since v1.31 an always-open compose box sits under Claude tabs: it steps aside while 7501 reports a question (after 250 ms, keeping his keys until he pauses) or after his own `/` command, never sends into a question, and keeps the keyboard through clicks; the 6 Nov compose-first failed because it had no question signal. Pause all, Okay? and the box type into Claude only on an allowlist of states. He works inside the installed app, so code lives in `.worktrees/` and installs wait for his word. Next: the live checks (`box_ship`, `groups_ship`, the map's 11 open), typescript-eslint from 23 Nov. Lessons: measure main.log and replay real sequences before trusting a signal; sketch a screen first; settle the design before briefing builders and split big jobs; two fresh reviews with probes caught majors the builders missed.
## Session Log
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

### 2026-11-18 (Session 54 — v1.28.0 the Okay? button, v1.29.0 the checkpoint circle on finish; released not installed)
- Michael: "Quite often, I find myself wanting to ask a project, 'Is everything going okay?' ... a button in the bottom left"; he chose a row of its own under the terminal over floating on the corner. `ac3a663` + review fixes `553f2d7` (a board respawn kept the old Claude state, so a click could type into a fresh zsh; an unhandled rejection; a double resize; overflow in a narrow pane; row 24.8 → 19.5 px at UI scale 1.1); `check-okay-button.mjs` 66. v1.28.0, run 44303425373, cask `64f60aba…`.
- Michael: "the red dot for checkpointing isn't working very well. Sometimes it's going green rather than red, and other times it's going red when it hasn't checkpointed." Cause, from main.log and his transcripts (every checkpoint since 13 Nov): the mark was keyed to the checkpoint's start and rose at the first Stop after it. A turn parked on its own background job (13 Nov 10:39, 16 Nov 08:08) or an interrupted checkpoint (13 Nov 18:34) went red early, and once he had looked, the real finish carried the same start and showed green (13 Nov: red 10:39, selected 10:40, commit 10:42, green).
- Fix: the hook adds `cpd` (finished: a Stop with no task in flight; a checkpoint cut off by an interrupt in its own turn counts only after a commit step that succeeded), the clock's baseline skips cut-off checkpoints, `[CKPT] finish held` logs a wait. `dfff66b`, `561820e`, `00f8b0f`, review fixes `f70b74c` (a refused or failed commit counted as the rescue). Three real sessions replayed right; 0 of 340 real checkpoints otherwise change; hook ~263 ms on a 100 MB transcript. v1.29.0: attempt 1 cancelled after 15 min with no macOS runner free, re-run green (run 44312988584), cask `4715bec6…`.
- main.log 14–18 Nov into `s49_ship`: Pause all pressed once on v1.26.1 (16 Nov 16:40: 5 sent, 4 queued, the shell skipped). Not installed: no install word this session. This checkpoint was interrupted by the bug report and ran after v1.29.0; its size pass moved the S49 (continued) entry and the S52/S53 decisions to the archive.

### 2026-11-14 (Session 53 — v1.27.2: tabs share the whole strip; released not installed)
- Michael (screenshot of six short tabs, half the strip empty): "When there are fewer tabs than fill the whole bar, could we make them wider? ... they use up the full width and then compress as you get more." `9dd74aa`: tabs grow from their label's width by an equal share of the free room (the 220 px tab cap gone), names centred, a double-click anywhere on a tab renames it.
- Fresh Sonnet review: approve, but a 60-character name squeezed all 12 other tabs, a press-again-and-drag ended in a rename box, and a doc went stale. Fix builder `7cb927e`: label capped at 196 px, `dragMoved` guard, stronger centring check; every new check fails on the old code. `npm run check` 25/25 (`check-ui-text-scale.cjs` 141).
- Pushed; run 43581526879 green, v1.27.2, cask `d1c2094f…` matches the DMG. Not installed: he works inside v1.26.1.
- main.log since the v1.26.1 launch written into `s49_ship`: 21 thumbnails cleared on Enter, 2 title-bar zooms, 17 checkpoint marks cleared on select, 20 tab close confirms; Pause all unpressed since.
- A no-install package build in the worktree rewrote `index.html` and broke the next build (note in `docs/reference/build-and-install.md`, cause not traced); worktree and branch removed after the release.

_Earlier entries archived → `docs/session-archive.md` (latest trim 2026-11-20, S56)._

## Decisions
- **2026-11-20 (S56) — The compose box is always open and follows Claude Code's own question reports.** Michael rejected a box opened by hand (the Ctrl+G route): "I don't know which prompt I'm going to need it for". The 6 Nov compose-first guessed from title glyphs; 7501 `blocked` now says when Claude asks. My calls: a 250 ms hold before stepping aside (3 of 25 real questions lasted under 0.1 s); his typing keeps the keyboard until a 1 s pause, at most 3 s; sends and key forwarding refused from Claude's first question report; the note sits in the Send slot so the terminal never resizes; a new `composeBox` setting (on) so his 6 Nov "off" did not carry over; clicks into the terminal keep the box's keyboard on 7501 panes; broadcast skips a pane that's asking.
- **2026-11-19 (S55) — Tab groups are drawn in ink, not colour; a folded group carries its tabs' strongest dot.** Michael chose "ink" over Chrome-style tints on the sketch: the strip keeps colour for status, and Chrome's red, yellow and green would read as checkpoint, wake and needs-you. My calls, approved with the sketch: a green tab in a folded group pulses the chip without unfolding it; ⌘1–9 (and since the fixes the palette) count visible tabs only; Close Group asks once in the app; `wake` moves its whole group left. Later calls: Move Left/Right take one step (into or out of a group, or past a folded one); a drag-drop takes the target tab's group; ⌘W never answers Close Group; a drop counts only for a drag begun in that strip. Own map `docs/tab-groups.md`, split from the main map at its 40-node cap.

_Older Decisions archived → `docs/session-archive.md` (latest move 2026-11-07, S44 slimming; the index of earlier trims is under its "Archive pointers moved from CLAUDE.md" heading)._

_Older entries archived → `docs/session-archive.md` (latest move 2026-11-20, S56)._

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
