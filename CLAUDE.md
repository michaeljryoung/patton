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
A build is proven by the asar's mtime, not the exit code (Gotchas: Forge exit codes). `npm run check` (`scripts/run-checks.sh`, S46) runs every `scripts/check-*` and says which it skipped; until S46 none ran anywhere, and `check-close-guard.mjs` sat broken on main unnoticed.

## Key Conventions
- All colors use CSS variables (`:root` + `@media prefers-color-scheme`)
- All interactive elements have ARIA attributes
- Resize observers are debounced (100ms)
- PTY data is write-coalesced (4ms buffer)
- electron-store needs CJS/ESM interop: `(mod.default || mod)`
- Entry files must match package.json `main` field naming: Forge 8's Vite plugin emits `.vite/build/main.cjs` and `preload.cjs`, so `main` is `.vite/build/main.cjs` and `window-manager.ts` loads `preload.cjs`

---

## Status
**Main `caadc82` installed 2026-11-08 09:16 from main (reports 1.19.0+6); the same code was released as v1.20.0 at 10:38 after GitHub 504s on Electron's files failed five attempts (run 42466222395, attempt 6; cask `4bd781de…` matches the DMG).** S46 released v1.18.0 (Interface Text Size; no green while background work runs; install step prunes stale files and checks the signature; lint green after Forge 8) and v1.19.0 (⌘W closes through main), and put on main the in-app quit/close dialogs (⌘Q, red button) and the board acting in its own tab. Next: reinstall from tag `v1.20.0` only for the version label, at a quit he chooses; then THE MAP's `s47_ship` live checks, `v115_verify`, `v114_verify`. While he works inside Patton, commit in a `.worktrees/` worktree or with `PATTON_NO_INSTALL=1`; run `npm run check` before every merge. Backlog: glob/minimatch advisories (10 Nov), S20 punch-list.

## Mission Synthesis
Patton is a macOS Electron terminal (xterm.js, node-pty) built to close the gaps Claude Code exposes in stock terminals: colour queries, contrast, attention signals, and finding your way across many parallel sessions. It ships as a DMG plus a Homebrew cask, CI-versioned on push to main (patch ≤500 lines, else minor; a head commit carrying `[no-release]` skips the whole push), at v1.20.0 on Electron 44.9.3 and Forge 8 (installed from main before the tag, same code). A Claude pane's state comes from Claude Code's own OSC 7501 reports (Stop-hook verdicts and title glyphs are the fallback behind a Settings switch), with one exception S46 measured: when 7501 says done but the Stop hook still counts background tasks, the tab shows the hollow ring, S40's "waiting on its own work", not green. Every new tab opens on a tile board of his project list (the `cc` launcher's table stays the one registry); since S46 a tile and Wake act in that tab, main respawning its shell at the validated folder, and the Claude button types `FORCE_HYPERLINK=1 claude` there. Quit and close confirmations are in the app (⌘W twice, ⌘Q, the red button): Enter and clicks wait out a 300 ms dwell, the native box is only a fallback, and since a page's own `window.close()` skips Electron's close event, the renderer closes through main. SF Mono loads from the Mac's own Terminal.app; Interface Text Size scales the chrome, never the terminal; the checkpoint clock counts context since the last `/checkpoint`. Michael works inside the installed app, so builds stay out of /Applications until he quits (worktrees, `PATTON_NO_INSTALL=1`, `git merge --ff-only`) and `npm run check` runs every check before a merge. Next: the live checks piled up since v1.14, then the S20 punch-list; rare-task notes live in `docs/reference/`, each named in Reference docs with when to read it. Lessons: measure rather than assume (a one-minute probe settled `window.close()`); a fresh review, then a final review of the combined branch, each found what builders missed.
## Session Log
### 2026-11-08 (Session 46 — v1.17.0 installed, v1.18.0 and v1.19.0, in-app quit dialogs and the board in place; from 22:13 on 7 Nov)
- **v1.17.0 installed and checked live** (iTerm, Patton quit): the in-place `ditto` left Electron 44.7.0's `libEGL`/`libGLESv2`, which broke the signature (moved to the Trash); font picker, Claude button and ⌘W-twice tab close seen in `main.log` ("1-3 all working"). The install step now prunes stale files when Patton is closed and verifies the signature (`install-prune.cjs`); lint had been red since Forge 8 (ESM-only `exports`), fixed.
- **v1.18.0** (on "patton now shut so we can update etc"): Interface Text Size ("increase font size of patton platform text, not just the claude platform"); no green while background work runs ("why did this alert me green when isnt ready for me": 9 of 60 7501 greens followed a hook verdict with tasks > 0, `turn-end.ts`). Cask `63b31cd4…` verified.
- **v1.19.0:** after his in-app "Quit Patton?" the native box asked again ("it asked me to click quit anyway"); a hidden Electron probe showed a page's `window.close()` never fires `'close'`, so the guard and shell cleanup never ran (a non-last window's shells ran on unseen). The renderer closes through main, with a `'closed'` net; `npm run check` runs all checks (one sat broken on main). Cask `0f3b9365…` verified.
- **On main, installed 09:16 as 1.19.0+6:** board tiles and Wake act in the board's own tab ("it shouldn't open it in a new tab"); ⌘Q and the red button ask in the app ("Command-W should also work on the final screen"). Reviews found a split-tab major, stacked dialogs, an acked-but-gone quit and an instant-Enter quit (final combined review), all fixed; 15/15 checks. CI failed twice on GitHub 504s for Electron's files (before any tag); installed with a temporary `electronZipDir`, reverted.
- **Process:** every change in a `.worktrees/` branch, builder → fresh review → fix builder, nothing touching his running Patton; size pass moved the S42 entry and six decisions (⌘W-twice native guard, SF Mono, Claude button, Wake in a background tab, checkpoint clock, Stop hook over screen-reading) to the archive.
- **After that checkpoint:** v1.20.0 released 10:38 once GitHub recovered (a watcher waited for both Electron files to answer steadily; attempt 6, cask `4bd781de…` verified); CLAUDE.md slimmed 34,674 → 19,490 by moving rare-task gotchas, Key Files and the S43/S44 entries word for word to `docs/reference/` and the archive (`cf7fc73`).

### 2026-11-07 (Session 45 — v1.16.0 and v1.17.0: a real font, a Claude button, ⌘W twice, Forge 8)
- **Font fix** (Michael: "changing the font in settings doesnt seem to do anything", "make the font look more modern like the rest of patton"): a hidden-Electron probe showed `'SF Mono'` and `'Fira Code'` drew Menlo; main now reads SF Mono's faces from Terminal.app and the renderer registers them before any terminal opens; Font Family lists only fonts that draw (`check-fonts.cjs` 52). **Claude button** ("a button on our themes page in top right to just open a fresh plain claude session"): types `FORCE_HYPERLINK=1 claude` once the shell shows its first real prompt; any input cancels. **⌘W twice** closes a tab with Close focused; on the last tab "it should shut patton": an in-app "Quit Patton?" and a one-shot 5 s pre-confirmation, so main's guard asks once.
- **Forge 8 and the dependency pass** ("do it but make sure our existing patton sessions dont crash so wait if a risk"): Forge 7.11.2 → 8.0.1, Vite 5 → 8, CI Node 22, Electron 44.7.0 → 44.9.3, eslint and typescript-eslint; audit 57 → 28, prod 0. The package was compared part by part with Forge 7's, then launched once as an isolated "Patton Test" copy with his OK ("1 ok").
- **Released, not installed:** v1.16.0 (run 42407928968, cask `e8f721f2…`) and v1.17.0 (run 42410058567, CI's first on Node 22, cask `5bb18c6c…`), checksums verified. Seven builder branches in worktrees, each with a fresh review and a fix pass, plus a final review of the combined font and button branch (ship; 3 minors fixed). /Applications untouched all session (asar 17:59).
- **Mishaps:** a probe pointed Electron at a missing script, which can open its default window (stopped); `npx asar extract-file` from a worktree root overwrote its `package.json` again (restored); a builder put the no-release marker on two code commits (reworded before the push); the close-guard check flaked 2 in 12 on a fractional fake clock (`ecb7b70`).

_Earlier entries archived → `docs/session-archive.md` (latest trim 2026-11-08, S46 slimming: S44 and S43 entries)._

## Decisions
- **2026-11-08 (S46) — Quit and close confirmations are in the app; the native box is only a fallback.** Michael: "Command-W should also work on the final screen where it says … quit anyway", and an NSAlert can't take ⌘W. Supersedes S45's "⌘Q and the red button keep the native guard". Enter, a click, ⌘W or ⌘Q again confirm only after a 300 ms dwell (an Enter already in flight can't quit); the second ⌘W of his ⌘W-twice tab close stays instant ("press it twice, and it will close immediately"). A renderer that doesn't answer in 1.5 s gets the native box: never quit with live shells and no visible question.
- **2026-11-08 (S46) — The board acts in its own tab.** Michael: "when you click a project on this screen or click Wake, it shouldn't open it in a new tab. It should open it in that tab." Supersedes S44's new-tab tile click and Wake in a background tab. Main respawns the tab's shell at the validated folder (no typed `cd`; `PATTON_PROJECT_DIR` still set by main). An already-open project still activates its own tab (my call, not his words: flip it if he wants a second session in place); a split board tab falls back to a new tab.
- **2026-11-08 (S46) — A turn's Stop-hook task count still parks a 7501 "done".** 7501 reported turns done with no child tasks while Claude Code's own task list (the hook) had agents running; the ring is S40's "waiting on its own work". A verdict counts only for the turn it closed.
- **2026-11-08 (S46) — Interface Text Size scales Patton's chrome, never the terminal.** Michael: "increase font size of patton platform text, not just the claude platform". 90/100/110/125/150%; xterm and the compose text keep Font Size.
- **2026-11-07 (S45) — Installs wait for Michael's relaunch; an untried build launches first as "Patton Test".** His "wait if a risk": replacing the running app is the only step that could crash his sessions. Electron 44.9.3, not npm's 44.10.2: his `min-release-age` and the two-week rule, and 44.9.1+ already fixes the advisory.
- **2026-11-07 (S44) — Every new tab opens on the project board, the launch tab included; the startup command runs only when the board can't show.** Michael: "i want all new tabs to open on it". v1.15.0 had left the launch tab on the startup command, and he landed on `cc`'s picker. Bookmark tabs and splits never get the board, and it shows only while the list file exists, so other users see no change.
- **2026-11-07 (S43) — Claude Code's own status (OSC 7501) ships on, behind a runtime switch.** Its reports replace the glyph-and-hook inference, but they were proven only on synthetic input, so Settings → "Use Claude Code's own status reports" stops answering the probe and restores the v1.13 path without a rebuild: the compose-first precedent.
- **2026-11-06 (S40) — Parked is a hollow ring, yellow is only the `wake` tab.** Michael's answer to a colour scheme was "I don't understand this at all", so the simplest reading shipped: yellow means his `wake` command is running there; the ring means "waiting on its own background work, not on you".

_Older Decisions archived → `docs/session-archive.md` (latest move 2026-11-07, S44 slimming; the index of earlier trims is under its "Archive pointers moved from CLAUDE.md" heading)._


## Gotchas
- **A second Patton shares the real one's userData unless its productName differs** (S45). There is no single-instance lock, so a build launched from `out/` would read and write Michael's settings, sessions, board layout and `main.log`. To launch an untried build safely: set `"productName": "Patton Test"` in `package.json` for that one build only (`git checkout package.json` after), run `out/Patton-darwin-arm64/Patton.app/Contents/MacOS/Patton` directly, read `~/Library/Application Support/Patton Test/logs/main.log`, `pkill -9 -f` on the `out/` path, and move that folder to the Trash (a guard blocks `rm -rf` there). It may leave a "Patton Test Safe Storage" keychain item. Opening a window is on the ask-first list.
- **Every commit on main reinstalls /Applications/Patton.app, and Michael works inside it** (S41). The post-commit hook runs `scripts/forge-package.sh`, whose postPackage `ditto`s over the running app (survivable, but not wanted mid-session). Do code in a `.worktrees/` worktree (the hook exits there), verify with `PATTON_NO_INSTALL=1 npm run package`, move main with `git merge --ff-only` (no post-commit), and commit on main itself only with `PATTON_NO_INSTALL=1` in the environment (the hook inherits it). That includes `/checkpoint`: run `checkpoint-commit.py` with `PATTON_NO_INSTALL=1` (S44: without it, the checkpoint commit reinstalled the app from main, which reported "1.15.1+1" until the tag was reinstalled).
- **Main's IPC rate limiters refuse silently, so a burst caller loses data** (S43). `pty:get-cwd` (10/s) answered `''` past the limit and autosave saved it, so panes past the tenth reopened in `~` (v1.13.2); `settings:set` (10/s) dropped the last step of a slider drag or a held arrow (v1.14). Space burst calls (autosave refreshes cwds 120 ms apart), debounce rapid saves, and never persist a refused answer over a known value.
- **electron-store fills `defaults` only at the top level** (S42). Patton's settings are one nested object, so a field added later is absent from every saved file: read it as `=== true` (off by default) or `!== false` (on by default), never bare.
- **A new per-pane setting must be applied in `Tab.createPaneInstance`, not only to existing panes** (S40). Until `8af2355`, `Tab.setFont/Scrollback/Theme/Renderer/CopyOnSelect` looped over `_panes`, so a split pane got none of them — on the default DOM renderer a split silently ran WebGL. The review of compose-first found it; keep the values on `Tab` and apply them at pane creation.
- **A page's own `window.close()` never fires the BrowserWindow `'close'` event** (S46; measured on Electron 44.9.3: `webContents destroyed` → `closed` → `before-quit`). So the close handler in `window-manager.ts` (pre-confirmation, native box, `saveState`, `destroyByWindow`) never ran for ⌘W: after the in-app "Quit Patton?" the before-quit box asked again, and a non-last window closed by ⌘W left its shells running unseen. The renderer now closes through IPC `window:close` (`src/main/close-window.ts` → `BrowserWindow.close()`), a `'closed'` net ends any leftover PTYs, and `scripts/check-close-electron.cjs` pins the trap. Never close a window with DOM `window.close()`, and never tear a tab down before the close (S37: the guard asks only while its shells are alive).
- **The release workflow reads only the head commit's whole message for the no-release marker** (S37). A trailing docs commit carrying it, or a commit body that merely quotes it, skips the release for the entire push. Keep a code commit on top, or end with a marker-free `release:` commit. Builder agents add the marker to their own code commits unprompted (S45: both close-dialog commits carried it), so check `git log --format=%B origin/main..` for it before every push.
- **Renderer `console.*` calls don't reach `main.log` unless they go through `rlog()`** (S27). `src/main/logger.ts` only tees the main-process console. Any new `[RENDER]` or other diagnostic line you want in the file log MUST use `rlog()` from `src/renderer/services/renderer-logger.ts` — `console.info` alone reaches DevTools only and is invisible to packaged-app launches. This is exactly the gap that made S25's "is the periodic timer firing?" question unanswerable for ~10 days. `rlog()` keeps the DevTools console output too, so it's a strict superset of `console.*` for diagnostic purposes.


_Older Gotchas archived → `docs/session-archive.md` (latest move 2026-11-07, S44 slimming; the index of earlier trims is under its "Archive pointers moved from CLAUDE.md" heading)._


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
