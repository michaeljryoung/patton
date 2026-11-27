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
**S68 (27 Nov): v1.49.0 and v1.49.1 released, not installed** (casks `fec0f992…` and `fe485a40…` equal their DMGs' digests): the long-paste freeze fixed (his 413,762-character article froze the renderer 2 min 11 s; now 37 ms), sidebar rows that tighten only as far as needed before the list scrolls, and a 6 px tab-group line. /Applications is v1.48.0 (26 Nov 18:02). Resume: install the latest release at his next Patton install and not before (his "don't install it now. Just have it ready to install next time we install Patton"; node `s68_install`), with Patton quit, from a session outside Patton (quitting ends every Claude session in it); then the live checks from main.log (`s65_install`, `s67_batch`, `s68_install`). No worktrees or branches open. His pages go to https://mjy-pages.vercel.app/, not claude.ai.

## Mission Synthesis
Patton is a macOS Electron terminal (xterm.js, node-pty) that closes the gaps Claude Code leaves in stock terminals: attention signals, comfortable writing, finding your way across many parallel sessions, reviewing the Word documents Claude writes, and seeing each Claude login's week as a plain "used of allowance". It ships as a DMG and a Homebrew cask, CI-versioned on every push to main (the head commit's no-release marker skips; over 500 changed lines since the last tag is a minor bump). He works inside the installed app, so code lives in `.worktrees/`, main moves by fast-forward and changes are released as they land; /Applications is installed only on his word, with Patton quit (which ends every Claude session in it), once nothing more is in flight, proven by the asar's mtime, codesign, Info.plist and the icon file, and never by restarting the Dock. v1.48.0 is installed; v1.49.0 and v1.49.1 wait for his next install: a long paste into the compose box no longer freezes the app, the sidebar's rows tighten only as far as they must before the list scrolls, and a tab group's top line is 6 px. A pane's state comes from Claude Code's OSC 7501 reports with the Stop hook as fallback; everything that types into Claude gates on the live `blocked` fact. Tabs follow Chrome: groups are one unbroken run, a drop lands in the slot under the pointer, and a mark clears when he can see it. The icon is K1, the portrait drawn by lit falling digits; notification volume reaches 400%. This file is a router since S66: gotchas for one area live in that area's reference doc. Lessons: a look is judged at real size, so candidates are drawn from the real component in a hidden Electron and put on his Pages site for his pick; a slow path is reproduced with his own input before it is fixed, and the next-slowest step is measured too; every change gets a fresh review and mutation-tested checks, which keep finding real defects; builders work in their own worktrees, the full suite once before a push.
## Session Log
### 2026-11-27 (Session 68 — long-paste freeze fixed, sidebar density, 6 px group line; v1.49.0 and v1.49.1 released, not installed)
- His report: a 20,000-word article pasted into the compose box froze Patton. main.log: renderer unresponsive 13:57:36–13:59:47 (413,762 characters, 3,397 lines, in the AIBL tab). Reproduced with his text in a hidden Electron with a real Pane: 119 s, 112.7 s of it the caret mirror laid out on each of 5,111 per-line `input` events from `execCommand('insertText')`; Chromium alone 2.9 s line by line, 23 ms as one `setRangeText`.
- Fix (`docs/compose-box.md` D19): one resize per insertion, one edit over 200 line breaks or 50,000 characters (clears the box's ⌘Z history: my call, else a multi-second freeze), no mirror for a caret at the end. The article 37 ms, a key at the end 2 ms; a review's five minors fixed (an `input` event for the aside note, lone CR, the IME route, the undo pinned in real Chromium).
- His "compress these more so dont need to scroll": three densities drawn from the real component on https://mjy-pages.vercel.app/p/patton-sidebar-rows/; his "starts as today, then becomes A, then becomes B, and then ... scroll". A review's sub-pixel fit bug fixed by reading the scroll range Chromium gives (`check-bookmarks-density.cjs` 151).
- His "colour bar at top thicker of group": four strengths on https://mjy-pages.vercel.app/p/patton-group-lines/, his "1 ok" to 6 px; review fixes: the drop cue's edge, the name box below the line, the outline over it.
- Full suite 64/64 before each push; released v1.49.0 and v1.49.1; not installed, at his word. Worktrees and branches removed; the scratchpad copies of his article deleted.

### 2026-11-26 (Session 67 — v1.46.1, then v1.48.0 installed: icon K1, usage "used of allowance", volume to 400%, installs refresh the Dock)
- v1.46.1 installed at his "1 yes install" (00:29). The usage panel missed a third login: michaeljryoung@ (`17f8b6e1`, inferred from his three logins) was last live before the recorder began (24 Nov 20:22); its last reading was seeded into accounts.json from seven-day.log.
- Icon: F3 was his pick ("f3", 24 Nov) but the Dock kept P1 from its own cache (`killall Dock`); seen, F3 "just looks black". Rounds 7 and 8 on the icon studies page (G1–G4 lit by a glow, K1–K4 bigger digits), his "k1". Installs now bump the bundle's mtime and run `lsregister -f` (`e2bd1f9`…`d8801f4`; checks 81 and 8).
- Usage line as "<used> of <allowance> bn" (his "it should just be 1.2 out of 5"), the allowance estimated per login (`496d001`…`a2216ba`; 157 and 193 checks; two reviews, every finding fixed, mutation-tested; full suite 62/62). Notification volume to 400% with a limiter only above 100% (his "cant hear marimba if watching a video"; `cf6d2bb`…`b5003e6`, 235 checks).
- Released v1.47.0 (G3), v1.47.1 (K1; the first run never got a macOS runner and was rerun), v1.48.0 (cask `9a57b7d1…` equals the DMG's digest); installed 18:02 at his "its shut", once everything was ready (his "Let's get all of our updates ready first").

### 2026-11-25 (Session 66 — Close and Reload, a chip's left half drops a tab outside its group, green on the selected tab when Patton is behind, a one-off Rename Tab… on project tabs; v1.46.0 and v1.46.1 released, not installed; notes slimmed)
- His ask "close that tab and reload the same project with a fresh Claude thing": the tab menu's Close and Reload, in place on the project board's respawn path (`0966130`…`afcf415`, 157 checks). The second review's probes found an older defect: an old shell exiting mid-respawn closed the tab, the board's too. Fixed.
- His Wake bug ("drag it to the left of the low group ... It just won't move it"): there was no ungrouped slot before a group at the strip's start, in the installed build and in v1.44.0 alike. A chip's left half is now that slot (`4b30ed4`, `982a30e`); a 341,753-case oracle probe found no wrong order. He was told the workaround for now: Move Left.
- `green_selected` at his 08:22 "ok", with the red circle under the same rule (`26e215a`…`5bc99aa`, 82 checks). The second review found a pointerdown clear that swallowed the first click back in the window.
- Three builders in parallel worktrees, two fresh Sonnet reviews each, every finding fixed with mutation-tested checks; merged on `integrate/s66` (`2a33f2a`, one run-checks list conflict resolved by hand); lint and tsc clean, the full verifier running at the checkpoint. /Applications untouched.
- Full suite 60 of 61: `check-worktree-name` caught tab-manager reading `project.worktree` (the worktree rule lives in `project-names.ts`); the reload folder now comes from `projectFolder` (`2222b89`), both checks rerun green, no-install build 10:20:47. Released as v1.46.0 (run 45584563531; cask 1.46.0 `94bfa338…` equals the DMG's digest). The four worktrees and branches removed. A notes commit on main built through the post-commit hook with PATTON_NO_INSTALL=1 and left /Applications untouched, as designed.
- His screenshot of a project tab's menu ("you can't rename it as a one-off ... sometimes I just want to know what I'm working on in that project right now"): "Rename Tab…" on every tab, directly above "Set Default Tab Name for Project…"; Close and Reload now clears a one-off name and keeps the flag (`7c361c7`, `6206595`; a review, findings fixed; a DNS drop killed one builder mid-edit, a fresh one finished from its diff). Verifier 61/61, released as v1.46.1.
- His "2 do it now": CLAUDE.md slimmed into a router (`047f5c0`): S64 and S65 log entries to the archive, fourteen gotchas word for word to their area's reference doc (new `docs/reference/settings-ipc-and-logging.md` and `tab-strip.md`), a pointer line each; 26 moved lines verified verbatim; a fresh agent answered 29 of 30 recall questions from the new file (1 partial). The 13,000 target was missed (15,257): the kept sections are 13,500 alone.

_Earlier entries archived → `docs/session-archive.md` (latest trim 2026-11-25, S66)._

## Decisions

- **2026-11-27 (S68) — A long paste goes into the compose box as one edit** (his 413,762-character article froze Patton for 2 min 11 s): over 200 line breaks or 50,000 characters it is a single `setRangeText`, which clears the box's ⌘Z history; smaller pastes keep `execCommand` and undo. Rejected: `execCommand` for everything with the box's handler silenced (Chromium alone takes 2.9 s for the article). Detail: `docs/compose-box.md` D19.
- **2026-11-27 (S68) — The sidebar's rows tighten only as far as they must** (his "starts as today, then becomes A, then becomes B, and then, once it hits B, it just becomes scroll"): the roomiest of three densities at which the list fits without a scrollbar. **A tab group's top line is 6 px** in its own colour (his "its v hard to distinguish groups"; "1 ok" to B on https://mjy-pages.vercel.app/p/patton-group-lines/).
- **2026-11-26 (S67) — Each login's usage line reads "<used> of <allowance> bn · resets …", nothing else** (his "it should just be 1.2 out of 5, and the other one might be 3 out of 3 used. It should be really simple"; replaces S65's "≥ N since"): the allowance is estimated per login, from a complete week's count (tokens ÷ percent) or, for a week counted only in part, from the tokens counted since the timeline began ÷ the percent risen since then (the status line's seven-day.log, keyed by reset time; a rise of at least 10 points); no estimate shows only the reset; the hover says it is an estimate and why there is none.
- **2026-11-26 (S67) — One install, once every pending update is ready** (his "we don't need to just install both straight away ... Let's get all of our updates ready first"; S68: "don't install it now. Just have it ready to install next time we install Patton"): changes are released as they land; /Applications is installed once, with Patton quit, when nothing more is in flight and he says so.
- **2026-11-26 (S67) — An install re-registers the app but never restarts the Dock**: the post-commit hook installs too, and a Dock restart shows on his screen; a changed icon may still need `killall Dock`, run by hand after an install he asked for.

- **2026-11-25 (S66) — Close and Reload replaces the Claude pane's shell in place** (his "close that tab and reload the same project with a fresh Claude thing"): the tab keeps its place, group and flag, and its one-off name is cleared because a one-off name is "what I'm working on right now" (his words); a fresh shell in the project folder (a worktree tab's own) with the startup command; it asks only when something would be lost (work running, Claude waiting on him, unsent or stashed text, a plain shell's command running). Rejected: close plus a new tab (loses the place and group), a question every time (he wants it fast).
- **2026-11-24 (S64) — The dot and the ring stay two marks** (his "1 ok"): the dot is Claude itself mid-turn, so a message queues; the ring is a turn ended with only its own background work running, so he can type. Rejected: one mark for both (loses which tabs are free), a hover-card line naming which and how many agents run.

_Older Decisions archived → `docs/session-archive.md` (latest move 2026-11-07, S44 slimming; the index of earlier trims is under its "Archive pointers moved from CLAUDE.md" heading)._

_Older entries archived → `docs/session-archive.md` (latest move 2026-11-27, S68)._

## Gotchas
- **Every commit on main reinstalls /Applications/Patton.app, and Michael works inside it** (S41). The post-commit hook runs `scripts/forge-package.sh`, whose postPackage `ditto`s over the running app (survivable, but not wanted mid-session). Do code in a `.worktrees/` worktree (the hook exits there), verify with `PATTON_NO_INSTALL=1 npm run package`, move main with `git merge --ff-only` (no post-commit), and commit on main itself only with `PATTON_NO_INSTALL=1` in the environment (the hook inherits it). That includes `/checkpoint`: run `checkpoint-commit.py` with `PATTON_NO_INSTALL=1` and `[no-release]` at the end of its `--message` (a notes-only push without it releases: S40, and again S61, which cut v1.38.1 with no code change) (S44: without it, the checkpoint commit reinstalled the app from main, which reported "1.15.1+1" until the tag was reinstalled).
- **The estate's guards read whole commands and the scripts they run** (S62). off-limits-guard denied a Patton check for prose naming `~/Projects` (fixed in central-claude-md, S117), and dcg refused `git push … && stat -f` as a force-push. Run `git push` as its own call; for a false guard deny, fix the guard, never reword a check to slip past it.
- **Anything that types into Claude gates on the live 7501 `blocked` fact, never a debounced copy** (S56). The compose box first held sends only once its 250 ms aside had begun, so an Enter in that gap approved the prompt's default option (second review, probe A1); broadcast had the same hole. Debounce what he sees, not what is sent.
- **A release job cancelled after about 15 minutes with no steps never got a macOS runner** (S67, v1.47.1; also S54). No tag was made, so `gh run rerun <id>` is safe; check `git tag --points-at <sha>` is empty first.
- **Chromium's `execCommand('insertText')` fires one `input` event per line of a multi-line text** (S68): never lay anything out per `input` event in a text field Patton fills; detail in `docs/compose-box.md` D19.

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
- The Dock keeps its own copy of the app icon → `build-and-install.md`


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
