// Tab groups in a saved session (19 Nov 2026): main never trusts the
// renderer's group data, and never refuses a whole session because of it. A
// bad `groups` entry is dropped, and so is a tab's `groupId` that points at no
// kept group; groups no tab points at go too. The rest of the session is
// returned as it came (setSession validates it separately).
import type { SessionGroupState, SessionState, SessionTabState } from '../shared/types';
import { GROUP_ID_PATTERN, GROUP_NAME_MAX, MAX_GROUPS } from '../shared/tab-group-limits';

function cleanGroup(raw: unknown): SessionGroupState | null {
  if (!raw || typeof raw !== 'object') return null;
  const g = raw as Record<string, unknown>;
  if (typeof g.id !== 'string' || !GROUP_ID_PATTERN.test(g.id)) return null;
  if (typeof g.name !== 'string' || Array.from(g.name).length > GROUP_NAME_MAX) return null;
  if (typeof g.folded !== 'boolean') return null;
  // A clean object: no other keys ride along from the IPC payload.
  return { id: g.id, name: g.name, folded: g.folded };
}

export interface GroupSanitiseReport {
  droppedGroups: number;
  droppedTabRefs: number;
}

/** The session with only sound group data (see the header). */
export function sanitiseSessionGroups(session: SessionState): { session: SessionState; report: GroupSanitiseReport } {
  const report: GroupSanitiseReport = { droppedGroups: 0, droppedTabRefs: 0 };
  const rawGroups: unknown[] = Array.isArray(session.groups) ? session.groups : [];
  if (session.groups !== undefined && !Array.isArray(session.groups)) report.droppedGroups++;
  const kept = new Map<string, SessionGroupState>();
  for (const raw of rawGroups) {
    const g = cleanGroup(raw);
    if (!g || kept.has(g.id) || kept.size >= MAX_GROUPS) { report.droppedGroups++; continue; }
    kept.set(g.id, g);
  }
  const used = new Set<string>();
  const tabs: SessionTabState[] = session.tabs.map((tab) => {
    if (!tab || typeof tab !== 'object' || !('groupId' in tab)) return tab;
    const { groupId, ...rest } = tab;
    if (typeof groupId === 'string' && kept.has(groupId)) {
      used.add(groupId);
      return { ...rest, groupId };
    }
    if (groupId !== undefined) report.droppedTabRefs++;
    return rest;
  });
  const groups = [...kept.values()].filter((g) => used.has(g.id));
  report.droppedGroups += kept.size - groups.length;
  const out: SessionState = { ...session, tabs };
  if (groups.length > 0) out.groups = groups;
  else delete out.groups;
  return { session: out, report };
}
