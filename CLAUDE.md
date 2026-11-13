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
**v1.26.1 released and installed (S51, 2026-11-13 09:29):** the checkpoint clock shows total context, as Claude Code's status bar does; before it v1.26.0 (slimmer strip), v1.25.0 (short auto tab names, Rename Tab…), v1.24.1 (red checkpoint circle), v1.24.0 (drag space beside +), v1.23 and v1.22. Tag `v1.26.1` = `f648f01` (run 43394684165 green, cask `a6659648…` matches the DMG). Installed from the tag with Patton quit: reports 1.26.1, asar 09:29, codesign ok, file list identical to `out/`. Next: THE MAP's `s49_ship` live checks, then `pause_ship`, `s47_ship`, `v115_verify`, `v114_verify`. Backlog: glob/minimatch advisories, S20 punch-list.

## Mission Synthesis
Patton is a macOS Electron terminal (xterm.js, node-pty) that closes the gaps Claude Code exposes in stock terminals: colour queries, contrast, attention signals and finding your way across many parallel sessions. It ships as a DMG and a Homebrew cask, CI-versioned on every push to main (patch ≤500 lines, else minor; `[no-release]` on the head commit skips it), now v1.26.1 on Electron 44.9.3 and Forge 8, installed. A pane's state comes from Claude Code's own OSC 7501 reports, with the Stop hook and title glyphs as fallback: green needs him, the hollow ring waits on its own background work, yellow marks the `wake` tab (moved to the far left once per run), and red marks a finished checkpoint he hasn't seen yet. Every new tab opens on a tile board of his projects that acts in place, and the projects list, not only the git root, decides what counts as a project. Quit and close confirmations live in the app behind a 300 ms dwell, the renderer closing through main. Pause all types the bare word `pause` (all the estate's hook reacts to) into each Claude pane on an allowlist of states, stashing a draft with Ctrl+S and skipping any pane that may already hold a stash; resume is typed by hand. The checkpoint clock shows the session's total context, as Claude Code's status bar does, and turns amber on growth since the last checkpoint. The strip is kept lean so every tab and its dot stay on screen (his choice over wider, scrolling tabs): auto names stop at 15 characters, a tab's × appears only on hover, Pause all is an icon whose result pops up below it, and a blank space beside + drags and double-clicks like a title bar. A pasted image's thumbnail clears when the message is sent. Michael works inside the installed app, so code lives in `.worktrees/`, builds stay out of /Applications until he quits, and an untried build launches as "Patton Test". Next: the live checks back to v1.14 and the S20 punch-list. Lessons: measure in `main.log` rather than assume; a fresh review with probes and log replays catches what builders miss; brief builders with the design settled.
## Session Log
### 2026-11-13 (Session 51 — v1.26.1 installed)
- Michael: "lets do the update, update local, make sure git updated etc". Patton was quit (he ran this from iTerm); an orphaned `chrome_crashpad_handler` from the 10 Nov launch was still running out of /Applications, which would have made the install's prune step treat Patton as running, so it was stopped first.
- Built from tag `v1.26.1` in `.worktrees/install-v1.26.1` (`npm run install-app`): /Applications reports 1.26.1, asar 09:29:50, `codesign --verify --deep --strict` passed, file list identical to `out/`, asar literals for the drag space, thumbnail clear and checkpoint mark present. Main already matched origin; the tag differs from main only in notes.

### 2026-11-12 (Session 49, continued — v1.24.0 and v1.24.1: a drag space beside +, a red circle when a checkpoint finishes; released not installed)
- **Drag space** (his screenshot of a full strip: "there's nowhere I can click in the top bar ... always a little space between the plus icon and Checkpoint ... only has to be as wide as the plus icon"): a blank `no-drag` space as wide as + moves the window by JS, and a double-click there or on the empty tab area asks main for the Mac's title-bar action (`src/main/title-bar-action.ts`). Review found focus leaving the terminal on a press and a drag ending in a zoom; fixed. `1cb4963`, `9858846`; v1.24.0, run 43256904199, cask `a81e5728…`.
- **Red circle when a checkpoint finishes** ("it goes red, but with the circle red, not the square ... disappear when I click on the tab"): the Stop hook's `cpt` newer than what he has seen this session. Review replayed his logs: ~8% of checkpoints end with tasks running and a wake-up turn wiped the mark for good; also a flag plus circle overflowing a squeezed tab and a one-second boundary miss; all fixed. `fdb74d0`, `d035df7`; v1.24.1, run 43267719809, cask `610dddc1…`.
- **"weve fixed this right?"** (a thumbnail left after a queued mid-turn send): yes from v1.22.0, but /Applications still runs v1.21.0; the install waits for his quit.
- **Process:** builder → fresh Sonnet review (hidden-Electron probes, log replays) → fix builder, each in `.worktrees/` with `cp -cR` node_modules; 21/21 checks, no-install builds; `check-project-board-ui.mjs` failed once in one full run and passed the next 13 (unreproduced).
- **Slimming** (on "2 do the trim"): the source tree, the "Patton Test" launch gotcha and the jsdom/worktree note moved word for word to `docs/reference/`, the S48 entry and two decisions to the archive, Status and the synthesis rewritten tighter: 21,013 → 16,728 chars (`04ca521`).
- **Tab names** (three screenshots: "really, really long names ... 10 to 15 characters max"; "a lot of space to the left"; "should be a rename option on tabs that arent projects"): Claude-titled tabs ≤ 15 characters, the hidden grip's 14 px given to the name, Rename Tab… on non-project tabs; a ≥ 5-letter floor was built and reverted on his choice "All tabs visible". v1.25.0 (`49f9fd8`, cask `78158827…`).
- **Slimmer strip** ("2 ok"): Pause all as an icon with its result in a popover, the × only on hover, floors scaling so the × never covers the dot; 13 tabs fit from ~860 px (was ~1200). Review caught dot clicks closing squeezed tabs from ×1.25, an erased ink bar, the × over a rename box and results pushing tabs off screen; all fixed, eleven mutations each fail the check. v1.26.0 (`fc2e8b7`, cask `82e0c7b5…`). The reviewer hit the 5-hour usage limit mid-run and was resumed by message after his `/login`.
- **Clock shows total context** ("why is the checkpoint % top right so different to bar"; then "I think the relevant stat is what the total context percentage is that's been used"): the clock had shown growth since the last checkpoint (main.log: total 80.3%, since 6.5% → "+7%"); it now shows the total, the amber reminder still counts growth. v1.26.1 (`f648f01`, cask `a6659648…`).

### 2026-11-12 (Session 50 — v1.23.0: a registered sub-project is its own project; from a Personal Finances — Stocks and Shares session, released not installed)
- Michael: "I'm trying to open a personal finance session, and it's just taking me to this tab ... That's the whole point of our sub-project." Cause: `resolveProject` gave the nearest git root, so a session in personal-finances/stocks-and-shares had `project.root` personal-finances, and `openProject` matched it as an open session of the parent.
- `66ed001`: the deepest projects-list row inside the repo that contains the folder wins (`src/main/registered-projects.ts`, reusing the board's parser); a missing list keeps the old behaviour; linked worktrees unchanged. A fresh Sonnet review approved it and found each lookup now cost about 4.7 ms (an encrypted settings read per call). `81442ec` brought it to about 36 µs, keyed the cache on ctime and ino, used `realpathSync.native` and logged once; `check-sub-project.mjs` has 51 checks.
- Lint, tsc, `npm run check` 18/18, no-install asar; pushed, run 43196071784 green, v1.23.0, cask `e38b6bf2…` matches the DMG. Not installed: the notes commit's post-commit rebuild (with `PATTON_NO_INSTALL=1`) left /Applications at v1.21.0.

### 2026-11-11 (Session 49 — v1.22.0: no Resume all, paste thumbnails clear on send; from a Patton tab, released not installed)
- **Live log since the v1.21 install** (10 Nov 22:39 → 11 Nov 18:55): Pause all pressed once (5 panes, 3 queued, the shell skipped), Wake and ten tile clicks acted in the board's tab, the ring 71 times; written into THE MAP (`s47_ship`, `pause_ship`).
- **Resume all removed** (his screenshot of the strip: "i used pause all then manually resumed each tab but still says resume all in corner, i actually dont think we need the resume button, each tab a bit different"): every press pauses; Pause remaining, ⌥-click, the mode broadcast and the paused set gone. `71e5cbd`.
- **Thumbnails clear on send** ("sometimes thumnail screenshots are staying at bottom after message sent"): 18 of 24 image pastes went in mid-turn, where the only clear (not working → working) never fires; Enter, the empty box's Enter or Send, a broadcast Enter and his compose submit now clear, an Enter answering a prompt doesn't. `4b477b9`, `d4a8984`, `0b22d80`.
- **Process:** two Sonnet builders in parallel worktrees, a fresh review (approve; one minor reproduced in jsdom: the empty-box Enter), a fix builder; 17/17 checks, no-install asar 00:07; pushed, run 43125053418, cask `a8a7f765…` verified; not installed ("dont push live to this version tho as usual").

_Earlier entries archived → `docs/session-archive.md` (latest trim 2026-11-12, S49-slimming)._

## Decisions
- **2026-11-13 (S49) — The checkpoint clock shows total context; its reminder counts growth since the last checkpoint.** Michael: "I think the relevant stat is what the total context percentage is that's been used." The amber reminder stays on growth because a checkpoint doesn't lower the total, so a total-based reminder would never clear; that split is my call.
- **2026-11-12 (S49) — A slimmer strip: Pause all as an icon, the tab × only on hover.** Michael: "2 ok" to slimming the strip's own buttons so more tabs fit. The × overlays the tab's right end rather than taking space, so tab floors scale with Interface Text Size just enough that the hovered × never covers the dot; Pause all's result moved to a popover so a press never pushes tabs off screen. The selected tab no longer shows its × until hovered. The popover and the scaled floors are my calls, from the review.
- **2026-11-12 (S49) — Auto tab names stop at 15 characters; crowded tabs keep every tab on screen.** Michael: "It should always default to 10 to 15 characters max" and "I can't see what the tab actually is". Only names from Claude's title are cut (whole words when ≥ 10 characters remain); project and typed names stay whole. Asked whether crowded tabs should show ≥ 5 letters with the strip scrolling past 4–5 tabs, or keep tabs and dots on screen with fewer letters, he chose "All tabs visible"; the floor stays low, and with today's strip chrome 13 tabs fit from about a 1200 px window. (Since the slimmer strip below, 13 tabs fit from about 860 px at ×1, 930 px at ×1.5.)
- **2026-11-12 (S49) — A finished checkpoint marks its tab with a red circle until he selects it.** Michael: "it goes red, but with the circle red, not the square ... It should disappear when I click on the tab." Detection reuses the Stop hook's `cpt`; the mark outranks green, the ring and yellow, and returns after a wake-up turn until he has seen it (a checkpoint ending with tasks still running is ~8% of his, per his logs). Hiding it while Claude works a new turn, and red outranking the ring, are my calls.
- **2026-11-12 (S49) — The strip's blank space is JS-driven, not a native drag region.** Michael: "make sure there is always a little space between the plus icon and Checkpoint ... so that I have somewhere to click" (to drag, and double-click to zoom). Whether Electron passes a double-click to the page inside `-webkit-app-region: drag` on macOS is unconfirmed (other Electron apps report it doesn't), so the space is `no-drag`, moves the window like the tab area already did, and a double-click asks main for the Mac's own title-bar action. The width (exactly the + button's) and the empty tab area getting the same double-click are my calls.
- **2026-11-12 (S50) — A registered sub-project is its own project, not its parent repo's.** Michael, when Personal Finances kept opening his Stocks and Shares tab: "This should be able to run as a standalone at the same time. That's the whole point of our sub-project." The projects list decides: the deepest row inside the repo that contains the folder wins; without the list, the nearest git repo as before.

_Older Decisions archived → `docs/session-archive.md` (latest move 2026-11-07, S44 slimming; the index of earlier trims is under its "Archive pointers moved from CLAUDE.md" heading)._

_Older entries archived → `docs/session-archive.md` (latest move 2026-11-13, S49)._

## Gotchas
- **Every commit on main reinstalls /Applications/Patton.app, and Michael works inside it** (S41). The post-commit hook runs `scripts/forge-package.sh`, whose postPackage `ditto`s over the running app (survivable, but not wanted mid-session). Do code in a `.worktrees/` worktree (the hook exits there), verify with `PATTON_NO_INSTALL=1 npm run package`, move main with `git merge --ff-only` (no post-commit), and commit on main itself only with `PATTON_NO_INSTALL=1` in the environment (the hook inherits it). That includes `/checkpoint`: run `checkpoint-commit.py` with `PATTON_NO_INSTALL=1` (S44: without it, the checkpoint commit reinstalled the app from main, which reported "1.15.1+1" until the tag was reinstalled).
- **Main's IPC rate limiters refuse silently, so a burst caller loses data** (S43). `pty:get-cwd` (10/s) answered `''` past the limit and autosave saved it, so panes past the tenth reopened in `~` (v1.13.2); `settings:set` (10/s) dropped the last step of a slider drag or a held arrow (v1.14). Space burst calls (autosave refreshes cwds 120 ms apart), debounce rapid saves, and never persist a refused answer over a known value.
- **electron-store fills `defaults` only at the top level** (S42). Patton's settings are one nested object, so a field added later is absent from every saved file: read it as `=== true` (off by default) or `!== false` (on by default), never bare.
- **A new per-pane setting must be applied in `Tab.createPaneInstance`, not only to existing panes** (S40). Until `8af2355`, `Tab.setFont/Scrollback/Theme/Renderer/CopyOnSelect` looped over `_panes`, so a split pane got none of them — on the default DOM renderer a split silently ran WebGL. The review of compose-first found it; keep the values on `Tab` and apply them at pane creation.
- **The release workflow reads only the head commit's whole message for the no-release marker** (S37). A trailing docs commit carrying it, or a commit body that merely quotes it, skips the release for the entire push. Keep a code commit on top, or end with a marker-free `release:` commit. Builder agents add the marker to their own code commits unprompted (S45: both close-dialog commits carried it), so check `git log --format=%B origin/main..` for it before every push.
- **Renderer `console.*` calls don't reach `main.log` unless they go through `rlog()`** (S27). `src/main/logger.ts` only tees the main-process console. Any new `[RENDER]` or other diagnostic line you want in the file log MUST use `rlog()` from `src/renderer/services/renderer-logger.ts` — `console.info` alone reaches DevTools only and is invisible to packaged-app launches. This is exactly the gap that made S25's "is the periodic timer firing?" question unanswerable for ~10 days. `rlog()` keeps the DevTools console output too, so it's a strict superset of `console.*` for diagnostic purposes.
- **Claude Code's Ctrl+S on an empty line brings back an older stash, and its restore after a submit doesn't happen in every case** (S47, read in 2.1.321's code). For anything that types into a Claude pane, a false "has a draft" is the dangerous side: the old stash would be submitted with the typed words. A stash mid-turn and Ctrl+C mid-turn are unmeasured live.


_Older Gotchas archived → `docs/session-archive.md` (latest move 2026-11-07, S44 slimming; the index of earlier trims is under its "Archive pointers moved from CLAUDE.md" heading)._

_Older entries archived → `docs/session-archive.md` (latest move 2026-11-10, S47)._

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
