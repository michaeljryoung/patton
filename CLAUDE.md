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
**S63 (24 Nov): v1.40.0 installed and walked through; the next release carries the compact wake tab, wrapped session bar rows, the checkpoint circle held only by its own work, and the P1 icon (all reviewed, full verifier green on `integrate/s63`).** Install it from its tag with Patton quit on his word (`s63_install`). Then the try-out page for a busy-tab mark and multi-select tabs (`working_mark`, `tab_multiselect`). Backlog: S20 punch-list.

## Mission Synthesis
Patton is a macOS Electron terminal (xterm.js, node-pty) that closes the gaps Claude Code leaves in stock terminals: attention signals, comfortable writing, finding your way across many parallel sessions, and reviewing the Word documents Claude writes. It ships as a DMG and a Homebrew cask, CI-versioned on every push to main (the no-release marker is read from the head commit alone; over 500 changed lines is a minor bump). He works inside the installed app, so code lives in `.worktrees/`, main moves by fast-forward, and an install waits for his word with Patton quit, proven by the asar's mtime, codesign and Info.plist. A pane's state comes from Claude Code's OSC 7501 reports with the Stop hook as fallback, and main follows each Claude tab's transcript for the session bar, page titles, clean copy and the turn-end ring. Everything that types into Claude gates on the live `blocked` fact. Pause all now types only where work runs (a turn, a background task, a Stop verdict saying tasks or timers remain), erring toward sending, because a loop left running on a shut lid once overheated his MacBook. A tab carries its project's name only while Claude runs in it; a shell shows the command running now, else "Terminal", bounded by OSC 133 prompt marks. v1.34.0 to v1.39.0 went in together on 24 Nov (S63) and none has been seen live by him yet: room below for long drafts, the session bar, his sound and box-fill picks, page titles, the review tab (LibreOffice layout, pdf.js, comments into the .docx, Send to Drive by the Drive API with his personal gcloud login, since rclone's `gdrive:` is the read-only Lindus Drive), group shades, clean copy, the Esc restore and S62's two asks. Next: a walk-through of each change with him, then the live checks. Lessons: he tries anything he will see or hear before it ships; every change gets a fresh review with probes, and nearly every review finds real defects; fix every finding in small slices with targeted checks.
## Session Log
### 2026-11-23 (Session 62 — "Terminal" tab names, Pause all only where work runs, a reality check; v1.39.0 released, not installed)
- His screenshot of a shell tab reading "AI-Brain" ("when a tab is terminal that ive had to do it should name terminal not the thing prompt is about"): a tab takes its project's name only while Claude runs in it; a shell shows the command running now, else "Terminal" (`Pane.shownTitle`, OSC 133 marks); the menu acts on `Tab.menuProject`. Three reviews: the first two designs (rewriting the title when Claude left, then remembering Claude's last title) each failed on probes, the second because a second session in one pane brought the old topic back.
- His screenshot of a quiet chat answering a Pause all "pause" ("it should only do stuff where claude is working not pointlessly post to quiet chats"): `pauseInput().running` decides, from a turn, a working child, a parked pane or a kept Stop verdict. Three reviews: the dot's activity word had hidden an error root with work and drained children with a `/loop` left.
- His "2 do this in parallel": a fresh auditor's `/reality-check` of all five maps, 47 done rows opened, one wrong (`okay_button` superseded); `bar_ship` done on the `[COMPOSE] place` lines; review-tab evidence made resolvable; the map's goal now the install and walk-through, with nodes for the unmapped S60–S61 work.
- Verifier 54/54 with a no-install build on `276e1b0`; v1.39.0 released (run 45275722462, cask `dc2b68a9…` equals the DMG's digest); the notes commit `9b6e2a5` skipped release as meant. /Applications untouched (20 Nov build).
- off-limits-guard (central-claude-md) falsely blocked `check-worktree-name.mjs`; fixed and hardened there at his "2 do it" and "2 ok" (its S117 entry); every step of tomorrow's install passes it.

### 2026-11-22 (Session 61 — tried with him before shipping; page titles, the review tab, clean copy, the Esc restore, the ring; v1.36.1 → v1.38.0 released, not installed)
- His "you didn't even test the notification charm with me ... Did you just build them all without testing anything?": a try-out page playing the real `notification-sound.ts` (https://claude.ai/code/artifact/f74647ea-0491-4524-b765-4046100061bf) gave "low marimba" and box fill B, v1.36.1. The global rule on taste decisions now names looks and sounds (provenance in central-claude-md `35eaaa1`).
- Artifact bookmarks: Chrome's history showed every click opened the page; the failure was the claude.ai login, outside Patton ("not one to do here"). His "3 yes": page titles on artifact bookmarks and session-bar links (two reviews), v1.37.0, with the long-draft history log fix.
- His later asks, each built in its own worktree, reviewed fresh, fixed, then merged on `integrate/s61`: group shades (B, picked on https://claude.ai/code/artifact/80e4187e-da0c-4482-90d9-46ac54ea1c36), clean copy, the Word-document review tab (`docs/review-tab.md`), the Esc double-send (D18; the joined message read in his outreach transcript), the House ring (Claude Code keeps its root `working` while a subagent runs), three long-draft fixes from his screenshot, no blue open dot in bookmarks. Reviews found two criticals in the review tab (a space in the soffice profile path; a .docx with tracked changes corrupted on save) and a Pause-all stash loss; all fixed.
- Send to Drive tested once for real on his yes: personal account, the test doc deleted, an empty `Patton` folder left. Preview page https://claude.ai/code/artifact/ee7b5553-4a3f-4f2a-ac33-189f8f22c6b7; his "nice": main fast-forwarded to `1e270d6`, v1.38.0 released, cask `218b4a84…` equals the DMG's digest. /Applications untouched (20 Nov build).

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

_Earlier entries archived → `docs/session-archive.md` (latest trim 2026-11-24, S62)._

## Decisions
- **2026-11-22 (S61) — Anything he will see or hear is tried by him before it ships.** A page built from the real code (the sound module bundled, the box fill, group shades, a preview of real renders) goes to him first, and the release waits for his word: S60 had shipped a default sound nobody had heard.
- **2026-11-23 (S62) — Pause all errs toward sending.** A Stop verdict saying tasks or timers remain is kept until a newer verdict or Claude leaves, never cleared when a turn starts: an Esc or an API error ends a turn with no Stop, and forgetting a `/loop` leaves it running on a shut lid. At worst a quiet chat gets one extra "pause" after an interrupted turn.
- **2026-11-23 (S62) — A shell tab shows the command running now, else "Terminal".** Rejected after reviews: rewriting `pane.title` when Claude leaves (a 2 s timing guess missed titles) and remembering Claude's last title (a second session with the same or no title brought the old topic back). Prompt marks bound a title's life to its command; without OSC 133, titles set while Claude ran stay hidden.

_Older Decisions archived → `docs/session-archive.md` (latest move 2026-11-07, S44 slimming; the index of earlier trims is under its "Archive pointers moved from CLAUDE.md" heading)._

_Older entries archived → `docs/session-archive.md` (latest move 2026-11-24, S62)._

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
- **Patton writes Ctrl+C to Claude only on an `idle` root, 2 s after the last Enter, over a bar that provably holds the expected text** (S61). Ctrl+C on Claude's empty bar or on a working Claude interrupts the turn, and `working` can come 763 ms after a send; D18's restore waits out the 2 s and otherwise leaves the text in Claude's bar with the note (`ctrlCRefusal` in `pane.ts`, `docs/compose-box.md` D18).
- **The box finds Claude Code's bar on screen, so a Claude Code redesign of that bar quietly puts the box back under the terminal** (S58). `services/claude-bar.ts` needs the cursor's row to start with `❯` between two all-`─` rows; Claude's hint text is dim, his typed text is not. When the box stops covering the bar, `grep '\[COMPOSE\] bar not found' main.log` gives why (no-glyph, no-rule-above, no-rule-below); then re-record `scripts/fixtures/claude-bar-screens.json` from the new Claude Code (a pty capture with `--settings '{"disableAllHooks":true}'`; run from inside a Claude session, its transcripts stay off).
- **After Patton resizes a terminal, Claude's bar is unreadable until Claude redraws** (S60). xterm's shrink drops the lines below the cursor first, which takes Claude's lower rule and footer; Claude repaints only the visible screen on any resize. Anything keyed on the bar's row waits for the first fresh reading after Patton's own resize (the compose box's "settling", D15), never for a fixed delay.
- **A hook's `terminalSequence` over 4096 bytes is dropped whole by Claude Code** (S60, read in 2.1.321). The Stop hook keeps its sequence under 3,500 by cutting its lists, never the sequence; a renderer that reads a list must treat a short one (fewer items than `tasks`) as cut.
- **Claude Code keeps its 7501 root `working` after a turn ends while a subagent it launched still runs** (S61, 2.1.321). No `done` comes until the subagent's `<task-notification>` starts the next turn, so a pane that waited for `done` showed nothing for the whole run (House tab, 22 Nov). A Stop verdict over a working root with working children is the turn end (`turnEndedOverWork` in `services/turn-end.ts`); his send, or the transcript feed's `turn-activity` (a Stop another hook blocked, a new assistant line), is the next turn's only sign, since the root already reads working. So the ring shows only on a pane whose feed main has attached; a blocked Stop's line can arrive before the verdict, and a `/` or `!` line he sends may start no turn. Background shells still get their `done`. An Esc that stops a turn sent over it changes nothing in 7501 either (the root stays `working`): D18's restore reads Claude's bar instead (`planHoldsSent`).
- **Fit the terminal through `services/terminal-fit.ts` (`fitGrid`), never `fitAddon.fit()`** (S58). The addon sizes from the container's computed size, which under `border-box` includes `.terminal-container`'s padding: at UI scale 1.5 the last row was cut by 2.4 px.


_Older Gotchas archived → `docs/session-archive.md` (latest move 2026-11-07, S44 slimming; the index of earlier trims is under its "Archive pointers moved from CLAUDE.md" heading)._

_Older entries archived → `docs/session-archive.md` (latest move 2026-11-24, S62)._

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
