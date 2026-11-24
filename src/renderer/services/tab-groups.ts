// Tab groups (19 Nov 2026, Michael: "something like Google Chrome's tab
// groups, so you can then group some of the tabs and minimize the group").
// The pure rules, no DOM: TabManager owns the groups and the tab order, and
// calls these to move tabs so that a group's tabs are always one unbroken run.
// `groupOf` reads an item's group id (null = ungrouped); the functions return
// a new array and never change the caller's.
import type { TabFlag } from '../../shared/types';
import { GROUP_NAME_MAX } from '../../shared/tab-group-limits';

export { GROUP_NAME_MAX, GROUP_ID_PATTERN, MAX_GROUPS } from '../../shared/tab-group-limits';

export interface TabGroup {
  id: string;
  /** Up to GROUP_NAME_MAX characters, trimmed; '' = unnamed. */
  name: string;
  folded: boolean;
}

/** A group name as stored: trimmed and cut to GROUP_NAME_MAX characters. */
export function cleanGroupName(name: string): string {
  return Array.from(name.trim()).slice(0, GROUP_NAME_MAX).join('').trim();
}

let groupCounter = 0;
/** A new group id: short, unique in this renderer, `[A-Za-z0-9_-]`. */
export function newGroupId(): string {
  groupCounter += 1;
  return `g${Date.now().toString(36)}-${groupCounter}`;
}

type GroupOf<T> = (item: T) => string | null;

/** Index of the last item in this group, or -1 (`skip` is left out). */
function lastIndexOf<T>(list: readonly T[], groupId: string, groupOf: GroupOf<T>, skip?: T): number {
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i] !== skip && groupOf(list[i]) === groupId) return i;
  }
  return -1;
}

/** Move `item` to just after the group's last member (itself left out of the
 *  search). A group with no other member leaves the order as it is. The caller
 *  then records the item as a member. */
export function placeAfterGroup<T>(list: readonly T[], item: T, groupId: string, groupOf: GroupOf<T>): T[] {
  const out = list.slice();
  const from = out.indexOf(item);
  if (from === -1) return out;
  if (lastIndexOf(out, groupId, groupOf, item) === -1) return out;
  out.splice(from, 1);
  const last = lastIndexOf(out, groupId, groupOf, item);
  out.splice(last + 1, 0, item);
  return out;
}

/** Take `item` out of its group: it lands just after the group's last other
 *  member, so the run stays unbroken. The caller then clears its membership. */
export function takeOutOfGroup<T>(list: readonly T[], item: T, groupOf: GroupOf<T>): T[] {
  const groupId = groupOf(item);
  if (groupId === null) return list.slice();
  return placeAfterGroup(list, item, groupId, groupOf);
}

/** What one Move Left / Move Right step does to a tab (see stepMove). */
export interface StepMove<T> {
  /** The new order. */
  list: T[];
  /** The moved tab's group afterwards (null = ungrouped). */
  group: string | null;
  /** swap: traded places with its neighbour (inside a group, staying in it);
   *  into / out-of: joined or left a group without moving; past: jumped over
   *  a folded group whole. */
  kind: 'swap' | 'into' | 'out-of' | 'past';
  /** The group stepped into, out of or past (null for a swap). */
  groupId: string | null;
}

/** One Move Left (-1) / Move Right (1) step from the tab menu, exactly one
 *  place on the strip: a group's edge tab steps out of its group in place; an
 *  ungrouped tab next to an open group steps into it in place (its first tab
 *  moving right, its last moving left); next to a folded group it jumps the
 *  whole group, which stays as it is; otherwise it swaps with its neighbour.
 *  null when the step would change nothing (an ungrouped tab at an end). */
export function stepMove<T>(list: readonly T[], item: T, dir: -1 | 1, groupOf: GroupOf<T>, isFolded: (groupId: string) => boolean): StepMove<T> | null {
  const at = list.indexOf(item);
  if (at === -1) return null;
  const own = groupOf(item);
  const next: T | undefined = list[at + dir];
  const swap = (): T[] => {
    const out = list.slice();
    out[at] = out[at + dir];
    out[at + dir] = item;
    return out;
  };
  if (own !== null) {
    if (next === undefined || groupOf(next) !== own) return { list: list.slice(), group: null, kind: 'out-of', groupId: own };
    return { list: swap(), group: own, kind: 'swap', groupId: null };
  }
  if (next === undefined) return null;
  const nextGroup = groupOf(next);
  if (nextGroup === null) return { list: swap(), group: null, kind: 'swap', groupId: null };
  if (!isFolded(nextGroup)) return { list: list.slice(), group: nextGroup, kind: 'into', groupId: nextGroup };
  const out = list.slice();
  out.splice(at, 1);
  if (dir > 0) out.splice(lastIndexOf(out, nextGroup, groupOf) + 1, 0, item);
  else out.splice(out.findIndex((x) => groupOf(x) === nextGroup), 0, item);
  return { list: out, group: null, kind: 'past', groupId: nextGroup };
}

// --- Several tabs at once (multi-select, docs/tab-select.md D2) ---
// Each takes the moving tabs out and puts them back as one block, in their
// strip order, so every group stays one unbroken run. The caller records the
// new memberships FIRST (groupOf answers for after the move), except where a
// function says otherwise.

/** Put `items` into `rest` (a list without them) at `at`. A place inside
 *  another group's run, which the items aren't joining, moves to just past
 *  that run's end. */
export function insertBlock<T>(rest: readonly T[], items: readonly T[], at: number, groupOf: GroupOf<T>): T[] {
  const out = rest.slice();
  let place = Math.max(0, Math.min(at, out.length));
  const prev = out[place - 1];
  const next = out[place];
  if (prev !== undefined && next !== undefined) {
    const g = groupOf(prev);
    if (g !== null && g === groupOf(next) && !items.every((item) => groupOf(item) === g)) {
      place = lastIndexOf(out, g, groupOf) + 1;
    }
  }
  out.splice(place, 0, ...items);
  return out;
}

/** The items as `list` orders them, and `list` without them. */
function splitOut<T>(list: readonly T[], items: readonly T[]): { moving: T[]; rest: T[] } {
  const set = new Set(items);
  return { moving: list.filter((x) => set.has(x)), rest: list.filter((x) => !set.has(x)) };
}

/** Several tabs made into one new group (memberships already set): the block
 *  sits where the first of them was, never inside another group's run. */
export function gatherAsNewGroup<T>(list: readonly T[], items: readonly T[], groupOf: GroupOf<T>): T[] {
  const { moving, rest } = splitOut(list, items);
  if (moving.length === 0) return list.slice();
  const first = list.indexOf(moving[0]);
  const at = list.slice(0, first).filter((x) => !moving.includes(x)).length;
  return insertBlock(rest, moving, at, groupOf);
}

/** Several tabs added to a group that has other members (memberships already
 *  set): the block follows the group's last other tab. */
export function gatherAfterGroup<T>(list: readonly T[], items: readonly T[], groupId: string, groupOf: GroupOf<T>): T[] {
  const { moving, rest } = splitOut(list, items);
  if (moving.length === 0) return list.slice();
  const last = lastIndexOf(rest, groupId, groupOf);
  if (last === -1) return list.slice();
  return insertBlock(rest, moving, last + 1, groupOf);
}

/** Several tabs taken out of one group (memberships already cleared): the
 *  block lands just after the group's remaining tabs, or stays where it is
 *  when none remain. */
export function takeBlockOutOfGroup<T>(list: readonly T[], items: readonly T[], groupId: string, groupOf: GroupOf<T>): T[] {
  const { moving, rest } = splitOut(list, items);
  if (moving.length === 0) return list.slice();
  const last = lastIndexOf(rest, groupId, groupOf);
  if (last === -1) return list.slice();
  return insertBlock(rest, moving, last + 1, groupOf);
}

// --- A drag dropped on the strip (24 Nov 2026) ---
// Michael: "in Google Chrome, you can drag a tab to the edge of the tab group,
// and it will include it, whereas in this, that doesn't work. You have to drag
// it into the middle of it." So, as Chrome does, a drop lands in a SLOT between
// tabs (the half of the tab under the pointer: left = before it, right = after
// it), and the slot decides the group (docs/tab-groups.md, 2026-11-24).

/** Where the pointer is, by id: a tab on the strip and which half of it, or a
 *  group's chip. What the strip hands TabManager on a drop. */
export type TabDropTarget =
  | { kind: 'tab'; id: string; half: 'left' | 'right' }
  | { kind: 'chip'; groupId: string };

/** The same, with the tab itself (the pure rule's input). */
export type DropOver<T> =
  | { kind: 'tab'; item: T; half: 'left' | 'right' }
  | { kind: 'chip'; groupId: string };

/** What a drop does. `slot`: the moving tabs, in strip order, land as one block
 *  at `index` of the list without them (before `before`, null = the end), all
 *  in `group` (null = ungrouped); `list` is the order after the drop. `why` is
 *  the rule that chose the group. `chip`: they join `group` as Add to does. */
export type DropPlacement<T> =
  | { kind: 'slot'; list: T[]; index: number; before: T | null; group: string | null; why: 'in-group' | 'group-edge' | 'ungrouped' }
  | { kind: 'chip'; group: string };

/** Where tabs dragged on the strip land, and in which group; null when the drop
 *  changes nothing (a tab dropped on itself or one it carries, on a tab hidden
 *  in a folded group, or back where it is).
 *  1. Over a grouped tab (either half): that group, at that slot.
 *  2. Over the left half of an ungrouped tab whose left neighbour is an OPEN
 *     group's last tab: the slot is that group's right edge, so it joins the
 *     group, at its end ("drag to the edge and it includes it").
 *  3. Any other slot over an ungrouped tab: ungrouped there. A folded group's
 *     chip is not a tab, so the slot after it is ungrouped, and so is the slot
 *     before any chip (the chip marks where a group starts).
 *  4. Over a chip: joins that group as Add to does (after its last tab).
 *  A grouped tab follows the same rules, so dragging it past its group's edge
 *  onto the far half of the next ungrouped tab takes it out. Several tabs move
 *  as one block and every group stays one unbroken run. */
export function dropPlacement<T>(list: readonly T[], moving: readonly T[], over: DropOver<T>, groupOf: GroupOf<T>, isFolded: (groupId: string) => boolean): DropPlacement<T> | null {
  const movingSet = new Set(moving.filter((x) => list.includes(x)));
  if (movingSet.size === 0) return null;
  const block = list.filter((x) => movingSet.has(x));
  if (over.kind === 'chip') {
    if (block.every((x) => groupOf(x) === over.groupId)) return null;
    return { kind: 'chip', group: over.groupId };
  }
  const target = over.item;
  const at = list.indexOf(target);
  if (at === -1 || movingSet.has(target)) return null;
  const own = groupOf(target);
  if (own !== null && isFolded(own)) return null; // hidden: not a slot
  let group: string | null = null;
  let why: 'in-group' | 'group-edge' | 'ungrouped' = 'ungrouped';
  if (own !== null) {
    group = own;
    why = 'in-group';
  } else if (over.half === 'left' && at > 0) {
    // The tab just left of an ungrouped tab ends any group it is in. An open
    // group's last tab is drawn there; a folded group's tabs are hidden, so the
    // pointer meets its chip instead and joins nothing.
    const left = groupOf(list[at - 1]);
    if (left !== null && !isFolded(left)) {
      group = left;
      why = 'group-edge';
    }
  }
  const rest = list.filter((x) => !movingSet.has(x));
  const index = rest.indexOf(target) + (over.half === 'right' ? 1 : 0);
  const after: GroupOf<T> = (x) => (movingSet.has(x) ? group : groupOf(x));
  const out = insertBlock(rest, block, index, after);
  const same = out.every((x, i) => x === list[i]) && block.every((x) => groupOf(x) === group);
  if (same) return null;
  return { kind: 'slot', list: out, index, before: rest[index] ?? null, group, why };
}

/** Make every group one unbroken run: the first run of each group stays where
 *  it is and any straggler later in the list moves to follow it (order kept).
 *  `moved` counts the stragglers moved (0 = the list was already sound). */
export function repairRuns<T>(list: readonly T[], groupOf: GroupOf<T>): { list: T[]; moved: number } {
  const out: T[] = [];
  const stragglers = new Map<string, T[]>();
  const seenRunEnd = new Set<string>(); // groups whose first run has ended
  let moved = 0;
  let prevGroup: string | null = null;
  for (const item of list) {
    const g = groupOf(item);
    if (prevGroup !== null && g !== prevGroup) seenRunEnd.add(prevGroup);
    if (g !== null && seenRunEnd.has(g)) {
      const s = stragglers.get(g) ?? [];
      s.push(item);
      stragglers.set(g, s);
      moved++;
      // A straggler doesn't open a new run: the group stays "ended".
      prevGroup = null;
      continue;
    }
    out.push(item);
    prevGroup = g;
  }
  if (moved === 0) return { list: out, moved };
  for (const [g, items] of stragglers) {
    const last = lastIndexOf(out, g, groupOf);
    out.splice(last + 1, 0, ...items);
  }
  return { list: out, moved };
}

/** True when every group's members form one unbroken run. */
export function runsAreSound<T>(list: readonly T[], groupOf: GroupOf<T>): boolean {
  return repairRuns(list, groupOf).moved === 0;
}

/** Move a whole group's run to the front, order inside unchanged. */
export function moveGroupFirst<T>(list: readonly T[], groupId: string, groupOf: GroupOf<T>): T[] {
  const members = list.filter((item) => groupOf(item) === groupId);
  const rest = list.filter((item) => groupOf(item) !== groupId);
  return [...members, ...rest];
}

/** The index of the nearest item `isVisible` accepts: from `rightStart`
 *  rightwards first, then from `leftStart` leftwards. -1 if there is none. */
export function nearestVisible<T>(list: readonly T[], rightStart: number, leftStart: number, isVisible: (item: T) => boolean): number {
  for (let i = Math.max(0, rightStart); i < list.length; i++) {
    if (isVisible(list[i])) return i;
  }
  for (let i = Math.min(leftStart, list.length - 1); i >= 0; i--) {
    if (isVisible(list[i])) return i;
  }
  return -1;
}

/** The items shown on the strip (those not in a folded group), in order. */
export function visibleItems<T>(list: readonly T[], isVisible: (item: T) => boolean): T[] {
  return list.filter(isVisible);
}

/** The states a tab's indicator can show, as a folded chip ranks them. */
export interface IndicatorInput {
  active?: boolean;
  checkpointDone?: boolean;
  awaitingInput?: boolean;
  flag?: TabFlag | null;
  autoFlag?: TabFlag | null;
  parked?: unknown;
  /** Claude is mid-turn in one of its panes (Tab.working). */
  working?: boolean;
}

export type StrongestState =
  | { kind: 'checkpoint' }
  | { kind: 'needs-you' }
  | { kind: 'flag'; flag: TabFlag }
  | { kind: 'parked' }
  | { kind: 'working' };

const RANK: Record<StrongestState['kind'], number> = { checkpoint: 5, 'needs-you': 4, flag: 3, parked: 2, working: 1 };

/** One tab's strongest state, by the rank a folded chip uses: the red
 *  checkpoint circle, then the green needs-you dot (both on inactive tabs
 *  only, as on the strip), then a flag (manual, else automatic), then the
 *  parked ring, then (lowest) the still grey working dot. */
export function stateOf(tab: IndicatorInput): StrongestState | null {
  if (tab.checkpointDone && !tab.active) return { kind: 'checkpoint' };
  if (tab.awaitingInput && !tab.active) return { kind: 'needs-you' };
  const flag = tab.flag ?? tab.autoFlag ?? null;
  if (flag) return { kind: 'flag', flag };
  if (tab.parked) return { kind: 'parked' };
  if (tab.working) return { kind: 'working' };
  return null;
}

/** The strongest state among a set of tabs (the first such tab wins a tie). */
export function strongestState(tabs: readonly IndicatorInput[]): StrongestState | null {
  let best: StrongestState | null = null;
  for (const tab of tabs) {
    const s = stateOf(tab);
    if (s && (best === null || RANK[s.kind] > RANK[best.kind])) best = s;
  }
  return best;
}
