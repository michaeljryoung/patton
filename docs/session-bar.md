# Patton — The session bar

<!-- MAP:BEGIN -->
## 🗺 THE MAP — S60: a permanent session bar on the right of every Claude tab

**Goal:** (S60) A bar on the right of every Claude tab lists what the session has running (agents, shells, monitors, workflows), its loops, its failures, the links Claude gave him, and the checkpoint clock moved from the tab strip; a ⇥ button minimizes it to a strip (Michael 2026-11-22: "it has a bar on right that lists various things including background tasks ... atm theyre hidden at the bottom"; on sketch v3 https://claude.ai/code/artifact/08d6e409-4c7d-4f4e-8fe1-ceb84b75c586: "do it").
**Done when:** an end-to-end check written by an agent that didn't build drives a fake Claude session (a process with `~/.claude/sessions/<pid>.json` and a growing transcript under a temporary HOME) through the real Pane in hidden Electron and shows: a background shell's row within 1 s of its start line and struck through within 1 s of its notice and gone after its 30 s linger; a failed task's row kept until its × is pressed; a link written twice listed once, and a `v2` file replacing its `v1`; the checkpoint clock in the bar and not on the tab strip; ⇥ folding the bar to the strip and ⇤ restoring it; at UI scale 1, 1.1 and 1.5. Plus lint, `tsc`, `npm run check`, a no-install package and a fresh review with no open major; released by CI; installed only on his word.
**Last verified:** 2026-11-22 (Session 60: built, checked, reviewed and released as v1.35.0 and v1.36.0; statuses checked against the tags and casks)

```mermaid
flowchart TD
  subgraph D["Design"]
    bar_design[design D1–D13, contract types]:::done
  end
  subgraph S["Sources"]
    session_link[pane to session and transcript]:::done
    transcript_feed[transcript feed: tasks, ends, links, wake-ups]:::done
    hook_lists[Stop hook sends task and loop lists]:::done
  end
  subgraph B["The bar"]
    bar_model[bar state per pane]:::done
    bar_ui[bar, minimize strip, narrow fold]:::done
    ckpt_move[checkpoint clock moves into the bar]:::done
  end
  subgraph V["Verify and ship"]
    bar_e2e[end-to-end check by a fresh agent]:::done
    bar_review[fresh reviews, no open major]:::done
    bar_release[merge, push, CI release, cask]:::done
    bar_ship[install on his word, live check]:::live
  end
  bar_design --> session_link
  bar_design --> transcript_feed
  bar_design --> hook_lists
  bar_design --> bar_model
  session_link --> bar_e2e
  transcript_feed --> bar_model
  hook_lists --> bar_model
  bar_model --> bar_ui
  bar_ui --> ckpt_move
  ckpt_move --> bar_e2e
  bar_e2e --> bar_review
  bar_review --> bar_release
  bar_release --> bar_ship
  classDef done fill:#1a7f37,color:#fff
  classDef live fill:#0969da,color:#fff
  classDef todo fill:#8c959f,color:#fff
  classDef blocked fill:#cf222e,color:#fff
  classDef dropped fill:#eaeef2,color:#57606a
  classDef superseded fill:#eaeef2,color:#57606a
```

| ID | Task | Status | Depends on | Evidence |
|----|------|--------|------------|----------|
| `bar_design` | D1–D13 below; the contract types and IPC names in `src/shared/session-feed.ts` | done | — | `docs/session-bar.md` · `src/shared/session-feed.ts` |
| `session_link` | D8: main finds a pane's Claude process, its `~/.claude/sessions/<pid>.json`, and the transcript; re-resolves on `/clear` and resume; the Stop hook's `tp` as a fallback | done | `bar_design` | `src/main/session-link.ts`, `session-feed.ts`, `session-feed-ipc.ts` · `scripts/check-session-link.mjs` (live, temporary HOME), `check-session-feed-ipc.mjs` (not yet reviewed) |
| `transcript_feed` | D9: main tails the transcript and sends `SessionFeedEvent`s (task start and end, links, wake-ups, attach and detach) to the pane's renderer; pure parser with fixtures | done | `bar_design` | `src/main/transcript-parser.ts`, `transcript-tail.ts` · `scripts/check-session-feed.mjs` 26 over `scripts/fixtures/session-feed-lines.jsonl` · `e8de922`, `bbb3cae`, `f602ef2` (not yet reviewed) |
| `hook_lists` | D10: the Stop hook adds `tl`, `cl` and `tp`; the renderer parses them; probe cases and a size cap | done | `bar_design` | `5db181c`: `resources/claude-code-stop-hook.sh` sends `tl`/`cl`/`tp`; `scripts/check-hook-lists.mjs` 55; `probe-stop-hook.sh` 111 |
| `bar_model` | D3–D6: per-pane state merging 7501 children, the feed and the Stop lists; ended rows linger 30 s; failures until dismissed; links keyed and versioned; pure, with checks | done | `bar_design`, `transcript_feed`, `hook_lists` | `scripts/check-session-bar-model.mjs` 72 ok (a list the hook cut ends nothing), S60 |
| `bar_ui` | D1, D2, D11: the bar beside the terminal on Claude tabs, ⇥ and the strip, narrow fold, persisted per window, ARIA, `[BAR]` logs; layout check at UI scale 1, 1.1, 1.5 | done | `bar_model` | `check-session-bar-layout.cjs` 96 ok (32 a scale), all 96 fail on `0f4e3dd`, S60 |
| `ckpt_move` | D7: the checkpoint clock and its button leave the tab strip for the bar and the strip; tabs keep the red circle | done | `bar_ui` | no `.tab-bar-checkpoint` (`scripts/check-session-bar-layout.cjs`, `scripts/check-tab-strip-dblclick.mjs`, `scripts/check-pause-all.mjs`, `scripts/check-ui-text-scale.cjs`: 13 tabs fit from 810 / 880 px), S60 |
| `bar_e2e` | D13's end-to-end check, written by an agent that didn't build; every assertion fails on main | done | `session_link`, `ckpt_move` | `scripts/check-session-bar-e2e.cjs` 57 ok, 0 not ok in `npm run check` on `feat/sb-barui` (real pty, session feed, TabManager and bar in hidden Electron, UI scale 1, 1.1, 1.5), S60 |
| `bar_review` | Fresh reviews with probes until no open major | done | `bar_e2e` | three fresh reviews with probes: 0 major / 6 minor, fixed in `41ff187`, `7e3b2f6`, `4520173`; then 0 major; then the final one, 0 major / 3 minor (a stale `tp` hint re-attaching an exited session, a transcript swapped for a symlink, a refused Checkpoint click invisible on the strip) plus 2 nits, fixed in `5f8ab6d` with assertions failing before (`scripts/check-session-feed-robust.mjs` 29 ok, `check-session-bar-layout.cjs` 102 ok); `scripts/probe-stop-hook.sh` 111 ok |
| `bar_release` | Merge by fast-forward, push, CI release, cask matches the DMG | done | `bar_review` | v1.35.0 tag at `ce48413`, cask `1300f5ac…` matches the DMG; the final fixes, bookmarks and sound as v1.36.0 at `613f9a8`, cask `31e8b956…` matches |
| `bar_ship` | Install on his word with Patton quit; live: `[BAR] attach` lines, a shell row appears and goes, a link listed, the clock in the bar | live | `bar_release` | S60: released, not installed (/Applications v1.33.0); waits on his word with Patton quit |
<!-- MAP:END -->

## Design (settled with Michael, 22 Nov 2026, sketch v3)

His choices: permanent, with a minimize button, not a shortcut ("not a shortcut, a button with minimize, i hate hvaing to remember"); Running, Scheduled, Failures, Links and the checkpoint; no checklist (0 of his 61 sessions in four days kept one) and no changes ("i dont think changes is helpful"); links "should replace if newer version of a link are shared"; "failures or issues is a good idea"; "move the checkpoint button into this out of top bar"; shells live (yes to a hook; see D10 for why none is needed). Everything else below is method.

- **D1. Where.** One bar per window, on the right of the tab content, below the tab strip, shown while the active tab's focused pane runs Claude Code (7501 `app=claude-code`, else the Claude title fallback); hidden for a plain shell, the board and `wake`. Width 248 px × the UI text scale; ink hairline on its left; Patton's UI font and tokens. Header "Session" (plus the pane's project name when the tab holds more than one Claude pane) and a ⇥ button (`aria-label` "Minimize the session bar"). The terminal fits in what is left, through `fitGrid` only. Switching tabs never resizes a terminal that was already fitted with the same bar state.
- **D2. Minimized.** ⇥ folds the bar to a strip 26 px × the UI scale: a ⇤ button (`aria-label` "Open the session bar"), the running count, the failure count (red when above 0), and a small checkpoint button whose tooltip carries the context %. The choice is per window, kept across relaunch with the window's state, and changed only by those two buttons. When the terminal would be under 80 columns with the bar open, the bar shows minimized without changing the saved choice.
- **D3. Running.** Rows: kind (Agent, Workflow, Teammate, Cloud, Shell, Monitor), description (one line, ellipsis; the full text and a shell's command in the tooltip and accessible name), age ("40 s", "6 min", "3 h 34", tabular; refreshed every 10 s). Over an hour: the accent colour. Oldest first. An ended row stays 30 s struck through, then goes. Sources: agents, workflows, teammates and cloud sessions from 7501 child records (live, already parsed); shells and monitors from the transcript feed (D9), reconciled at every Stop with the hook's list (D10): an id missing from the list ends, an unknown listed id is added from the list's own fields. Without a transcript, the Stop list alone.
- **D4. Scheduled.** Loops and crons from the Stop hook's `cl` (id, schedule, recurring, prompt): kind "Loop" or "Cron", the prompt cut to 60 characters, and the next fire time (HH:MM, local) from the 5-field schedule; one that doesn't parse shows the schedule itself. One-off wake-ups from the transcript's ScheduleWakeup calls (D9), dropped once their time passes; if `cl` also lists them, one row.
- **D5. Failures.** A row when a background task's notice reports it failed or was killed (with the exit code when given), or when 7501's root record reports `error` (its `msg`). Kind, description or message, time, and a × button (`aria-label` "Dismiss"). Kept until dismissed; at most 10 per pane, oldest dropped. Not kept across relaunch.
- **D6. Links.** Taken from Claude's own text in the transcript (assistant messages only): claude.ai artifact URLs, Google Docs, Sheets and Drive URLs, GitHub release and pull-request URLs, and absolute or `~` paths under `~/Downloads` ending in .docx, .pdf, .xlsx, .pptx, .csv, .html or .png. Label: the markdown link text when there is one; else, for a page, "Page" and the id's first 8 characters; for a file, its name. A URL is keyed by itself (trailing punctuation stripped): shared again, its row moves to the top with the new time. A file is keyed by its name, lower-cased, with version marks removed (` v2`, `-v3`, `_v4`, ` (2)`) and its extension kept: a newer one replaces the older row. Newest first, at most 8. A click opens it through `link-open-policy` (main), never directly.
  - *Page titles (22 Nov 2026):* a page link with only the made-up "Page <id start>" label shows the page's own `<title>` once main has learned it (from the published file, else the Artifact call's `input.title`; `src/main/page-titles.ts`, read in the renderer through `services/page-titles.ts`); a markdown label Claude gave still wins. The same titles name artifact bookmarks. Where it lives and its checks: `docs/reference/key-files.md`, Page titles.
  - Word, Excel and PowerPoint files (.docx, .xlsx, .pptx) now open in their default app through `link-open-policy`; the macro-enabled variants (.docm, .xlsm, .pptm) are only revealed in Finder, never opened.
- **D7. Checkpoint.** The tab strip's checkpoint clock (`CheckpointView`; its click runs /checkpoint in the focused pane with its skip rules) leaves the tab strip and becomes the bar's last section: the %, "context · last <age> ago", and a "Checkpoint" button with the clock's handler. The minimized strip keeps a small checkpoint button. Tabs keep the red finished-checkpoint circle.
- **D8. Session link (main).** For a pane's pty, find the Claude process among the shell's descendants whose pid has `~/.claude/sessions/<pid>.json`; read `sessionId`; the transcript is the one `~/.claude/projects/*/<sessionId>.jsonl` (realpath inside `~/.claude/projects`). Resolve when 7501 first reports `app=claude-code` for the pane, every 10 s while unresolved, and when the sessions file's `sessionId` changes (`/clear`, resume). The Stop hook's `tp` (D10) is accepted when it passes the same path checks and nothing else resolved. Logs `[BAR] attach {pane, how}` and `detach`.
- **D9. Transcript feed (main).** At attach, read the last 2 MB to find tasks already running (the next Stop reconciles them), then follow the file (fs.watch plus a 1 s size poll), parsing whole JSONL lines only. It sends `SessionFeedEvent`s (`src/shared/session-feed.ts`) to the pane's renderer: a background start when a tool result names the background id (shell, monitor, agent), an end when a task notice names the id and status, links from assistant text, wake-ups from ScheduleWakeup calls. All text is untrusted: control characters stripped, lengths capped, never more than the extracted fields sent. The exact line shapes are read from real transcripts on this Mac (structure and counts only, never content) and pinned in fixtures with made-up content. Built (S60): the shapes are listed in `src/main/transcript-parser.ts`'s header; a notice is written up to three times (a `queue-operation` enqueue, a `queued_command` attachment, a user line) and ends its id once; a notice for an id this transcript never started is dropped, because a subagent's own shells notify the parent's queue (939 of 2005 ends in 60 recent transcripts here).
- **D10. Hooks.** The Stop hook adds `tl` (base64 JSON of the running, non-ambient tasks: id, type, description cut to 80), `cl` (base64 JSON of `session_crons`: id, schedule, recurring, prompt cut to 80) and `tp` (base64 of `transcript_path`), keeping the whole sequence within the length Claude Code passes on (read in its code; the lists are cut, never the sequence). No second hook: the transcript records a background start the moment Claude Code gets the tool's result, so the feed shows a shell within a second without the PostToolUse hook Michael agreed to; it stays the fallback if the feed proves slower live.
- **D11. Logs.** `[BAR] attach / detach`, `[BAR] rows {pane, running, failures, links}` at most once a minute per pane, `[BAR] link {pane, kind}`, `[BAR] failure {pane, kind}`, `[BAR] minimize {state, reason}`, `[BAR] feed error {pane, why}`, all through `rlog()` or main's logger.
- **D12. Threat model.** Read-only on his own files; every path realpath-checked inside `~/.claude`; no network; transcript text shown only as text (the `shown-text` rules); links open only through `link-open-policy`, so nothing executable runs from a click.
- **D13. Checks.** Parser fixtures (lines → events); model checks (merge, reconcile, linger, failures, link keys and versions); hook probe cases (lists, cuts, size); a hidden-Electron layout check (bar width and terminal columns at UI scale 1, 1.1, 1.5; ⇥ and ⇤; narrow fold; no clock on the strip); and the end-to-end check in the map's bar, written by an agent that didn't build. Every new assertion fails on main.
