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
**S66 (25 Nov): v1.46.0 released, not installed: Close and Reload, a chip's left half drops a tab outside its group, green on the selected tab when Patton is behind (`2222b89`, run 45584563531, cask `94bfa338…` equals the DMG's digest); then Rename Tab… on project tabs (a one-off name beside the project default; Close and Reload clears it) pushed as `e5d3720` (verifier 61/61, no-install build 13:39:25), release run 45615885555 under way at 13:40; installed is still `37344b6` (1.42.0+1, 24 Nov 16:10).** Resume: confirm that run made v1.46.1 and that the cask's sha equals the DMG's; no worktrees are open; The install waits for his word with Patton quit, proven by the asar's mtime, codesign, Info.plist and `electron.icns` equal to `build/icon.icns`, then the S63, S65 and S66 live checks from main.log. His pages go to https://mjy-pages.vercel.app/, not claude.ai. Backlog: S20 punch-list.

## Mission Synthesis
Patton is a macOS Electron terminal (xterm.js, node-pty) that closes the gaps Claude Code leaves in stock terminals: attention signals, comfortable writing, finding your way across many parallel sessions, reviewing the Word documents Claude writes, and now seeing how much of each Claude login's weekly limit is left. It ships as a DMG and a Homebrew cask, CI-versioned on every push to main (the head commit's no-release marker skips; over 500 changed lines since the last tag is a minor bump). He works inside the installed app, so code lives in `.worktrees/`, main moves by fast-forward, and an install waits for his word with Patton quit, proven by the asar's mtime, codesign, Info.plist and the icon file. A pane's state comes from Claude Code's OSC 7501 reports with the Stop hook as fallback; main follows each Claude tab's transcript for the session bar and the turn-end ring; everything that types into Claude gates on the live `blocked` fact. Outside data comes in through files his estate writes: the usage panel reads the status line's per-login snapshot and counts tokens from the transcripts in a worker. Tabs follow Chrome: groups are one unbroken run, a drop lands in the slot under the pointer, a group's right edge joins it and a chip's left half is the slot before it, outside. A mark clears when he can see it, so the selected tab is marked while its window is behind. Close and Reload gives a project tab a fresh Claude in place, asking only when something would be lost. Since the last install (24 Nov 16:10) six releases wait, v1.42.2 to v1.46.0 (the F3 icon, Pages links, the usage panel, edge drops, token counts, and S66's three changes). Next: one install on his word, then the live checks from main.log. Lessons: he tries looks before they ship unless he waives it ("happy to just ship and then feedback"); every change gets two fresh reviews with probes, which keep finding real defects (a pointerdown clear swallowed the first click back in the window; an old shell exiting mid-respawn closed the tab); parallel builders in their own worktrees, every finding fixed in small slices with mutation-tested checks, the full suite once in one worktree.
## Session Log
### 2026-11-25 (Session 66 — Close and Reload, a chip's left half drops a tab outside its group, green on the selected tab when Patton is behind; merged, not released)
- His ask "close that tab and reload the same project with a fresh Claude thing": the tab menu's Close and Reload, in place on the project board's respawn path (`0966130`…`afcf415`, 157 checks). The second review's probes found an older defect: an old shell exiting mid-respawn closed the tab, the board's too. Fixed.
- His Wake bug ("drag it to the left of the low group ... It just won't move it"): there was no ungrouped slot before a group at the strip's start, in the installed build and in v1.44.0 alike. A chip's left half is now that slot (`4b30ed4`, `982a30e`); a 341,753-case oracle probe found no wrong order. He was told the workaround for now: Move Left.
- `green_selected` at his 08:22 "ok", with the red circle under the same rule (`26e215a`…`5bc99aa`, 82 checks). The second review found a pointerdown clear that swallowed the first click back in the window.
- Three builders in parallel worktrees, two fresh Sonnet reviews each, every finding fixed with mutation-tested checks; merged on `integrate/s66` (`2a33f2a`, one run-checks list conflict resolved by hand); lint and tsc clean, the full verifier running at the checkpoint. /Applications untouched.
- Full suite 60 of 61: `check-worktree-name` caught tab-manager reading `project.worktree` (the worktree rule lives in `project-names.ts`); the reload folder now comes from `projectFolder` (`2222b89`), both checks rerun green, no-install build 10:20:47. Released as v1.46.0 (run 45584563531; cask 1.46.0 `94bfa338…` equals the DMG's digest). The four worktrees and branches removed. A notes commit on main built through the post-commit hook with PATTON_NO_INSTALL=1 and left /Applications untouched, as designed.

_Earlier entries archived → `docs/session-archive.md` (latest trim 2026-11-25, S66)._

## Decisions

- **2026-11-25 (S66) — Close and Reload replaces the Claude pane's shell in place** (his "close that tab and reload the same project with a fresh Claude thing"): the tab keeps its place, group and flag, and its one-off name is cleared because a one-off name is "what I'm working on right now" (his words); a fresh shell in the project folder (a worktree tab's own) with the startup command; it asks only when something would be lost (work running, Claude waiting on him, unsent or stashed text, a plain shell's command running). Rejected: close plus a new tab (loses the place and group), a question every time (he wants it fast).
- **2026-11-25 (S66) — A dropped tab goes into a slot; a group's right edge joins it, and a chip's left half is the slot before it, outside it** (S65, his Chrome comparison; S66, his Wake drag: "to the left of the low group so that it's outside it but on the far left"). The half of the tab under the pointer picks before or after; the slot after an open group's last tab joins it; a chip's right half joins after the group's last tab. So a group at the strip's start, and two adjacent groups, have an ungrouped slot. Replaces "takes the target tab's group" (`docs/tab-groups.md`).
- **2026-11-25 (S66) — The selected tab gets the green dot and red circle while its window isn't in front** (his "ok"); they clear when the window comes back, the principle being that a mark clears when he can see it.
- **2026-11-24 (S65) — The usage panel's token count is the raw total, credited by the live-login timeline** (his "3 no" to price-weighting; the raw count on the default): counted from transcripts in a worker, partial ("≥ N since") until the timeline covers a whole week, approximate around switches because a switch is recorded at the next status-line render.
- **2026-11-24 (S64) — The dot and the ring stay two marks** (his "1 ok"): the dot is Claude itself mid-turn, so a message queues; the ring is a turn ended with only its own background work running, so he can type. Rejected: one mark for both (loses which tabs are free), a hover-card line naming which and how many agents run.

_Older Decisions archived → `docs/session-archive.md` (latest move 2026-11-07, S44 slimming; the index of earlier trims is under its "Archive pointers moved from CLAUDE.md" heading)._

_Older entries archived → `docs/session-archive.md` (latest move 2026-11-25, S66)._

## Gotchas
- **Every commit on main reinstalls /Applications/Patton.app, and Michael works inside it** (S41). The post-commit hook runs `scripts/forge-package.sh`, whose postPackage `ditto`s over the running app (survivable, but not wanted mid-session). Do code in a `.worktrees/` worktree (the hook exits there), verify with `PATTON_NO_INSTALL=1 npm run package`, move main with `git merge --ff-only` (no post-commit), and commit on main itself only with `PATTON_NO_INSTALL=1` in the environment (the hook inherits it). That includes `/checkpoint`: run `checkpoint-commit.py` with `PATTON_NO_INSTALL=1` and `[no-release]` at the end of its `--message` (a notes-only push without it releases: S40, and again S61, which cut v1.38.1 with no code change) (S44: without it, the checkpoint commit reinstalled the app from main, which reported "1.15.1+1" until the tag was reinstalled).
- **The estate's guards read whole commands and the scripts they run** (S62). off-limits-guard denied a Patton check for prose naming `~/Projects` (fixed in central-claude-md, S117), and dcg refused `git push … && stat -f` as a force-push. Run `git push` as its own call; for a false guard deny, fix the guard, never reword a check to slip past it.
- **Anything that types into Claude gates on the live 7501 `blocked` fact, never a debounced copy** (S56). The compose box first held sends only once its 250 ms aside had begun, so an Enter in that gap approved the prompt's default option (second review, probe A1); broadcast had the same hole. Debounce what he sees, not what is sent.

Moved word for word to the doc in `docs/reference/` for their area (S66 slimming); read it before working there:
- The dot's activity word is ranked for alerting, not for "is work running" → `claude-state-and-links.md`
- Main's IPC rate limiters refuse silently → `settings-ipc-and-logging.md`
- electron-store fills `defaults` only at the top level → `settings-ipc-and-logging.md`
- A new per-pane setting is applied in `Tab.createPaneInstance` → `settings-ipc-and-logging.md`
- Renderer `console.*` reaches `main.log` only through `rlog()` → `settings-ipc-and-logging.md`
- A group's tabs are one unbroken run; tab ids are per-window → `tab-strip.md`
- Never rebuild the tab strip from a pointerdown → `tab-strip.md`
- The box finds Claude Code's bar on screen → `claude-state-and-links.md`
- A hook's `terminalSequence` over 4096 bytes is dropped whole → `claude-state-and-links.md`
- Claude Code's 7501 root stays `working` while a subagent runs → `claude-state-and-links.md`
- Fit the terminal through `fitGrid`, never `fitAddon.fit()` → `fonts-and-rendering.md`
- A check that loads all of main reads his live data unless pointed away → `testing-and-checks.md`
- The two `check-session-bar` checks can't run in two worktrees at once → `testing-and-checks.md`
- jsdom's `document.hasFocus()` is always false → `testing-and-checks.md`


_Older Gotchas archived → `docs/session-archive.md` (latest move 2026-11-07, S44 slimming; the index of earlier trims is under its "Archive pointers moved from CLAUDE.md" heading)._

_Older entries archived → `docs/session-archive.md` (latest move 2026-11-25, S65)._

## Reference docs
Topic files, read only when the task needs them (moved word for word from Gotchas and Key Files, S44 and S46 slimming):
- `docs/reference/homebrew-tap.md` — the cask template, the tap's deploy key, the manual fallback. Read when the release's Homebrew step fails or a cask needs fixing.
- `docs/reference/xterm-internals.md` — xterm.js swallowing paste events and firing the key handler twice. Read before touching paste, key handling or any listener on the terminal's DOM.
- `docs/reference/upgrades.md` — npm 12's install-script approval and Electron 42+ changes. Read before adding or bumping a dependency (native ones above all) or upgrading npm or Electron.
- `docs/reference/build-and-install.md` — Forge exit codes, GitHub 504s, the CVE gate, hot-swap, reading the asar, launching an untried build as "Patton Test" (a second Patton shares the real one's userData). Read before building, packaging, installing or launching a build, or when a build or release step fails.
- `docs/reference/claude-state-and-links.md` — OSC 7501 probe, file-link policy, the `cc` startup command, OSC 133. Read before touching Claude state detection, file links, bookmark launch or the startup command. Also Pause all's running test, the compose box's bar finding, the hook's sequence limit, a subagent's `working` root.
- `docs/reference/fonts-and-rendering.md` — why 'SF Mono' never drew; `backgroundThrottling` and `document.hidden`. Read before touching fonts or any "is the window in view?" test. Also `fitGrid`.
- `docs/reference/testing-and-checks.md` — headless jsdom checks of renderer components. Read before writing one. Also before running the suite or a check that loads all of main.
- `docs/reference/settings-ipc-and-logging.md` — IPC rate limits, store defaults, per-pane settings, `rlog()`. Read before adding a setting, IPC call or renderer log line.
- `docs/reference/tab-strip.md` — group runs, per-window tab ids, pointerdown. Read before touching tab order, groups or drag.
- `docs/reference/key-files.md` — where each feature lives, with its check scripts. Read to find the code for a feature.

## Key Files
Moved to `docs/reference/key-files.md` (S46 slimming): read it to find where a feature lives.

## Next Steps
See `docs/NEXT_STEPS.md`.
