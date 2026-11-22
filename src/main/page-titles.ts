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
  log?: (msg: string, data: Record<string, unknown>) => void;
  now?: () => number;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** The newest `max` entries by `at`. */
function newest<T>(entries: Array<[string, T]>, at: (v: T) => number, max: number): Array<[string, T]> {
  if (entries.length <= max) return entries;
  return [...entries].sort((a, b) => at(b[1]) - at(a[1])).slice(0, max);
}

export class PageTitleBook {
  private readonly log: (msg: string, data: Record<string, unknown>) => void;
  private readonly now: () => number;

  constructor(private readonly deps: PageTitleDeps) {
    this.log = deps.log ?? ((msg, data) => console.info(msg, data));
    this.now = deps.now ?? Date.now;
  }

  /** The stored titles, read defensively (electron-store fills defaults only at the top level). */
  private stored(): Record<string, StoredTitle> {
    const raw = this.deps.store.getTitles();
    const out: Record<string, StoredTitle> = {};
    if (!isRecord(raw)) return out;
    for (const [id, v] of Object.entries(raw)) {
      if (ARTIFACT_ID.test(id) && isRecord(v) && typeof v.title === 'string' && v.title && typeof v.at === 'number') {
        out[id] = { title: v.title, at: v.at };
      }
    }
    return out;
  }

  private misses(): Record<string, number> {
    const raw = this.deps.store.getMisses();
    const out: Record<string, number> = {};
    if (!isRecord(raw)) return out;
    for (const [id, at] of Object.entries(raw)) {
      if (ARTIFACT_ID.test(id) && typeof at === 'number' && Number.isFinite(at)) out[id] = at;
    }
    return out;
  }

  /** id → title, for the renderer. */
  titles(): PageTitleMap {
    const out: PageTitleMap = {};
    for (const [id, v] of Object.entries(this.stored())) out[id] = v.title;
    return out;
  }

  has(id: string): boolean {
    return this.stored()[id] !== undefined;
  }

  /** A backfill searched for this id within MISS_RETRY_MS and found nothing. */
  missedRecently(id: string): boolean {
    const at = this.misses()[id];
    return at !== undefined && this.now() - at < MISS_RETRY_MS;
  }

  recordMisses(ids: readonly string[]): void {
    if (ids.length === 0) return;
    const misses = this.misses();
    const t = this.now();
    for (const id of ids) if (ARTIFACT_ID.test(id)) misses[id] = t;
    this.deps.store.setMisses(Object.fromEntries(newest(Object.entries(misses), (at) => at, MISSES_KEPT)));
  }

  /** Keep a title; true when it is new or changed (and the windows were told). */
  learn(id: string, title: string, source: 'live' | 'backfill'): boolean {
    if (!ARTIFACT_ID.test(id) || !title) return false;
    const titles = this.stored();
    const had = titles[id];
    if (had && had.title === title) return false;
    titles[id] = { title, at: this.now() };
    this.deps.store.setTitles(Object.fromEntries(newest(Object.entries(titles), (v) => v.at, TITLES_KEPT)));
    const misses = this.misses();
    if (misses[id] !== undefined) {
      delete misses[id];
      this.deps.store.setMisses(misses);
    }
    this.log('[TITLE] learned', { id: id.slice(0, 8), source, chars: title.length });
    this.deps.onChange?.(this.titles());
    return true;
  }

  /** The title a publish names: the file's `<title>`, else Claude's `input.title`, else ''. */
  async titleOf(pub: Pick<PagePublish, 'path' | 'inputTitle'>): Promise<string> {
    if (pub.path) {
      const read = await readPageTitle(pub.path);
      if (read.title) return read.title;
      if (read.reason !== 'no-title') this.log('[TITLE] read refused', { reason: read.reason });
    }
    return cleanText(pub.inputTitle, TITLE_MAX);
  }

  /** A publish seen in a followed transcript. */
  async learnPublish(pub: PagePublish, source: 'live' | 'backfill' = 'live'): Promise<boolean> {
    const title = await this.titleOf(pub);
    return title ? this.learn(pub.id, title, source) : false;
  }
}
