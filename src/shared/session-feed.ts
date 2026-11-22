/**
 * The session bar's contract (docs/session-bar.md, D8–D10): what main's
 * transcript feed sends a pane's renderer, and what the Stop hook's lists
 * carry. Shared by main, preload and renderer; types and names only.
 *
 * Every string here came from Claude Code's transcript or hook input, so it is
 * untrusted: main strips control characters and caps lengths before sending,
 * and the renderer shows it only as text.
 */

/** IPC channels. Main → renderer events, and the renderer asking main to
 *  follow (or stop following) the Claude session in a pane's pty. */
export const SESSION_FEED_IPC = {
  /** main → renderer: `(ptyId: number, event: SessionFeedEvent)` */
  EVENT: 'session-feed:event',
  /** renderer → main (invoke): `(ptyId: number, hint?: { transcriptPath?: string })` */
  WATCH: 'session-feed:watch',
  /** renderer → main (invoke): `(ptyId: number)` */
  UNWATCH: 'session-feed:unwatch',
} as const;

export type FeedTaskKind = 'shell' | 'monitor' | 'agent' | 'workflow' | 'teammate' | 'cloud' | 'other';
export type FeedTaskEndStatus = 'completed' | 'failed' | 'killed' | 'stopped';

export type SessionFeedEvent =
  /** The pane's Claude session was found (D8). */
  | { type: 'attached'; sessionId: string; how: 'sessions-file' | 'hook' }
  /** The session ended or changed (`/clear`, resume, Claude exited). */
  | { type: 'detached'; reason: string }
  /** A background task started (or was found running at attach). `at` is ms since epoch. */
  | { type: 'task-start'; id: string; kind: FeedTaskKind; description: string; command?: string; at: number }
  /** A task's notice: how it ended. */
  | { type: 'task-end'; id: string; status: FeedTaskEndStatus; exitCode?: number; summary?: string; at: number }
  /** A link Claude gave (D6). Exactly one of url / path. */
  | { type: 'link'; url?: string; path?: string; label: string; at: number }
  /** A one-off ScheduleWakeup (D4). */
  | { type: 'wake'; fireAt: number; prompt?: string; at: number }
  /** main couldn't read or parse something; the bar keeps what it has. */
  | { type: 'error'; why: string };

/** One running task in the Stop hook's `tl` list (base64 JSON array). */
export interface HookTask {
  id: string;
  /** Claude Code's label: "shell", "subagent", "monitor", "workflow", "teammate", "cloud session", "MCP task"… */
  type: string;
  /** Description, cut to 80 characters by the hook. */
  d: string;
}

/** One entry in the Stop hook's `cl` list (base64 JSON array): `session_crons`. */
export interface HookCron {
  id: string;
  /** 5-field cron expression. */
  s: string;
  /** Recurring (a loop or cron) or one-off. */
  r: boolean;
  /** Prompt, cut to 80 characters by the hook. */
  p: string;
}
