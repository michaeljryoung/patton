/**
 * The checkpoint clock: how much of the context window a Claude Code session
 * has used since its last /checkpoint, shown at the right end of the tab strip
 * for the active tab's focused pane. The numbers come from Patton's Stop hook
 * (resources/claude-code-stop-hook.sh, OSC 777 `ctx=…;since=…[;cpt=…]`); this
 * file only turns them into what the strip shows.
 */
import { DEFAULTS } from '../../shared/constants';

/** The context window the percentages are of. Matches `WINDOW` in
 *  ~/.claude/hooks/context-meter.py and Michael's status bar: his sessions run
 *  the 1M-token window. */
export const CONTEXT_WINDOW_TOKENS = 1_000_000;

/** Settings → "Checkpoint reminder after N% of the context window". */
export const DEFAULT_CHECKPOINT_NUDGE_PCT = DEFAULTS.CHECKPOINT_NUDGE_PCT;

/** What a pane knows about its Claude session, for the clock. */
export interface CheckpointSource {
  /** Claude Code runs in the pane (an OSC 7501 report, or a title glyph, since the last shell prompt). */
  claudeActive: boolean;
  /** Claude is mid-turn or blocked on a prompt (7501), or mid-turn (◐/◑ title): /checkpoint can't be typed now. */
  claudeWorking: boolean;
  /** /checkpoint may be typed: Claude has stopped and its Stop hook has
   *  reported since (a dialog shows ✳ too but sends no Stop hook). */
  ready: boolean;
  /** Null until the hook's first reading for this Claude session. */
  ctxTokens: number | null;
  sinceTokens: number | null;
  /** Unix seconds of the last /checkpoint prompt, null when there is none. */
  checkpointAt: number | null;
}

/** What the tab strip renders. Null source or no Claude = hidden. */
export interface CheckpointView {
  text: string;
  /** At or past the reminder threshold: amber and bold. */
  due: boolean;
  /** Claude is working or waiting on a dialog, so a click does nothing. */
  blocked: boolean;
  label: string;
}

export function percentOfWindow(tokens: number): number {
  return Math.round((tokens / CONTEXT_WINDOW_TOKENS) * 100);
}

/** "10:10" today, "6 Nov 10:10" on another day (local time, 24-hour). */
export function checkpointTime(unixSeconds: number, now: Date = new Date()): string {
  const d = new Date(unixSeconds * 1000);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const sameDay = d.getFullYear() === now.getFullYear()
    && d.getMonth() === now.getMonth()
    && d.getDate() === now.getDate();
  if (sameDay) return `${hh}:${mm}`;
  const month = d.toLocaleString('en-GB', { month: 'short' });
  return `${d.getDate()} ${month} ${hh}:${mm}`;
}

/** The clock for one pane, or null when it should be hidden. */
export function checkpointView(
  src: CheckpointSource | null,
  thresholdPct: number,
  now: Date = new Date(),
): CheckpointView | null {
  if (!src || !src.claudeActive) return null;
  const parts: string[] = [];
  let text = '✓ —';
  let due = false;
  if (src.ctxTokens === null || src.sinceTokens === null) {
    parts.push('No context reading yet: it arrives when Claude next stops');
  } else {
    const pct = percentOfWindow(src.sinceTokens);
    text = `✓ +${pct}%`;
    due = pct >= thresholdPct;
    const session = `session at ${percentOfWindow(src.ctxTokens)}%`;
    if (src.checkpointAt === null) {
      parts.push('No checkpoint in this session yet', session);
    } else {
      parts.push(
        `${pct}% of the context window since this session's last checkpoint (${checkpointTime(src.checkpointAt, now)})`,
        session,
      );
    }
  }
  parts.push('Click to run /checkpoint');
  if (!src.ready) parts.push(src.claudeWorking ? 'available when Claude stops' : "available after Claude's next reply");
  // The visible text first, so a screen reader's label starts with what is on screen.
  return { text, due, blocked: !src.ready, label: `${text} · ${parts.join(' · ')}` };
}
