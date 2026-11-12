/**
 * What the tab hover card says about each pane of a tab: its own title, its
 * folder, what it is doing and for how long, the question it is blocked on or
 * the background tasks it is parked on, and the checkpoint reading. Pure (no
 * DOM): the card component renders these blocks with `textContent` only.
 *
 * Every string that came from a program (titles, messages, task names) goes
 * through `shownText`, which strips control and invisible characters and caps
 * the length.
 */
import { shownText } from './program-status';
import { checkpointTime, percentOfWindow, type CheckpointSource } from './checkpoint-clock';
import type { PaneActivity } from './pane-activity';
import type { BlockedKind } from './program-status';

/** The parts of a pane the card reads (see Pane.claudeState, checkpointSource). */
export interface HoverPaneInput {
  /** The pane's title (OSC 0/2 or the process name), untrusted. */
  title: string;
  cwd: string;
  /** The tab's project name, given for the focused pane only. */
  project: string | null;
  claude: {
    activity: PaneActivity;
    since: number;
    title: string | null;
    blockedKind: BlockedKind | null;
    msg: string | null;
    blockedTask: string | null;
    parked: { tasks: number; crons: number; titles?: string[] } | null;
  };
  checkpoint: CheckpointSource;
  /** A /checkpoint finished here and the tab hasn't been selected since. */
  checkpointDone?: boolean;
}

export interface HoverBlock {
  /** "Pane 2 · focused", "Pane 1": the pane's real position in the tab;
   *  null when the tab has one pane. */
  label: string | null;
  title: string;
  place: string;
  /** "Working · 2 min", "Blocked: question · 1 min", "Shell", … */
  state: string;
  /** The activity, for styling (colour only for meaning). */
  activity: PaneActivity;
  /** The blocked question or error message, if any. */
  detail: string | null;
  /** Parked: up to TASKS_SHOWN task titles, then "+N more". */
  tasks: string[];
  checkpoint: string | null;
  /** "Checkpoint finished" while the tab's red circle shows for this pane. */
  done?: string | null;
}

export const TASKS_SHOWN = 3;
const TITLE_MAX = 80;
const PLACE_MAX = 60;
const DETAIL_MAX = 160;
const TASK_MAX = 60;

/** "<1 min", "4 min", "1 h 5 min", "2 d 3 h". Minute steps, so a card that
 *  re-renders once a minute never shows a stale number for long. */
export function formatDuration(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return '<1 min';
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const rest = minutes % 60;
    return rest > 0 ? `${hours} h ${rest} min` : `${hours} h`;
  }
  const days = Math.floor(hours / 24);
  const restH = hours % 24;
  return restH > 0 ? `${days} d ${restH} h` : `${days} d`;
}

/** "/Users/me/Projects/x" → "~/Projects/x"; a long path keeps its tail. */
export function shortPath(cwd: string, max = PLACE_MAX): string {
  const home = cwd.replace(/^\/Users\/[^/]+(?=\/|$)/, '~');
  const clean = shownText(home, Number.MAX_SAFE_INTEGER);
  return clean.length > max ? `…${clean.slice(clean.length - (max - 1))}` : clean;
}

const KIND_LABEL: Record<BlockedKind, string> = {
  permission: 'permission',
  question: 'question',
  auth: 'login',
};

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function stateLine(input: HoverPaneInput, now: number): { state: string; detail: string | null } {
  const c = input.claude;
  const since = formatDuration(now - c.since);
  switch (c.activity) {
    case 'shell': return { state: 'Shell', detail: null };
    case 'working': return { state: `Working · ${since}`, detail: null };
    case 'waiting': return { state: `Waiting for you · ${since}`, detail: null };
    case 'idle': return { state: 'Idle', detail: null };
    case 'error': return { state: 'Error', detail: c.msg ? shownText(c.msg, DETAIL_MAX) : null };
    case 'parked': {
      const p = c.parked ?? { tasks: 0, crons: 0 };
      const parts: string[] = [];
      if (p.tasks > 0 || p.crons === 0) parts.push(plural(p.tasks, 'background task', 'background tasks'));
      if (p.crons > 0) parts.push(plural(p.crons, 'timer', 'timers'));
      return { state: `Parked · ${parts.join(' · ')}`, detail: null };
    }
    case 'blocked': {
      if (c.blockedKind === null && c.blockedTask !== null) {
        return { state: `Blocked: background task · ${since}`, detail: shownText(c.blockedTask, DETAIL_MAX) };
      }
      const kind = c.blockedKind ? KIND_LABEL[c.blockedKind] : 'dialog';
      return { state: `Blocked: ${kind} · ${since}`, detail: c.msg ? shownText(c.msg, DETAIL_MAX) : null };
    }
  }
}

function parkedTasks(input: HoverPaneInput): string[] {
  const c = input.claude;
  if (c.activity !== 'parked' || !c.parked?.titles?.length) return [];
  const titles = c.parked.titles;
  const shown = titles.slice(0, TASKS_SHOWN).map((t) => shownText(t, TASK_MAX));
  const total = Math.max(titles.length, c.parked.tasks);
  const more = total - shown.length;
  if (more > 0) shown.push(`+${more} more`);
  return shown;
}

/** "+12% of context since checkpoint (10:10)", "No checkpoint in this
 *  session yet", or null before the Stop hook's first reading. */
export function checkpointLine(src: CheckpointSource, now: Date): string | null {
  if (!src.claudeActive || src.ctxTokens === null || src.sinceTokens === null) return null;
  if (src.checkpointAt === null) return 'No checkpoint in this session yet';
  return `+${percentOfWindow(src.sinceTokens)}% of context since checkpoint (${checkpointTime(src.checkpointAt, now)})`;
}

export function hoverBlock(input: HoverPaneInput, now: number): HoverBlock {
  const claudeTitle = input.claude.activity !== 'shell' && input.claude.title ? input.claude.title : null;
  const title = shownText(claudeTitle ?? input.title, TITLE_MAX) || 'Terminal';
  const folder = input.cwd ? shortPath(input.cwd) : '';
  const project = input.project ? shownText(input.project, PLACE_MAX) : '';
  const place = project && folder ? `${project} · ${folder}` : project || folder;
  const { state, detail } = stateLine(input, now);
  return {
    label: null,
    title,
    place,
    state,
    activity: input.claude.activity,
    detail,
    tasks: parkedTasks(input),
    checkpoint: input.claude.activity === 'shell' ? null : checkpointLine(input.checkpoint, new Date(now)),
    done: input.checkpointDone ? 'Checkpoint finished' : null,
  };
}

/** One block per pane, the focused pane first, the rest in tab order; each
 *  labelled by its position in the tab (`panes` comes in tab order). */
export function hoverBlocks(panes: { focused: boolean; input: HoverPaneInput }[], now: number): HoverBlock[] {
  const numbered = panes.map((p, i) => ({ ...p, n: i + 1 }));
  const ordered = [...numbered.filter((p) => p.focused), ...numbered.filter((p) => !p.focused)];
  const split = panes.length > 1;
  return ordered.map((p) => ({
    ...hoverBlock(p.input, now),
    label: split ? (p.focused ? `Pane ${p.n} · focused` : `Pane ${p.n}`) : null,
  }));
}
