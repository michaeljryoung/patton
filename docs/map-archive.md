# Retired map nodes

Finished nodes moved off this project's maps by `plan_graph_retire.py`, each row word for word under the date it moved. A map keeps its open work and the finished nodes that work depends on; the rest comes here once the map passes the ~20-node soft cap. An id here stays taken: rows on its map may still depend on it, and no new node there may reuse it. Spec: `~/.claude/references/plan-graph-spec.md` § Retirement.

<!-- MAP-ARCHIVE:BEGIN docs/NEXT_STEPS.md -->
## `docs/NEXT_STEPS.md`

### 2026-11-06 — 10 nodes

| ID | Task | Status | Depends on | Evidence |
|----|------|--------|------------|----------|
| `hook_script` | Stop-hook script shipped in `src/resources`: reads Claude Code's Stop JSON, emits `OSC 777;patton;stop;tasks=N;crons=M` via `terminalSequence` | done | — | `resources/claude-code-stop-hook.sh` · `scripts/probe-stop-hook.sh` green · `a5e7617` · `f703483` |
| `osc777_parse` | `terminal-view.ts` parses OSC 777 (`patton;…` → state events; `notify;…` → attention) | done | — | `src/renderer/components/terminal-view.ts::registerOscHandler(777)` · `a5e7617` |
| `image_paste` | ⌘V with a clipboard image: Claude pane gets Ctrl+V (`\x16`); other panes get the path of a PNG saved under Application Support; IPC reads the clipboard image | done | — | `src/main/clipboard-image.ts` · `src/renderer/components/pane.ts` capture-phase paste · `f7bb954` · `e778394` |
| `bookmarks_store` | electron-store `bookmarks` (`project` with path, `artifact` with URL), IPC get/set, validated | done | — | `src/main/bookmarks.ts` · `src/main/store.ts` · `1f8eba8` · `43cb3c7` |
| `bookmarks_panel` | Left docked panel (notes-panel pattern), registry shortcut, add current project / add artifact, rename, remove, reorder; open projects highlighted, active one emphasised | done | `bookmarks_store` | `src/renderer/components/bookmarks-panel.ts` · `f228caf` · `43cb3c7` |
| `look_mocks` | Five directions on one published page, each with Patton's chrome and a Claude session inside; note what Patton controls vs Claude Code | done | — | `docs/mocks/look-directions.html` · published https://claude.ai/code/artifact/f6ab1b78-e193-4e00-940a-594b5a01f5c2 |
| `look_mixer` | One live Patton window in the Trial Stack AI aesthetic with seven switchable components, three preset iterations, selection in the URL hash (pattern: defence-website `themes/martello-mixer.html`) | done | `look_mocks` | `docs/mocks/patton-mixer.html` · https://claude.ai/code/artifact/478e85b3-a125-4a6c-9cbd-36878c0d6ea2 |
| `look_implement` | Restyle tokens, tab bar, sidebar, compose, dialogs per the pick; terminal themes untouched | done | `look_pick` | `448d5ed` `5c4941c` `d540d76` · `src/renderer/styles/main.css` tokens · Send button in `editor-input.ts` |
| `compose_reason` | Report the recorded reason the compose panel is not the default input | done | — | `98a216e` · `0abba75` (ModeDetector removed 2026-03-09; terminal always owns input) |
| `compose_default` | Compose-first mode for Claude tabs behind a Settings toggle (default on) and a per-tab palette override; Enter/arrows/Tab/Esc pass through from an empty box, Esc hands focus over from a draft | done | `compose_reason`, `hook_script` | `cb38c2c` `6258544` `cd5fc68` `8af2355` · `src/renderer/components/pane.ts::canTakeKeyboard` · Settings toggle `composeFirst` |

### 2026-11-07 — 2 nodes

| ID | Task | Status | Depends on | Evidence |
|----|------|--------|------------|----------|
| `bookmark_reorder` | Rows drag within their group (projects among projects, links among links); blue insertion line, dimmed source, card drag image, hover grip; private drag type so a drop on the terminal types nothing; renders held during a drag; a drop that leaves the group's order unchanged is ignored | done | `bookmark_open` | `bookmarks-panel.ts::setupDragReorder` · `6ec77ff` · review fixes `f257583` (order shown at once, a move counts only when main stored it, stuck-drag release) · 47 headless jsdom checks of the real panel |
| `bookmark_hide` | Header chevron hides the sidebar; hidden, a 22 px strip with a boxed "+" (whole strip is the button) brings it back; ⌃⌘B toggles the same two states | done | `bookmarks_panel` | `bookmarks-panel.ts::setupRail` · `#bookmarks-rail` in `main.css` · `6ec77ff` |
<!-- MAP-ARCHIVE:END docs/NEXT_STEPS.md -->
