/**
 * Which publish of a page is the newest (page titles): the one rule the live
 * learning (page-titles.ts) and the backfill (page-title-backfill.ts) share.
 * A path can be published under several ids over time and the title reader
 * sees the file as it is now, so only the newest publish of a path may take
 * the file's `<title>`. Pure; no Electron import.
 *
 * Newest means, in order: a line that starts a tool result's text beats one
 * quoted inside other text; a line carrying Claude Code's version id beats one
 * without (an old-format publish, or a quote cut before it); then the later
 * publish time; on a tie, the publish seen later (the later line).
 */

/** A publish time further ahead than this is not believed. */
export const FUTURE_SLACK_MS = 24 * 3600 * 1000;

export interface RankedPublish {
  id: string;
  path: string;
  /** Publish time, ms. */
  at: number;
  /** The line starts a tool result's text (live publishes always do; in the
   *  backfill, the line opens a JSON string). */
  start: boolean;
  /** The line carries a version id, whose time `at` is. */
  versioned: boolean;
}

/** > 0 when `a` is newer than `b`, 0 when they tie, < 0 when older. */
export function comparePublishes(a: RankedPublish, b: RankedPublish): number {
  if (a.start !== b.start) return a.start ? 1 : -1;
  if (a.versioned !== b.versioned) return a.versioned ? 1 : -1;
  return a.at - b.at;
}

/** The newest publish per key, publishes seen in order (a tie goes to the later). */
export class NewestPublish<P extends RankedPublish> {
  private readonly by = new Map<string, P>();
  constructor(private readonly key: (p: P) => string) {}

  see(p: P): void {
    const k = this.key(p);
    const cur = this.by.get(k);
    if (!cur || comparePublishes(p, cur) >= 0) this.by.set(k, p);
  }

  get(k: string): P | undefined {
    return this.by.get(k);
  }
}
