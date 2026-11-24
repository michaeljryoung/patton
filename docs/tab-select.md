# Patton — Tab strip: working mark and multi-select (S63)

Two tab-strip features Michael picked on the try-out page `docs/mocks/tryout-s63-tabs.html` (24 Nov 2026), drawn there from Patton's own tab styles. Its CSS and its section-3 behaviour are the agreed look and behaviour; this file records where the page was silent and what was chosen.

## D1 — W1: a still grey dot on a tab where Claude is mid-turn

**His pick:** "W1 · Still dot" ("A small grey dot that never moves: the quietest of the three"), over W2 (a turning arc) and W3 (three dots brightening in turn).

**What it does.** A tab with a pane where Claude is mid-turn shows a 5 px dot in the strip's muted ink (`--muted`) in the mark slot, with 2 px either side so the 9 px slot never shifts. It is the lowest mark: a flag (manual, or the automatic `WAKE` yellow), the red checkpoint circle, the green needs-you dot and the parked ring all take the slot first. It shows on the active tab too, as on the page (betterterm, the tab you're on, carries it there).

**Where it comes from.** `Pane.midTurn` = Claude working, not asking (a permission or question reads as `blocked`, the green dot's business) and not past a turn that ended over a still-working root (the ring's). `Tab.working` is true when any pane of the tab is mid-turn; `TabManager.updateTabBar` sends it as `working`; `tab-bar.ts` draws `.tab-bar-tab-indicator.working` (aria-label "Claude working"; the tab's own label gains ", Claude working"). Not the dot's activity word (`currentActivity`), which is ranked for alerting (CLAUDE.md Gotchas). The tab asks the strip to redraw only when its answer changes (`Tab.noteWorking`, from the pane's checkpoint key, which holds working, blocked and the turn end), and nothing is logged per redraw: the pane's own `[7501] state` lines already say when a turn starts and ends.

**Where the page was silent:**
- A folded group's chip and the list under it don't show it: the chip ranks what needs you (`strongestState`), and a working tab doesn't.
- No motion and no reduced-motion variant are needed: the dot never moves.

Check: `scripts/check-tab-working-mark.mjs` (the real TabBar: every priority pair, the active tab, labels, the folded chip, no log per redraw; the real TabManager, Tab and Pane fed 7501 records and window titles through a fake PTY: working, blocked, done, a turn ending over background work, the title path's ◐ and ✳, no redraw from a repeated report).
