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
**v1.27.2 released, not installed (S53, 2026-11-14):** a few tabs grow to fill the strip with their names centred, then compress as before (`tabs_fill`; run 43581526879 green, cask `d1c2094f…` matches the DMG). /Applications runs v1.26.1 (installed S51) until his word. Next: install on his word, then THE MAP's live checks `s53_ship`, `s52_ship`, `s49_ship` (main.log since 13 Nov shows most of it), `pause_ship`, `s47_ship`, `v115_verify`, `v114_verify`. Backlog: glob/minimatch advisories, S20 punch-list.

## Mission Synthesis
Patton is a macOS Electron terminal (xterm.js, node-pty) that closes the gaps Claude Code exposes in stock terminals: colour queries, contrast, attention signals and finding your way across many parallel sessions. It ships as a DMG and a Homebrew cask, CI-versioned on every push to main (patch ≤500 lines, else minor); the no-release marker is read from the head commit's whole message alone and skips the entire push, so a code commit goes on top and builder commits are checked for a stray marker before pushing. v1.27.2 (Electron 44.9.3, Forge 8) is released and v1.26.1 is installed. A pane's state comes from Claude Code's own OSC 7501 reports, with the Stop hook and title glyphs as fallback: green needs him, the hollow ring waits on its own background work, yellow marks the `wake` tab (moved far left once per run), red marks a finished checkpoint until he selects its tab. Every new tab opens on a tile board of his projects that acts in place. A tab is named for its project, the deepest projects-list row inside a repo, so a sub-project stands apart from its parent; a linked worktree carries its own name, keyed by its folder, else its short folder name. Quit and close confirmations live in the app behind a 300 ms dwell. Pause all types `pause` into Claude panes on an allowlist of states and stashes drafts first, where a false "has a draft" is the dangerous error. The checkpoint clock shows total context; its amber reminder counts growth since the last checkpoint. Every tab and its dot stay visible (his choice over scrolling): a few tabs share the strip's whole width with centred names, a full strip compresses them to their floors, names stop at 15 characters, and a blank space beside + works as a title bar. He works inside the installed app, so code lives in `.worktrees/` and installs wait for his word, built from the tag. Next: the live checks, then the S20 punch-list. Lessons: measure in `main.log` rather than assume; a fresh review with probes catches what builders miss; brief builders with the design settled.
## Session Log
### 2026-11-14 (Session 53 — v1.27.2: tabs share the whole strip; released not installed)
- Michael (screenshot of six short tabs, half the strip empty): "When there are fewer tabs than fill the whole bar, could we make them wider? ... they use up the full width and then compress as you get more." `9dd74aa`: tabs grow from their label's width by an equal share of the free room (the 220 px tab cap gone), names centred, a double-click anywhere on a tab renames it.
- Fresh Sonnet review: approve, but a 60-character name squeezed all 12 other tabs, a press-again-and-drag ended in a rename box, and a doc went stale. Fix builder `7cb927e`: label capped at 196 px, `dragMoved` guard, stronger centring check; every new check fails on the old code. `npm run check` 25/25 (`check-ui-text-scale.cjs` 141).
- Pushed; run 43581526879 green, v1.27.2, cask `d1c2094f…` matches the DMG. Not installed: he works inside v1.26.1.
- main.log since the v1.26.1 launch written into `s49_ship`: 21 thumbnails cleared on Enter, 2 title-bar zooms, 17 checkpoint marks cleared on select, 20 tab close confirms; Pause all unpressed since.
- A no-install package build in the worktree rewrote `index.html` and broke the next build (note in `docs/reference/build-and-install.md`, cause not traced); worktree and branch removed after the release.

### 2026-11-13 (Session 52 — v1.27.0 and v1.27.1: a worktree tab's own name, short worktree labels; released not installed)
- Start of session: v1.26.1 has run since 09:58, and main.log already shows most `s49_ship` live checks (14 `[PASTE] chips cleared` on Enter, 2 `[WINDOW] title-bar double-click` zooms, 9 `[CKPT] finished mark cleared` on select, 12 in-app tab close confirms); Pause all, `wake` moving left and ⌘W on the last tab unseen. Not yet written into THE MAP (offered as `/reality-check`).
- Michael (screenshot of a tab reading "LifeSci ⎇ next-venture-lifesci"): "this is supposed to be default clled LifeSci but is glitching". Cause, main.log 16:59:06: `Project renamed {"root":".../next-venture","name":"LifeSci"}`, because a linked worktree resolves to its main repo. `32f3dbf` + review fixes `c0e9367` (a bookmark from a worktree tab took the worktree's name over the parent's path): names keyed by the worktree folder, a named worktree shown alone. v1.27.0, run 43472940682, cask `6bd3ea39…`.
- On "yes auto names need to be even shorter so probably just the subfolder name": an unnamed worktree's strip label is its folder minus the parent's folder name ("lifesci"), cut at 15; the palette and screen-reader label keep "<parent> ⎇ <folder>". `c956c69` + review fixes `06e0a4f` (a blank label for a whitespace remainder, a Unicode prefix slip, a false comment about the hover card). v1.27.1, run 43478630946, cask `db51ce43…`.
- Not installed: Patton was quit, but no install word this session; /Applications reports 1.26.1. The "LifeSci" filed under `next-venture` stays ("its fine as long as lets me change it in future"); it clears from a tab in `~/Projects/next-venture`.
- Process: builder → fresh Sonnet review → fix builder, each in `.worktrees/`; `npm run check` 25/25 (`check-worktree-name.mjs` 76); notes `782834d`, `18c8d01`.

### 2026-11-13 (Session 51 — v1.26.1 installed)
- Michael: "lets do the update, update local, make sure git updated etc". Patton was quit (he ran this from iTerm); an orphaned `chrome_crashpad_handler` from the 10 Nov launch was still running out of /Applications, which would have made the install's prune step treat Patton as running, so it was stopped first.
- Built from tag `v1.26.1` in `.worktrees/install-v1.26.1` (`npm run install-app`): /Applications reports 1.26.1, asar 09:29:50, `codesign --verify --deep --strict` passed, file list identical to `out/`, asar literals for the drag space, thumbnail clear and checkpoint mark present. Main already matched origin; the tag differs from main only in notes.
- Notes pushed as `dfc008f` (no-release marker; its post-commit rebuild ran no-install and left /Applications at 09:29:50); the install worktree removed. The orphaned crash reporter is now a note in `docs/reference/build-and-install.md`. Checkpoint trim: the S49 v1.22.0 entry and five S49/S50 decisions to the archive, 20,321 → 16,181 chars before this entry.

### 2026-11-12 (Session 49, continued — v1.24.0 and v1.24.1: a drag space beside +, a red circle when a checkpoint finishes; released not installed)
- **Drag space** (his screenshot of a full strip: "there's nowhere I can click in the top bar ... always a little space between the plus icon and Checkpoint ... only has to be as wide as the plus icon"): a blank `no-drag` space as wide as + moves the window by JS, and a double-click there or on the empty tab area asks main for the Mac's title-bar action (`src/main/title-bar-action.ts`). Review found focus leaving the terminal on a press and a drag ending in a zoom; fixed. `1cb4963`, `9858846`; v1.24.0, run 43256904199, cask `a81e5728…`.
- **Red circle when a checkpoint finishes** ("it goes red, but with the circle red, not the square ... disappear when I click on the tab"): the Stop hook's `cpt` newer than what he has seen this session. Review replayed his logs: ~8% of checkpoints end with tasks running and a wake-up turn wiped the mark for good; also a flag plus circle overflowing a squeezed tab and a one-second boundary miss; all fixed. `fdb74d0`, `d035df7`; v1.24.1, run 43267719809, cask `610dddc1…`.
- **"weve fixed this right?"** (a thumbnail left after a queued mid-turn send): yes from v1.22.0, but /Applications still runs v1.21.0; the install waits for his quit.
- **Process:** builder → fresh Sonnet review (hidden-Electron probes, log replays) → fix builder, each in `.worktrees/` with `cp -cR` node_modules; 21/21 checks, no-install builds; `check-project-board-ui.mjs` failed once in one full run and passed the next 13 (unreproduced).
- **Slimming** (on "2 do the trim"): the source tree, the "Patton Test" launch gotcha and the jsdom/worktree note moved word for word to `docs/reference/`, the S48 entry and two decisions to the archive, Status and the synthesis rewritten tighter: 21,013 → 16,728 chars (`04ca521`).
- **Tab names** (three screenshots: "really, really long names ... 10 to 15 characters max"; "a lot of space to the left"; "should be a rename option on tabs that arent projects"): Claude-titled tabs ≤ 15 characters, the hidden grip's 14 px given to the name, Rename Tab… on non-project tabs; a ≥ 5-letter floor was built and reverted on his choice "All tabs visible". v1.25.0 (`49f9fd8`, cask `78158827…`).
- **Slimmer strip** ("2 ok"): Pause all as an icon with its result in a popover, the × only on hover, floors scaling so the × never covers the dot; 13 tabs fit from ~860 px (was ~1200). Review caught dot clicks closing squeezed tabs from ×1.25, an erased ink bar, the × over a rename box and results pushing tabs off screen; all fixed, eleven mutations each fail the check. v1.26.0 (`fc2e8b7`, cask `82e0c7b5…`). The reviewer hit the 5-hour usage limit mid-run and was resumed by message after his `/login`.
- **Clock shows total context** ("why is the checkpoint % top right so different to bar"; then "I think the relevant stat is what the total context percentage is that's been used"): the clock had shown growth since the last checkpoint (main.log: total 80.3%, since 6.5% → "+7%"); it now shows the total, the amber reminder still counts growth. v1.26.1 (`f648f01`, cask `a6659648…`).

_Earlier entries archived → `docs/session-archive.md` (latest trim 2026-11-14, S53)._

## Decisions
- **2026-11-14 (S53) — Tabs grow from their own label's width, not to equal widths.** Michael asked that tabs "use up the full width and then compress" as Terminal's do. Equal widths would cut long names sooner whenever the strip is part full; an equal share of the free room added to each label's width gives near-equal tabs when few are open and leaves the crowded strip exactly as before (his S49 "All tabs visible"). My calls: names centred as in Terminal; a label capped at 196 px (the old 220 px tab less padding) so one long name can't squeeze the rest; a double-click anywhere on a tab renames it, since the title no longer spans the tab.
- **2026-11-13 (S52) — A linked worktree's tab name is its own; an unnamed one shows only its short folder name on the strip.** Michael: "this is supposed to be default clled LifeSci", then "auto names need to be even shorter so probably just the subfolder name". Names stay in the one `projectNames` map, keyed by the worktree's folder, so the parent and sibling worktrees are untouched. My calls: no ⎇ and no parent name on the strip, the long "<parent> ⎇ <folder>" kept in the palette and screen-reader label; a bookmark made from a worktree tab keeps the parent's path and name; the "LifeSci" already filed under `next-venture` is not migrated (his "its fine as long as lets me change it in future").

_Older Decisions archived → `docs/session-archive.md` (latest move 2026-11-07, S44 slimming; the index of earlier trims is under its "Archive pointers moved from CLAUDE.md" heading)._

_Older entries archived → `docs/session-archive.md` (latest move 2026-11-14, S53)._

## Gotchas
- **Every commit on main reinstalls /Applications/Patton.app, and Michael works inside it** (S41). The post-commit hook runs `scripts/forge-package.sh`, whose postPackage `ditto`s over the running app (survivable, but not wanted mid-session). Do code in a `.worktrees/` worktree (the hook exits there), verify with `PATTON_NO_INSTALL=1 npm run package`, move main with `git merge --ff-only` (no post-commit), and commit on main itself only with `PATTON_NO_INSTALL=1` in the environment (the hook inherits it). That includes `/checkpoint`: run `checkpoint-commit.py` with `PATTON_NO_INSTALL=1` (S44: without it, the checkpoint commit reinstalled the app from main, which reported "1.15.1+1" until the tag was reinstalled).
- **Main's IPC rate limiters refuse silently, so a burst caller loses data** (S43). `pty:get-cwd` (10/s) answered `''` past the limit and autosave saved it, so panes past the tenth reopened in `~` (v1.13.2); `settings:set` (10/s) dropped the last step of a slider drag or a held arrow (v1.14). Space burst calls (autosave refreshes cwds 120 ms apart), debounce rapid saves, and never persist a refused answer over a known value.
- **electron-store fills `defaults` only at the top level** (S42). Patton's settings are one nested object, so a field added later is absent from every saved file: read it as `=== true` (off by default) or `!== false` (on by default), never bare.
- **A new per-pane setting must be applied in `Tab.createPaneInstance`, not only to existing panes** (S40). Until `8af2355`, `Tab.setFont/Scrollback/Theme/Renderer/CopyOnSelect` looped over `_panes`, so a split pane got none of them — on the default DOM renderer a split silently ran WebGL. The review of compose-first found it; keep the values on `Tab` and apply them at pane creation.
- **Renderer `console.*` calls don't reach `main.log` unless they go through `rlog()`** (S27). `src/main/logger.ts` only tees the main-process console. Any new `[RENDER]` or other diagnostic line you want in the file log MUST use `rlog()` from `src/renderer/services/renderer-logger.ts` — `console.info` alone reaches DevTools only and is invisible to packaged-app launches. This is exactly the gap that made S25's "is the periodic timer firing?" question unanswerable for ~10 days. `rlog()` keeps the DevTools console output too, so it's a strict superset of `console.*` for diagnostic purposes.
- **A linked worktree resolves to its main repo, so anything keyed by `project.root` is shared by the repo and every worktree** (S52). The tab-name store was: a name set from the LifeSci worktree's tab renamed `next-venture` and its Defence worktree too (fixed in v1.27.0 by keying on `worktree.path`). Before keying new per-project state on `root`, decide whether a worktree should share it.


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
