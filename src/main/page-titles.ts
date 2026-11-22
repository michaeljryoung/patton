/**
 * Page titles: what a claude.ai artifact page is called, learned from the
 * file Claude published (its `<title>`), else the title Claude gave the
 * Artifact call. Bookmarks and the session bar's links show it in place of
 * "Artifact <id start>" or "Page <id start>".
 *
 * Learned live (session-feed.ts hands each publish in a followed transcript
 * here) and, once per launch, by a backfill for bookmarks with no title yet
 * (page-title-backfill.ts). The store is injected, so the checks run this
 * under plain Node. Logs never carry a title or a path: titles can be private.
 */
import { ARTIFACT_ID } from '../shared/artifact-id';
import type { PageTitleMap } from '../shared/types';
import { readPageTitle, TITLE_MAX } from './page-title-read';
import { cleanText, type PagePublish } from './transcript-parser';

export const TITLES_KEPT = 500;
export const MISSES_KEPT = 500;
/** A backfill miss is not searched for again within this (ms). */
export const MISS_RETRY_MS = 7 * 24 * 3600 * 1000;

export interface StoredTitle { title: string; at: number }

export interface PageTitleStore {
  getTitles: () => unknown;
  setTitles: (titles: Record<string, StoredTitle>) => void;
  getMisses: () => unknown;
  setMisses: (misses: Record<string, number>) => void;
}

export interface PageTitleDeps {
  store: PageTitleStore;
  /** Every window hears the new map. */
  onChange?: (titles: PageTitleMap) => void;
  /** The ids bookmarks use: never evicted by the cap. */
  keep?: () => ReadonlySet<string>;
  log?: (msg: string, data: Record<string, unknown>) => void;
  now?: () => number;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Own enumerable entries only: an id named like an Object.prototype member is just an id. */
function ownEntries(v: Record<string, unknown>): Array<[string, unknown]> {
  const out: Array<[string, unknown]> = [];
  for (const k of Object.keys(v)) out.push([k, v[k]]);
  return out;
}

/** The entries in `keep`, plus the newest of the rest by `at`, up to `max` in all
 *  (never fewer than the kept ones). */
function capped<T>(map: Map<string, T>, at: (v: T) => number, max: number, keep: ReadonlySet<string>): Record<string, T> {
  const out = Object.create(null) as Record<string, T>;
  if (map.size <= max) {
    for (const [k, v] of map) out[k] = v;
    return out;
  }
  const rest: Array<[string, T]> = [];
  let kept = 0;
  for (const [k, v] of map) {
    if (keep.has(k)) { out[k] = v; kept++; } else rest.push([k, v]);
  }
  rest.sort((a, b) => at(b[1]) - at(a[1]));
  for (const [k, v] of rest.slice(0, Math.max(0, max - kept))) out[k] = v;
  return out;
}

const NO_KEEP: ReadonlySet<string> = new Set();

export class PageTitleBook {
  private readonly log: (msg: string, data: Record<string, unknown>) => void;
  private readonly now: () => number;
  /** "id reason" already logged as a refused read this launch. */
  private readonly refusedLogged = new Set<string>();

  constructor(private readonly deps: PageTitleDeps) {
    this.log = deps.log ?? ((msg, data) => console.info(msg, data));
    this.now = deps.now ?? Date.now;
  }

  private keep(): ReadonlySet<string> {
    try {
      return this.deps.keep?.() ?? NO_KEEP;
    } catch {
      return NO_KEEP;
    }
  }

  /** The stored titles, read defensively (electron-store fills defaults only at the top level). */
  private stored(): Map<string, StoredTitle> {
    const raw = this.deps.store.getTitles();
    const out = new Map<string, StoredTitle>();
    if (!isRecord(raw)) return out;
    for (const [id, v] of ownEntries(raw)) {
      if (ARTIFACT_ID.test(id) && isRecord(v) && typeof v.title === 'string' && v.title && typeof v.at === 'number') {
        out.set(id, { title: v.title, at: v.at });
      }
    }
    return out;
  }

  private misses(): Map<string, number> {
    const raw = this.deps.store.getMisses();
    const out = new Map<string, number>();
    if (!isRecord(raw)) return out;
    for (const [id, at] of ownEntries(raw)) {
      if (ARTIFACT_ID.test(id) && typeof at === 'number' && Number.isFinite(at)) out.set(id, at);
    }
    return out;
  }

  /** id → title, for the renderer (a prototype-free object). */
  titles(): PageTitleMap {
    const out = Object.create(null) as PageTitleMap;
    for (const [id, v] of this.stored()) out[id] = v.title;
    return out;
  }

  has(id: string): boolean {
    return this.stored().has(id);
  }

  /** A backfill searched for this id within MISS_RETRY_MS and found nothing. */
  missedRecently(id: string): boolean {
    const at = this.misses().get(id);
    return at !== undefined && this.now() - at < MISS_RETRY_MS;
  }

  recordMisses(ids: readonly string[]): void {
    if (ids.length === 0) return;
    const misses = this.misses();
    const t = this.now();
    for (const id of ids) if (ARTIFACT_ID.test(id)) misses.set(id, t);
    this.deps.store.setMisses(capped(misses, (at) => at, MISSES_KEPT, this.keep()));
  }

  /** Keep a title; true when it is new or changed (and the windows were told). */
  learn(id: string, title: string, source: 'live' | 'backfill'): boolean {
    return this.learnMany([[id, title]], source) > 0;
  }

  /** Keep several titles with one store write and one push; the count new or changed. */
  learnMany(entries: ReadonlyArray<readonly [string, string]>, source: 'live' | 'backfill'): number {
    const titles = this.stored();
    const misses = this.misses();
    const t = this.now();
    let changed = 0;
    let missesChanged = false;
    for (const [id, title] of entries) {
      if (!ARTIFACT_ID.test(id) || typeof title !== 'string' || !title) continue;
      if (titles.get(id)?.title === title) continue;
      titles.set(id, { title, at: t });
      if (misses.delete(id)) missesChanged = true;
      changed++;
      this.log('[TITLE] learned', { id: id.slice(0, 8), source, chars: title.length });
    }
    if (changed === 0) return 0;
    const keep = this.keep();
    this.deps.store.setTitles(capped(titles, (v) => v.at, TITLES_KEPT, keep));
    if (missesChanged) this.deps.store.setMisses(capped(misses, (at) => at, MISSES_KEPT, keep));
    this.deps.onChange?.(this.titles());
    return changed;
  }

  /** The title of a page file: its `<title>`, else ''. A refused read is logged
   *  once per id and reason per launch, with the id's first 8 characters. */
  async fileTitle(id: string, path: string | null): Promise<string> {
    if (!path) return '';
    const read = await readPageTitle(path);
    if (read.title) return read.title;
    const key = `${id} ${read.reason}`;
    if (read.reason !== 'no-title' && !this.refusedLogged.has(key)) {
      this.refusedLogged.add(key);
      this.log('[TITLE] read refused', { id: id.slice(0, 8), reason: read.reason });
    }
    return '';
  }

  /** The title a publish names: the file's `<title>`, else Claude's `input.title`, else ''. */
  async titleOf(pub: Pick<PagePublish, 'id' | 'path' | 'inputTitle'>): Promise<string> {
    return (await this.fileTitle(pub.id, pub.path)) || cleanText(pub.inputTitle, TITLE_MAX);
  }

  /** A publish seen in a followed transcript. */
  async learnPublish(pub: PagePublish, source: 'live' | 'backfill' = 'live'): Promise<boolean> {
    const title = await this.titleOf(pub);
    return title ? this.learn(pub.id, title, source) : false;
  }
}
