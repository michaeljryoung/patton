# Patton

Always-passthrough terminal with a floating compose panel for drafting multi-line input.

## Tech Stack
- **Electron** (v44) with Vite 8 + TypeScript via Electron Forge (v8; needs Node 22.13+)
- **xterm.js** v6 (`@xterm/xterm`) — terminal rendering (WebGL addon)
- **node-pty** — PTY spawning in main process
- **electron-store** — persistent settings + history

## Architecture

```
src/
├── main/           # Electron main process (PTY, IPC, menus, settings store, bookmarks,
│                   #   project board, link-open policy, Claude Code hook installer, logger)
├── preload/        # contextBridge API (type-safe IPC bridge)
├── renderer/       # UI components, services, styles
│   ├── components/ # Tab, pane, terminal view, editor input, settings, command palette,
│   │               #   bookmarks panel, project board, tab hover card, etc.
│   ├── services/   # Tab manager, history, keybindings, program status (OSC 7501),
│   │               #   file/OSC 8 links, sessions, project boards, renderer logger
│   └── styles/     # CSS with design tokens + auto dark/light mode
└── shared/         # IPC channel constants, shared TypeScript types, shortcuts
resources/          # Shell integration scripts (zsh, bash) and the Claude Code Stop hook
scripts/            # forge-package.sh, release, health, check-*.mjs suites
```

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
A build is proven by the asar's mtime, not the exit code (Gotchas: Forge exit codes). `npm run check` (`scripts/run-checks.sh`, S46) runs every `scripts/check-*` and says which it skipped; until S46 none ran anywhere, and `check-close-guard.mjs` sat broken on main unnoticed. jsdom lives in a session scratchpad (S49 used `/private/tmp/claude-501/-Users-sparelaptop-Projects-betterterm/9465ed59-8ecb-4b39-9aa3-7c98657a3d46/scratchpad/jsdom`, 30.1.3); if it is gone, `npm i jsdom@30` in this session's scratchpad. A worktree gets `node_modules` by `cp -cR node_modules .worktrees/<name>/` (APFS clone, about 5 s), enough for lint, checks and a no-install package.

## Key Conventions
- All colors use CSS variables (`:root` + `@media prefers-color-scheme`)
- All interactive elements have ARIA attributes
- Resize observers are debounced (100ms)
- PTY data is write-coalesced (4ms buffer)
- electron-store needs CJS/ESM interop: `(mod.default || mod)`
- Entry files must match package.json `main` field naming: Forge 8's Vite plugin emits `.vite/build/main.cjs` and `preload.cjs`, so `main` is `.vite/build/main.cjs` and `window-manager.ts` loads `preload.cjs`

---

## Status
**v1.23.0 released, not installed (Session 50, 2026-11-12 09:59, from a Personal Finances — Stocks and Shares session): a project registered in the projects list is its own project even inside another repo, so a sub-project session (personal-finances/stocks-and-shares) no longer counts as an open session of its parent and opening the parent gives a new tab.** Commits `66ed001` (fix, 28 checks in `check-sub-project.mjs`) and `81442ec` (review follow-ups: no settings read or per-row realpath per lookup, ~36 µs a call; ctime/ino cache key; `realpathSync.native`; once-only logs; 51 checks); a fresh Sonnet review approved the first and asked for the second. Release run 43196071784 green; cask `e38b6bf2…` matches the DMG. /Applications still holds v1.21.0 until he quits Patton and says to install (from the tag). Before that: v1.22.0 (S49, 2026-11-12 00:10): no Resume all, paste thumbnails clear on send; tag `v1.22.0` = `0b22d80`. Next: THE MAP's `s49_ship` live checks after the install (now also: opening Personal Finances while a Stocks and Shares session runs gives a new tab), then `pause_ship`, `s47_ship` (⌘W twice on the last tab), `v115_verify`, `v114_verify`. Backlog: glob/minimatch advisories (after 10 Nov), S20 punch-list.

## Mission Synthesis
Patton is a macOS Electron terminal (xterm.js, node-pty) built to close the gaps Claude Code exposes in stock terminals: colour queries, contrast, attention signals, and finding your way across many parallel sessions. It ships as a DMG and a Homebrew cask, CI-versioned on every push to main (patch ≤500 lines, else minor; a head commit carrying `[no-release]` skips the push), now v1.23.0 on Electron 44.9.3 and Forge 8, with v1.21.0 still installed. A Claude pane's state comes from Claude Code's own OSC 7501 reports, the Stop hook and title glyphs a fallback behind a Settings switch: green means it needs him, the hollow ring means it waits on its own background work (also when 7501 says done while the hook still counts tasks), and yellow marks only the `wake` tab, which jumps to the far left once per run. The selected tab sits on the terminal's ground with an ink bar. Every new tab opens on a tile board of his projects (never a bookmark tab or a split, only while the list file exists); a tile or Wake acts in that tab, an already-open project activates its own tab, and a split board tab falls back to a new one. A folder's project is its nearest git repo unless the projects list registers a deeper folder inside it (since v1.23), so a sub-project such as personal-finances/stocks-and-shares runs as its own session beside its parent. Quit and close confirmations live in the app behind a 300 ms dwell, the native box only when the renderer doesn't answer, and the renderer closes through main because a page's own `window.close()` skips Electron's close event. Pause all types a bare `pause` into every Claude pane that can safely take it, on an allowlist of states, setting a draft aside with Claude Code's Ctrl+S stash and naming what it skipped; since S49 every press pauses and resume is typed by hand per tab. A pasted image's thumbnail clears when the message is sent. Michael works inside the installed app, so code lives in `.worktrees/`, builds stay out of /Applications until he quits (`PATTON_NO_INSTALL=1`, `--ff-only` merges), and an untried build launches first as "Patton Test". Next: the v1.23 install and the live checks back to v1.14, then the S20 punch-list; rare-task notes sit in `docs/reference/`. Lessons: measure in `main.log` rather than assume; a fresh review catches what builders miss; brief builders with the design settled.
## Session Log
### 2026-11-12 (Session 50 — v1.23.0: a registered sub-project is its own project; from a Personal Finances — Stocks and Shares session, released not installed)
- Michael: "I'm trying to open a personal finance session, and it's just taking me to this tab ... That's the whole point of our sub-project." Cause: `resolveProject` gave the nearest git root, so a session in personal-finances/stocks-and-shares had `project.root` personal-finances, and `openProject` matched it as an open session of the parent.
- `66ed001`: the deepest projects-list row inside the repo that contains the folder wins (`src/main/registered-projects.ts`, reusing the board's parser); a missing list keeps the old behaviour; linked worktrees unchanged. A fresh Sonnet review approved it and found each lookup now cost about 4.7 ms (an encrypted settings read per call). `81442ec` brought it to about 36 µs, keyed the cache on ctime and ino, used `realpathSync.native` and logged once; `check-sub-project.mjs` has 51 checks.
- Lint, tsc, `npm run check` 18/18, no-install asar; pushed, run 43196071784 green, v1.23.0, cask `e38b6bf2…` matches the DMG. Not installed: the notes commit's post-commit rebuild (with `PATTON_NO_INSTALL=1`) left /Applications at v1.21.0.

### 2026-11-11 (Session 49 — v1.22.0: no Resume all, paste thumbnails clear on send; from a Patton tab, released not installed)
- **Live log since the v1.21 install** (10 Nov 22:39 → 11 Nov 18:55): Pause all pressed once (5 panes, 3 queued, the shell skipped), Wake and ten tile clicks acted in the board's tab, the ring 71 times; written into THE MAP (`s47_ship`, `pause_ship`).
- **Resume all removed** (his screenshot of the strip: "i used pause all then manually resumed each tab but still says resume all in corner, i actually dont think we need the resume button, each tab a bit different"): every press pauses; Pause remaining, ⌥-click, the mode broadcast and the paused set gone. `71e5cbd`.
- **Thumbnails clear on send** ("sometimes thumnail screenshots are staying at bottom after message sent"): 18 of 24 image pastes went in mid-turn, where the only clear (not working → working) never fires; Enter, the empty box's Enter or Send, a broadcast Enter and his compose submit now clear, an Enter answering a prompt doesn't. `4b477b9`, `d4a8984`, `0b22d80`.
- **Process:** two Sonnet builders in parallel worktrees, a fresh review (approve; one minor reproduced in jsdom: the empty-box Enter), a fix builder; 17/17 checks, no-install asar 00:07; pushed, run 43125053418, cask `a8a7f765…` verified; not installed ("dont push live to this version tho as usual").

### 2026-11-10 (Session 48 — v1.21.0: a clearer selected tab, `wake` moves left, Pause all released and installed; from iTerm)
- **Selected tab** (his screenshot of three green-flagged tabs: "not very clear … which one's selected"): the selected tab sits on `--bg` with a 3 px ink bar on its bottom edge, bold kept; `check-ui-text-scale.cjs` +5 checks on the real CSS (the old styles fail 3). `6e72877`.
- **`wake` moves left** ("when one types our wake command, cna we also always shift it to first tab on left"): `TabManager.moveWakeTabFirst` on the WAKE title, once per run; `check-project-board-wire.mjs` +6 checks on a real TabManager (5 fail with the move off). `c5b711a`. Both built directly in `.worktrees/`, 16/16 checks, no-install builds, ff-merged.
- **v1.21.0 shipped** on "you can do the full update, push all live, update local etc" (Patton quit): run 42916200527 all green, cask `abf4e014…` matches the downloaded DMG; installed from the tag (reports 1.21.0, codesign ok, file list identical to `out/`), launched cleanly; his quit 8 s later asked once in the app (`s47_ship` evidence). Released before the live checks, on his word.
- **Not yet seen live:** Pause all with a draft, the skipped panes, Resume all, the selected tab in dark mode, `wake` jumping left.

### 2026-11-10 (Session 47 — the Pause all button, from a `~` session)
- **The ask:** after his shut laptop overheated with sessions' jobs still running, "can we actually add a button in patton in top right (pushing the checkpoint one to left) which pauses all tabs?"; then, on drafts, "even if there is text in the line we still need to pause but then ideally put the text back".
- **Built in `.worktrees/pause-all`:** builder (`8a59c5d`) → fresh review (request changes: default-allow pane states, a stale title-path stop flag, `pause` appended to drafts, skips counted not named, resume keyed by pane id only, late and dead windows, silent failures, hand-set test fields) → fix builders (`655ab78`, `6adaf6c`). Main-side unsent-input tracker in `PTY_WRITE` (`src/main/unsent-input.ts`), `stash-key.ts`, coordinator `src/main/pause-all.ts`, `src/renderer/services/pause-all.ts`; the checkpoint button uses the same stash path.
- **Verified:** lint, tsc, `npm run check` 16/16 (`check-pause-all.mjs` 122 checks on real Panes and main's real tracker), no-install asar 11:57:37; /Applications untouched (8 Nov 09:16). Merged to main `--ff-only` (no post-commit), worktree and branch removed; not pushed, not installed.
- **Process:** two fix builders ran out of context, one reading Claude Code's binary; the next two, briefed with the design settled (code first, then tests), landed.

_Earlier entries archived → `docs/session-archive.md` (latest trim 2026-11-12, S50)._

## Decisions
- **2026-11-12 (S49) — The strip's blank space is JS-driven, not a native drag region.** Michael: "make sure there is always a little space between the plus icon and Checkpoint ... so that I have somewhere to click" (to drag, and double-click to zoom). Whether Electron passes a double-click to the page inside `-webkit-app-region: drag` on macOS is unconfirmed (other Electron apps report it doesn't), so the space is `no-drag`, moves the window like the tab area already did, and a double-click asks main for the Mac's own title-bar action. The width (exactly the + button's) and the empty tab area getting the same double-click are my calls.
- **2026-11-11 (S49) — Pause all has no Resume all; a thumbnail clears on send.** Michael, after resuming each tab by hand left the button on Resume all: "i actually dont think we need the resume button, each tab a bit different". Supersedes S47's Resume all and Pause remaining: every press types `pause` into each pane that can take it, already-paused ones included (Claude just answers again; the scope-reminder hook keeps no state). On "thumbnail screenshots are staying at bottom after message sent": the send itself clears them (Enter, the empty box's Enter or Send, a broadcast Enter, his compose submit), except an Enter while Claude waits on a prompt, which answers the dialog and leaves the image in the draft; that exception is my call, not his words.
- **2026-11-10 (S48) — The selected tab gets the terminal's ground and an ink bar; `wake`'s tab moves left once per run.** Michael asked only that the selected tab be clear and that `wake` "always shift it to first tab on left". The treatment (`--bg` against the strip's `--surface`, a 3 px inset ink bar, bold kept, no colour of its own so it never reads as a flag) and the once-per-run rule (a drag while wake runs sticks, the tab stays put when wake ends, wake started again moves it again) are my calls, not his words: flip either if it reads wrong in use.
- **2026-11-10 (S47) — Pause all types the exact words, and a draft goes to Claude Code's stash.** The estate's scope-reminder hook acts only on a bare `pause` or `resume`, so the button sends those words rather than signalling processes. Michael: "even if there is text in the line we still need to pause but then ideally put the text back": Ctrl+S (`chat:stash` in Claude Code 2.1.321) sets the draft aside and Claude Code restores it after the submit. A pane where a stash may already exist (his own Ctrl+S in this session, Patton's not yet followed by his submit, a rebound key) is skipped and named, because Ctrl+S on an empty line brings back an old stash. (S49: Resume all removed, see the S49 decision.) Sending follows an allowlist of states, never default-allow.

- **2026-11-12 (S50) — A registered sub-project is its own project, not its parent repo's.** Michael, when Personal Finances kept opening his Stocks and Shares tab: "This should be able to run as a standalone at the same time. That's the whole point of our sub-project." The projects list decides: the deepest row inside the repo that contains the folder wins; without the list, the nearest git repo as before.

_Older Decisions archived → `docs/session-archive.md` (latest move 2026-11-07, S44 slimming; the index of earlier trims is under its "Archive pointers moved from CLAUDE.md" heading)._

_Older entries archived → `docs/session-archive.md` (latest move 2026-11-12, S49)._

## Gotchas
- **A second Patton shares the real one's userData unless its productName differs** (S45). There is no single-instance lock, so a build launched from `out/` would read and write Michael's settings, sessions, board layout and `main.log`. To launch an untried build safely: set `"productName": "Patton Test"` in `package.json` for that one build only (`git checkout package.json` after), run `out/Patton-darwin-arm64/Patton.app/Contents/MacOS/Patton` directly, read `~/Library/Application Support/Patton Test/logs/main.log`, `pkill -9 -f` on the `out/` path, and move that folder to the Trash (a guard blocks `rm -rf` there). It may leave a "Patton Test Safe Storage" keychain item. Opening a window is on the ask-first list.
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
- `docs/reference/build-and-install.md` — Forge exit codes, GitHub 504s, the CVE gate, hot-swap, reading the asar. Read before building, packaging or installing, or when a build or release step fails.
- `docs/reference/claude-state-and-links.md` — OSC 7501 probe, file-link policy, the `cc` startup command, OSC 133. Read before touching Claude state detection, file links, bookmark launch or the startup command.
- `docs/reference/fonts-and-rendering.md` — why 'SF Mono' never drew; `backgroundThrottling` and `document.hidden`. Read before touching fonts or any "is the window in view?" test.
- `docs/reference/testing-and-checks.md` — headless jsdom checks of renderer components. Read before writing one.
- `docs/reference/key-files.md` — where each feature lives, with its check scripts. Read to find the code for a feature.

## Key Files
Moved to `docs/reference/key-files.md` (S46 slimming): read it to find where a feature lives.

## Next Steps
See `docs/NEXT_STEPS.md`.
