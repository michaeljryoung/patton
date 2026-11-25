# Tab strip

Read before touching the tab order, tab groups, dragging tabs within or between windows, or anything the strip does on a pointer event. The design of groups and drops is in `docs/tab-groups.md`. Moved word for word from CLAUDE.md's Gotchas (S66 slimming, 2026-11-25).

## Gotchas moved from CLAUDE.md (S66 slimming, 2026-11-25)

- **A group's tabs are one unbroken run in `TabManager.tabs`, and tab ids are per-window counters** (S55). Every path that splices the tab order (createTab, reorder, drag, wake, discardTab, close, restore) must keep each group's run whole, through the helpers in `services/tab-groups.ts`. `tab-N` exists in every window, so a tab id arriving from outside the strip (drag data) is trusted only for a drag that began there (`draggedId`): before `7f092d8` a tab dragged in from another window moved this window's tab of the same id.
- **Never rebuild the tab strip from a pointerdown** (S66): the pressed element detaches and its click, double-click rename or drag is lost. Clear marks after the click (deferred 0 ms); the strip already holds rebuilds during a drag or rename.
