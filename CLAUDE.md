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
**S66 (25 Nov): Close and Reload, a chip's left half drops a tab outside its group, green on the selected tab when Patton is behind: on main as `2222b89` (full suite 60 of 61, the one failure, `check-worktree-name`, fixed and rerun; no-install build 10:20:47), release run 45584563531 under way at 10:23; installed is still `37344b6` (1.42.0+1).** Resume: confirm that run made the tag (a minor bump) and that the cask's sha equals the DMG's; the four S66 worktrees and branches are removed. The install waits for his word with Patton quit, proven by the asar's mtime, codesign, Info.plist and `electron.icns` equal to `build/icon.icns`, then the S63, S65 and S66 live checks from main.log. His pages go to https://mjy-pages.vercel.app/, not claude.ai. Backlog: S20 punch-list.

## Mission Synthesis
Patton is a macOS Electron terminal (xterm.js, node-pty) that closes the gaps Claude Code leaves in stock terminals: attention signals, comfortable writing, finding your way across many parallel sessions, reviewing the Word documents Claude writes, and now seeing how much of each Claude login's weekly limit is left. It ships as a DMG and a Homebrew cask, CI-versioned on every push to main (the head commit's no-release marker skips; over 500 changed lines since the last tag is a minor bump). He works inside the installed app, so code lives in `.worktrees/`, main moves by fast-forward, and an install waits for his word with Patton quit, proven by the asar's mtime, codesign, Info.plist and the icon file. A pane's state comes from Claude Code's OSC 7501 reports with the Stop hook as fallback; main follows each Claude tab's transcript for the session bar and the turn-end ring; everything that types into Claude gates on the live `blocked` fact. Outside data comes in through files his estate writes: the usage panel reads the status line's per-login snapshot and counts tokens from the transcripts in a worker. Tabs follow Chrome: groups are one unbroken run, a drop lands in the slot under the pointer, a group's right edge joins it and a chip's left half is the slot before it, outside. A mark clears when he can see it, so the selected tab is marked while its window is behind. Close and Reload gives a project tab a fresh Claude in place, asking only when something would be lost. Since the last install (24 Nov 16:10) five releases wait (the F3 icon, Pages links, the usage panel, edge drops, token counts), and S66's three changes are merged, not yet released. Next: release them, then one install and the live checks from main.log. Lessons: he tries looks before they ship unless he waives it ("happy to just ship and then feedback"); every change gets two fresh reviews with probes, which keep finding real defects (a pointerdown clear swallowed the first click back in the window; an old shell exiting mid-respawn closed the tab); parallel builders in their own worktrees, every finding fixed in small slices with mutation-tested checks, the full suite once in one worktree.
## Session Log
### 2026-11-25 (Session 66 — Close and Reload, a chip's left half drops a tab outside its group, green on the selected tab when Patton is behind; merged, not released)
- His ask "close that tab and reload the same project with a fresh Claude thing": the tab menu's Close and Reload, in place on the project board's respawn path (`0966130`…`afcf415`, 157 checks). The second review's probes found an older defect: an old shell exiting mid-respawn closed the tab, the board's too. Fixed.
- His Wake bug ("drag it to the left of the low group ... It just won't move it"): there was no ungrouped slot before a group at the strip's start, in the installed build and in v1.44.0 alike. A chip's left half is now that slot (`4b30ed4`, `982a30e`); a 341,753-case oracle probe found no wrong order. He was told the workaround for now: Move Left.
- `green_selected` at his 08:22 "ok", with the red circle under the same rule (`26e215a`…`5bc99aa`, 82 checks). The second review found a pointerdown clear that swallowed the first click back in the window.
- Three builders in parallel worktrees, two fresh Sonnet reviews each, every finding fixed with mutation-tested checks; merged on `integrate/s66` (`2a33f2a`, one run-checks list conflict resolved by hand); lint and tsc clean, the full verifier running at the checkpoint. /Applications untouched.

### 2026-11-24 (Session 65 — usage panel with token counts, Chrome-like group edge drops, the green dot's log lines; released, not installed)
- His ask: "I'm cycling between three Ultra accounts ... save the latest from each" and show names, percent and a token count bottom left. The status line now keeps each login's 5-hour and weekly reading and the live-login timeline (central-claude-md `c3cf681`); try-out page https://mjy-pages.vercel.app/p/patton-usage-panel/, his "2 u1"; the panel (`2d1576d`…`84f6518`, two reviews, 191 checks) released as v1.43.0; the raw token count on the default after his "3 no" to price-weighting (worker scan, `7e17f50`, `e6e83b7`, 102 checks).
- His "in Google Chrome, you can drag a tab to the edge of the tab group, and it will include it": `dropPlacement` slots and edge joins with a blue line cue (`bf69980`…`1b1c1c9`); the review found a strip rebuild mid-drag read every drop as the right half (fixed, mutation-tested); v1.44.0.
- His screenshot "it didn't flash green": Defence's turn ended 21:42:23 with the signal and marimba, and the log couldn't say why no dot; every dot raise, skip, clear and tab switch is now logged (`632220b`). His answer: probably on Defence; his "ok" to green on the selected tab when Patton isn't in front (next session).
- Verifier 58–59/59 with a no-install build before each merge; `check-close-guard` was flaky between v1.43.0 and `e6e83b7` (it read the live accounts.json). Four worktrees removed after merging. /Applications untouched.

### 2026-11-24 (Session 64 — from a Pages session: Pages links in the session bar; the two tab marks kept)
- At his "1 yes": links to his Pages site (`https://mjy-pages.vercel.app/p/<slug>/`, where his pages go since 24 Nov) are Page rows in the session bar, labelled by their markdown text or the slug in words (`src/shared/pages-url.ts`, D6; `6ac0448`, built in a worktree, checks 57/57, release run passed, not installed). Reviewed inline, since the Sonnet reviewer was refused at the weekly limit.
- D6's click line corrected: a web link opens through `web-open.ts` (`APP_OPEN_EXTERNAL`, http and https only), a file through `link-open-policy` (`95ad1bd`).
- His "no reason why some things have a hollow circle and some a solid dot; both have agents running": by design, read in main.log and the sessions' records. Foot's turn ended 17:52 over a background job (ring); Defence was mid-turn launching four agents (dot) and turned to the ring at 17:55:34. He kept both marks ("1 ok").

### 2026-11-24 (Session 63 — v1.39.0 → v1.42.1 installed and walked through; wake compact, bar rows, the checkpoint's own work, busy dot, multi-select, dismiss-all; icon F3 pushed, not installed)
- v1.39.0 (06:41) then v1.40.0 (07:06) installed from their tags with Patton quit; the walk-through ended on his "all looks good" (07:12); typescript-eslint 8.73.0 (`6258da4`, full audit 10 → 4, prod 0). Memory: a walk-through list goes in the reply, no page ("we didnt need that artifact").
- His asks, each in its own worktree, reviewed fresh two or three times and every finding fixed: the wake tab always compact; session bar rows in one font clamped to 3 lines, the folded strip's "!N", then a dismiss-all × (`37344b6`); the Stop hook holds `cpd` only for the checkpoint's own background work (`99c74bf`, 156 probe cases, 260 of 262 real tasks agree with an independent oracle); a still grey dot on busy Claude tabs (W1) and multi-select tabs (S1), both picked on a try-out page.
- v1.41.0, v1.42.0 and v1.42.1 released; with Patton quit and the run queued, `37344b6` installed at 16:10:11 (Info.plist 1.42.0+1; the v1.42.1 tag later landed on the same sha, cask `0af658f6…` equals the DMG's digest).
- The icon: ten studies, then A2 (v1.40.0, "a bowler hat" in his Dock), P1 (installed), and from his words ("mostly falling background with subtle face", "the face ... made up of falling numbers") round 6's F3, the portrait drawn by the falling streams (`84564e7`, run queued). His pages now go to https://mjy-pages.vercel.app/ (icon studies: /p/patton-icon-studies/).
- His Dock tab looked blank mid-turn: by design then, now the W1 dot. The macOS Dock itself belongs to his other session: one change was made here (the Downloads stack removed) and handed over.

_Earlier entries archived → `docs/session-archive.md` (latest trim 2026-11-25, S66)._

## Decisions

- **2026-11-25 (S66) — Close and Reload replaces the Claude pane's shell in place** (his "close that tab and reload the same project with a fresh Claude thing"): same tab, place, group, name and flag, a fresh shell in the project folder (a worktree tab's own) with the startup command; it asks only when something would be lost (work running, Claude waiting on him, unsent or stashed text, a plain shell's command running). Rejected: close plus a new tab (loses the place and group), a question every time (he wants it fast).
- **2026-11-25 (S66) — A dropped tab goes into a slot; a group's right edge joins it, and a chip's left half is the slot before it, outside it** (S65, his Chrome comparison; S66, his Wake drag: "to the left of the low group so that it's outside it but on the far left"). The half of the tab under the pointer picks before or after; the slot after an open group's last tab joins it; a chip's right half joins after the group's last tab. So a group at the strip's start, and two adjacent groups, have an ungrouped slot. Replaces "takes the target tab's group" (`docs/tab-groups.md`).
- **2026-11-25 (S66) — The selected tab gets the green dot and red circle while its window isn't in front** (his "ok"); they clear when the window comes back, the principle being that a mark clears when he can see it.
- **2026-11-24 (S65) — The usage panel's token count is the raw total, credited by the live-login timeline** (his "3 no" to price-weighting; the raw count on the default): counted from transcripts in a worker, partial ("≥ N since") until the timeline covers a whole week, approximate around switches because a switch is recorded at the next status-line render.
- **2026-11-24 (S64) — The dot and the ring stay two marks** (his "1 ok"): the dot is Claude itself mid-turn, so a message queues; the ring is a turn ended with only its own background work running, so he can type. Rejected: one mark for both (loses which tabs are free), a hover-card line naming which and how many agents run.

_Older Decisions archived → `docs/session-archive.md` (latest move 2026-11-07, S44 slimming; the index of earlier trims is under its "Archive pointers moved from CLAUDE.md" heading)._

_Older entries archived → `docs/session-archive.md` (latest move 2026-11-25, S66)._

## Gotchas
- **Every commit on main reinstalls /Applications/Patton.app, and Michael works inside it** (S41). The post-commit hook runs `scripts/forge-package.sh`, whose postPackage `ditto`s over the running app (survivable, but not wanted mid-session). Do code in a `.worktrees/` worktree (the hook exits there), verify with `PATTON_NO_INSTALL=1 npm run package`, move main with `git merge --ff-only` (no post-commit), and commit on main itself only with `PATTON_NO_INSTALL=1` in the environment (the hook inherits it). That includes `/checkpoint`: run `checkpoint-commit.py` with `PATTON_NO_INSTALL=1` and `[no-release]` at the end of its `--message` (a notes-only push without it releases: S40, and again S61, which cut v1.38.1 with no code change) (S44: without it, the checkpoint commit reinstalled the app from main, which reported "1.15.1+1" until the tag was reinstalled).
- **The dot's activity word (`Pane.currentActivity`) is ranked for alerting, not for "is work running"** (S62). An error root outranks working children, and the hook's verdict drops when children drain, so Pause all reads `pauseInput().running`; don't reuse the activity word for a decision about running work.
- **The estate's guards read whole commands and the scripts they run** (S62). off-limits-guard denied a Patton check for prose naming `~/Projects` (fixed in central-claude-md, S117), and dcg refused `git push … && stat -f` as a force-push. Run `git push` as its own call; for a false guard deny, fix the guard, never reword a check to slip past it.
- **Main's IPC rate limiters refuse silently, so a burst caller loses data** (S43). `pty:get-cwd` (10/s) answered `''` past the limit and autosave saved it, so panes past the tenth reopened in `~` (v1.13.2); `settings:set` (10/s) dropped the last step of a slider drag or a held arrow (v1.14). Space burst calls (autosave refreshes cwds 120 ms apart), debounce rapid saves, and never persist a refused answer over a known value.
- **electron-store fills `defaults` only at the top level** (S42). Patton's settings are one nested object, so a field added later is absent from every saved file: read it as `=== true` (off by default) or `!== false` (on by default), never bare.
- **A new per-pane setting must be applied in `Tab.createPaneInstance`, not only to existing panes** (S40). Until `8af2355`, `Tab.setFont/Scrollback/Theme/Renderer/CopyOnSelect` looped over `_panes`, so a split pane got none of them — on the default DOM renderer a split silently ran WebGL. The review of compose-first found it; keep the values on `Tab` and apply them at pane creation.
- **Renderer `console.*` calls don't reach `main.log` unless they go through `rlog()`** (S27). `src/main/logger.ts` only tees the main-process console. Any new `[RENDER]` or other diagnostic line you want in the file log MUST use `rlog()` from `src/renderer/services/renderer-logger.ts` — `console.info` alone reaches DevTools only and is invisible to packaged-app launches. This is exactly the gap that made S25's "is the periodic timer firing?" question unanswerable for ~10 days. `rlog()` keeps the DevTools console output too, so it's a strict superset of `console.*` for diagnostic purposes.
- **A group's tabs are one unbroken run in `TabManager.tabs`, and tab ids are per-window counters** (S55). Every path that splices the tab order (createTab, reorder, drag, wake, discardTab, close, restore) must keep each group's run whole, through the helpers in `services/tab-groups.ts`. `tab-N` exists in every window, so a tab id arriving from outside the strip (drag data) is trusted only for a drag that began there (`draggedId`): before `7f092d8` a tab dragged in from another window moved this window's tab of the same id.
- **Anything that types into Claude gates on the live 7501 `blocked` fact, never a debounced copy** (S56). The compose box first held sends only once its 250 ms aside had begun, so an Enter in that gap approved the prompt's default option (second review, probe A1); broadcast had the same hole. Debounce what he sees, not what is sent.
- **The box finds Claude Code's bar on screen, so a Claude Code redesign of that bar quietly puts the box back under the terminal** (S58). `services/claude-bar.ts` needs the cursor's row to start with `❯` between two all-`─` rows; Claude's hint text is dim, his typed text is not. When the box stops covering the bar, `grep '\[COMPOSE\] bar not found' main.log` gives why (no-glyph, no-rule-above, no-rule-below); then re-record `scripts/fixtures/claude-bar-screens.json` from the new Claude Code (a pty capture with `--settings '{"disableAllHooks":true}'`; run from inside a Claude session, its transcripts stay off).
- **A check that loads all of main reads his live data unless pointed away** (S65). `check-close-guard.mjs` failed at random once the usage panel polled the real `~/.claude/plan-usage/accounts.json`, which changes every few seconds; it now sets `PATTON_PLAN_USAGE_FILE` and `PATTON_CLAUDE_PROJECTS_DIR` to missing paths. Do the same in any new whole-main check.
- **A hook's `terminalSequence` over 4096 bytes is dropped whole by Claude Code** (S60, read in 2.1.321). The Stop hook keeps its sequence under 3,500 by cutting its lists, never the sequence; a renderer that reads a list must treat a short one (fewer items than `tasks`) as cut.
- **Claude Code keeps its 7501 root `working` after a turn ends while a subagent it launched still runs** (S61, 2.1.321). No `done` comes until the subagent's `<task-notification>` starts the next turn, so a pane that waited for `done` showed nothing for the whole run (House tab, 22 Nov). A Stop verdict over a working root with working children is the turn end (`turnEndedOverWork` in `services/turn-end.ts`); his send, or the transcript feed's `turn-activity` (a Stop another hook blocked, a new assistant line), is the next turn's only sign, since the root already reads working. So the ring shows only on a pane whose feed main has attached; a blocked Stop's line can arrive before the verdict, and a `/` or `!` line he sends may start no turn. Background shells still get their `done`. An Esc that stops a turn sent over it changes nothing in 7501 either (the root stays `working`): D18's restore reads Claude's bar instead (`planHoldsSent`).
- **Fit the terminal through `services/terminal-fit.ts` (`fitGrid`), never `fitAddon.fit()`** (S58). The addon sizes from the container's computed size, which under `border-box` includes `.terminal-container`'s padding: at UI scale 1.5 the last row was cut by 2.4 px.
- **`check-session-bar-layout.cjs` and `check-session-bar-e2e.cjs` each start a hidden Electron and fail ("timeout", "no result") when two worktrees run them at once** (S63). Run them one at a time, with `pgrep -f check-session-bar` empty first.
- **jsdom's `document.hasFocus()` is always false** (S66). `scripts/tab-manager-harness.mjs` stubs it true; a check outside that harness sees every window as behind, where the selected tab now gets the green dot and red circle.
- **Never rebuild the tab strip from a pointerdown** (S66): the pressed element detaches and its click, double-click rename or drag is lost. Clear marks after the click (deferred 0 ms); the strip already holds rebuilds during a drag or rename.


_Older Gotchas archived → `docs/session-archive.md` (latest move 2026-11-07, S44 slimming; the index of earlier trims is under its "Archive pointers moved from CLAUDE.md" heading)._

_Older entries archived → `docs/session-archive.md` (latest move 2026-11-25, S65)._

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
