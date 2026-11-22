/**
 * Copy from a Claude tab with Claude's original text (copy-match.ts) instead
 * of the drawn grid. No Electron import: the clipboard and the transcript come
 * in as dependencies, so scripts/check-copy-original.mjs drives it directly.
 *
 * Two modes:
 * - `copy` (⌘C, Edit ▸ Copy, the context menu, the compose box's ⌘C): the
 *   lookup gets `quickMs` (100 ms). In time, the original goes on the
 *   clipboard (plain text and HTML), or the drawn text when there is none.
 *   Late, the drawn text goes on at once, and the original replaces it only if
 *   it lands within `lateMs` (1 s) of the copy and the clipboard still holds
 *   the drawn text, and no newer copy began.
 * - `upgrade` (copy-on-select, which already wrote the drawn text): only that
 *   replacement, on the same terms.
 *
 * Logs `[COPY] original {pty, chars, msgsSearched, ms, late}` and
 * `[COPY] fallback {pty, reason, msgsSearched, ms}`; never the text.
 */
import { findOriginal, type OriginalCopy } from './copy-match';

export interface CopyClipboard {
  writeText(text: string): Promise<void>;
  /** Plain text and HTML together, atomically. */
  write(data: OriginalCopy): Promise<void>;
  readText(): Promise<string>;
}

export interface CopyOriginalDeps {
  /** The pty's Claude transcript, or null when the pane has none attached. */
  transcriptFor(ptyId: number): string | null;
  /** The transcript's recent assistant text blocks. */
  recentTexts(path: string): Promise<string[]>;
  clipboard: CopyClipboard;
  log?: (msg: string, data: Record<string, unknown>) => void;
  now?: () => number;
  quickMs?: number;
  lateMs?: number;
}

export type CopyMode = 'copy' | 'upgrade';
export type CopyOutcome = 'original' | 'fallback' | 'late';

type Lookup =
  | { ok: true; copy: OriginalCopy; msgsSearched: number }
  | { ok: false; reason: string; msgsSearched: number };

export class CopyOriginal {
  private seq = 0;
  private readonly now: () => number;
  private readonly log: (msg: string, data: Record<string, unknown>) => void;
  private readonly quickMs: number;
  private readonly lateMs: number;

  constructor(private readonly deps: CopyOriginalDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.log = deps.log ?? ((msg, data) => console.info(msg, data));
    this.quickMs = deps.quickMs ?? 100;
    this.lateMs = deps.lateMs ?? 1000;
  }

  /** Looks the selection up; never throws. */
  async lookup(ptyId: number, selection: string): Promise<Lookup> {
    const path = this.deps.transcriptFor(ptyId);
    if (!path) return { ok: false, reason: 'no transcript', msgsSearched: 0 };
    let texts: string[];
    try {
      texts = await this.deps.recentTexts(path);
    } catch (err) {
      return { ok: false, reason: `transcript unreadable (${(err as { code?: string }).code ?? 'error'})`, msgsSearched: 0 };
    }
    try {
      return findOriginal(selection, texts);
    } catch {
      return { ok: false, reason: 'match error', msgsSearched: texts.length };
    }
  }

  /**
   * Resolves once the clipboard holds something for this copy: 'original',
   * 'fallback' (the drawn text), or 'late' (the drawn text, with the original
   * perhaps to follow). In `upgrade` mode it resolves when the lookup is done.
   */
  async copy(ptyId: number, selection: string, mode: CopyMode): Promise<CopyOutcome> {
    const seq = ++this.seq;
    const t0 = this.now();
    const pending = this.lookup(ptyId, selection);

    if (mode === 'upgrade') {
      const r = await pending;
      return (await this.replaceIfCurrent(r, seq, t0, ptyId, selection)) ? 'original' : 'fallback';
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    const quick: Lookup | null = await Promise.race<Lookup | null>([
      pending,
      new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), this.quickMs); }),
    ]);
    clearTimeout(timer);

    if (quick) {
      if ('copy' in quick) {
        await this.deps.clipboard.write(quick.copy);
        this.logOriginal(ptyId, quick.copy, quick.msgsSearched, t0, false);
        return 'original';
      }
      await this.deps.clipboard.writeText(selection);
      this.log('[COPY] fallback', { pty: ptyId, reason: 'reason' in quick ? quick.reason : '', msgsSearched: quick.msgsSearched, ms: this.now() - t0 });
      return 'fallback';
    }

    await this.deps.clipboard.writeText(selection);
    void pending.then((r) => this.replaceIfCurrent(r, seq, t0, ptyId, selection)).catch((err: unknown) => {
      this.log('[COPY] fallback', { pty: ptyId, reason: `late write failed (${(err as Error).name})` });
    });
    return 'late';
  }

  /** Puts the original over the drawn text if it is still the clipboard's, in time. */
  private async replaceIfCurrent(r: Lookup, seq: number, t0: number, ptyId: number, selection: string): Promise<boolean> {
    const ms = this.now() - t0;
    if (!('copy' in r)) {
      this.log('[COPY] fallback', { pty: ptyId, reason: r.reason, msgsSearched: r.msgsSearched, ms });
      return false;
    }
    let why = '';
    if (ms > this.lateMs) why = 'too slow';
    else if (seq !== this.seq) why = 'newer copy';
    else {
      let current = '';
      try { current = await this.deps.clipboard.readText(); } catch { current = ''; }
      if (current !== selection) why = 'clipboard changed';
    }
    if (why) {
      this.log('[COPY] fallback', { pty: ptyId, reason: why, msgsSearched: r.msgsSearched, ms });
      return false;
    }
    // The clipboard read took time: check once more that no newer copy began.
    if (seq !== this.seq) {
      this.log('[COPY] fallback', { pty: ptyId, reason: 'newer copy', msgsSearched: r.msgsSearched, ms: this.now() - t0 });
      return false;
    }
    await this.deps.clipboard.write(r.copy);
    this.logOriginal(ptyId, r.copy, r.msgsSearched, t0, true);
    return true;
  }

  private logOriginal(ptyId: number, copy: OriginalCopy, msgsSearched: number, t0: number, late: boolean): void {
    this.log('[COPY] original', { pty: ptyId, chars: copy.text.length, msgsSearched, ms: this.now() - t0, late });
  }
}
