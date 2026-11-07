import type { PaletteAction } from '../components/command-palette';
import { sessionName, sessionSearchText, stateWords, type SessionInfo } from './sessions';

/** Palette action ids for open sessions: `session:<tabId>:<paneId>`. */
const SESSION_ACTION_PREFIX = 'session:';

/**
 * Every open pane as a palette entry, "patton ⎇ feat-x · waiting 4 min", in
 * the order given (listSessions: waiting first). Matched only once something
 * is typed, so the empty palette stays the command list.
 */
export function sessionPaletteActions(sessions: SessionInfo[], now: number): PaletteAction[] {
  return sessions.map((s) => {
    const name = sessionName(s);
    const label = `${name} · ${stateWords(s, now)}`;
    const where = s.paneCount > 1 ? `tab ${s.tabIndex}, split` : `tab ${s.tabIndex}`;
    const detail = s.paneTitle && s.paneTitle !== name ? s.paneTitle : where;
    return {
      label,
      action: `${SESSION_ACTION_PREFIX}${s.tabId}:${s.paneId}`,
      searchOnly: true,
      match: sessionSearchText(s, now),
      glyph: s.state === 'waiting' || s.state === 'parked' ? s.state : undefined,
      detail,
      ariaLabel: `Go to ${label}, ${detail === where ? where : `${detail}, ${where}`}`,
    };
  });
}

/** The tab and pane a session action names, or null for any other action. */
export function parseSessionAction(actionId: string): { tabId: string; paneId: string } | null {
  if (!actionId.startsWith(SESSION_ACTION_PREFIX)) return null;
  const [tabId, paneId] = actionId.slice(SESSION_ACTION_PREFIX.length).split(':');
  return tabId && paneId ? { tabId, paneId } : null;
}
