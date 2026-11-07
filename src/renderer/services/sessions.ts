import type { ProjectInfo } from '../../shared/types';

/**
 * One open session: a pane, in a tab. The command palette lists these when
 * you type, and the bookmarks sidebar counts them per project.
 *
 * - waiting: needs you (the tab's green dot), since `awaitingSince`
 * - parked:  Claude Code ended its turn but waits on its own background work
 * - working: Claude Code is mid-turn (◐◑)
 * - idle:    Claude Code is stopped (✳) and not flagged as needing you
 * - shell:   no Claude Code in the pane
 */
export type SessionStatus = 'waiting' | 'parked' | 'working' | 'idle' | 'shell';

export interface SessionInfo {
  tabId: string;
  paneId: string;
  /** 1-based position in the tab bar. */
  tabIndex: number;
  /** Panes in the tab, so a split can say which pane this is. */
  paneCount: number;
  project: ProjectInfo | null;
  /** The project's name (the user's, else automatic), or null outside a project. */
  projectName: string | null;
  worktree: { name: string; path: string } | null;
  cwd: string;
  /** What the tab is called (may be a name the user typed). */
  tabTitle: string;
  /** The user named the tab, and that name wins over the project's. */
  hasCustomTitle: boolean;
  /** The title the program in the pane set, without Claude Code's glyph. */
  paneTitle: string;
  state: SessionStatus;
  awaitingSince: number | null;
}

const STATE_RANK: Record<SessionStatus, number> = { waiting: 0, parked: 1, working: 2, idle: 2, shell: 2 };

/** Waiting first (longest wait first), then parked, then the rest; ties keep tab order. */
export function orderSessions(sessions: SessionInfo[]): SessionInfo[] {
  return sessions
    .map((s, i) => ({ s, i }))
    .sort((a, b) => {
      const rank = STATE_RANK[a.s.state] - STATE_RANK[b.s.state];
      if (rank !== 0) return rank;
      if (a.s.state === 'waiting') {
        const wait = (a.s.awaitingSince ?? 0) - (b.s.awaitingSince ?? 0);
        if (wait !== 0) return wait;
      }
      return a.i - b.i;
    })
    .map(({ s }) => s);
}

/** Claude Code's ◐ ◑ ✳ prefix (and the space after it) off a title. */
export function stripClaudeGlyph(title: string): string {
  return title.replace(/^[◐◑✳]\s*/u, '').trim();
}

/** A project's display title: "patton", or "patton ⎇ feat-x" in a linked
 *  worktree. The one place the format is written (tab titles and the palette). */
export function formatProjectTitle(name: string, worktree: { name: string } | null | undefined): string {
  return worktree ? `${name} \u2387 ${worktree.name}` : name;
}

/**
 * What the palette calls a session: the tab's own name if the user typed one;
 * else the project ("patton ⎇ feat-x"); else, in a split, the pane's own title
 * or folder (the tab's title belongs to the focused pane); else the tab's title.
 */
export function sessionName(s: SessionInfo): string {
  if (s.hasCustomTitle) return s.tabTitle;
  if (s.projectName) return formatProjectTitle(s.projectName, s.worktree);
  if (s.paneCount > 1) return s.paneTitle || s.cwd.split('/').filter(Boolean).pop() || s.tabTitle;
  return s.tabTitle;
}

/** "4 min", "1 h 5 min", "<1 min". */
export function formatWait(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return '<1 min';
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

/** The state in words: "waiting 4 min", "parked", "working", "idle", "shell". */
export function stateWords(s: SessionInfo, now: number): string {
  if (s.state === 'waiting') return s.awaitingSince ? `waiting ${formatWait(now - s.awaitingSince)}` : 'waiting';
  return s.state;
}

/** Everything a palette query matches against, lower-cased. */
export function sessionSearchText(s: SessionInfo, now: number): string {
  const parts = [
    s.projectName ?? '', s.worktree?.name ?? '', s.tabTitle, s.paneTitle,
    stateWords(s, now),
    // "waiting" also finds what needs you under the word the tab tooltip uses.
    s.state === 'waiting' ? 'needs you' : '',
  ];
  return parts.join(' ').toLowerCase();
}

/** Whether a session belongs to a project bookmark at `path`. */
export function sessionMatchesPath(s: SessionInfo, path: string): boolean {
  return s.project?.root === path || s.cwd === path;
}
