// Unsent input per PTY: has anything been typed into the program's input line
// since the last Enter? Pause all and the checkpoint clock use it to stash a
// draft (Claude Code's Ctrl+S) before typing their word, so `pause` is never
// appended to half-written text (Michael, 10 Nov 2026: "even if there is text
// in the line we still need to pause but then ideally put the text back").
//
// Every write to a PTY passes main's PTY_WRITE handler (typed keys, the compose
// box's submit, broadcast, Shift+Enter, Tab, Ctrl+C, image paste), so the
// tracker sits there and sees the bytes, never the screen. It counts the
// line's length where it can and errs on the side of "dirty": a wrong "dirty"
// costs a Ctrl+S on an empty line, a wrong "clean" appends the word to a draft.
//
// Rules, per write:
// - ESC-led terminal replies (cursor reports, device attributes, focus
//   in/out, mouse reports, OSC answers such as the 7501 probe reply) are
//   ignored: they are the terminal talking, not the user.
// - Printable bytes add to `length`; Backspace and Delete take one off
//   (never below 0).
// - Up/Down (history), a long or multi-line bracketed paste, Tab, Ctrl+R,
//   Ctrl+G, Ctrl+V, Shift+Enter / Alt+Enter, and an Enter typed while an `@`
//   token is open in the line (it may pick a completion, not submit) make the
//   length unknown (null), which counts as dirty.
// - A bare CR or LF outside a paste clears it. Ctrl+C clears it only in a
//   write the renderer tagged 'at-prompt' (Claude's root done or idle with
//   nothing blocked, where Ctrl+C empties the input line); elsewhere it, Esc
//   and other editing keys leave it as it was.
// - Ctrl+S (Claude Code's chat:stash) empties a non-empty line, and Claude
//   Code puts the stash back by itself after the next submit (its
//   `popStash("outside")`), so after that submit the line is dirty again.
//   On an empty line Ctrl+S pops an older stash instead: unknown.
//   A user's Ctrl+S sets `userStashAt`; Patton's own sets `pattonStashAt`,
//   which the user's next submit of a non-empty line clears.
// Patton's own startup-command write is not passed in at all (the renderer
// tags it).
//
// Also kept, for Pause all's "might be in a menu" and "typed since the stop"
// rules (wall-clock ms, compared with the renderer's Date.now()):
// - lastInputAt: the last write that was user input (anything but a reply).
// - slashSubmitAt: when the last submitted line began with `/` or with
//   something the tracker can't read (a recalled history line, an image);
//   0 once a line known to be plain text is submitted.

import type { PtyWriteOrigin, UnsentInputState } from '../shared/types';

/** What the line has started with since it was last empty. */
type LineStart = 'empty' | 'slash' | 'text' | 'unknown';

/** A paste longer than this is shown collapsed by Claude Code (or may be):
 *  its length in the line is unknown. */
const PASTE_LONG = 200;

interface PtyInput {
  /** Characters in the line; null: unknown. */
  length: number | null;
  line: LineStart;
  /** An `@` token is open (no whitespace typed since the `@`). */
  atToken: boolean;
  inPaste: boolean;
  pasteLength: number;
  pasteMultiLine: boolean;
  /** A stash was made in this line: Claude Code restores it after the submit. */
  stashed: { line: LineStart; length: number | null } | null;
  lastInputAt: number;
  slashSubmitAt: number;
  userStashAt: number;
  pattonStashAt: number;
}

const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

function fresh(): PtyInput {
  return {
    length: 0, line: 'empty', atToken: false, inPaste: false, pasteLength: 0, pasteMultiLine: false,
    stashed: null, lastInputAt: 0, slashSubmitAt: 0, userStashAt: 0, pattonStashAt: 0,
  };
}

export class UnsentInputTracker {
  private ptys = new Map<number, PtyInput>();

  constructor(private readonly now: () => number = Date.now) {}

  state(id: number): UnsentInputState {
    const s = this.ptys.get(id) ?? fresh();
    return {
      dirty: s.length !== 0,
      length: s.length,
      lastInputAt: s.lastInputAt,
      slashSubmitAt: s.slashSubmitAt,
      userStashAt: s.userStashAt,
      pattonStashAt: s.pattonStashAt,
    };
  }

  /** The PTY is gone (exit or destroy). */
  forget(id: number): void {
    this.ptys.delete(id);
  }

  /** One write to the PTY. `origin` undefined or 'at-prompt': the user's;
   *  'patton': Patton's own words. */
  note(id: number, data: string, origin?: PtyWriteOrigin): void {
    if (origin === 'startup') return;
    let s = this.ptys.get(id);
    if (!s) { s = fresh(); this.ptys.set(id, s); }
    const user = origin !== 'patton';
    let input = false;
    let i = 0;
    while (i < data.length) {
      if (data.startsWith(PASTE_START, i)) {
        s.inPaste = true; s.pasteLength = 0; s.pasteMultiLine = false; input = true;
        i += PASTE_START.length;
        continue;
      }
      if (data.startsWith(PASTE_END, i)) {
        if (s.inPaste) this.pasted(s);
        s.inPaste = false; input = true;
        i += PASTE_END.length;
        continue;
      }
      const ch = data[i];
      if (s.inPaste) {
        // A paste's payload, newlines included, is text in the line.
        if (ch === '\r' || ch === '\n') s.pasteMultiLine = true;
        else this.startLine(s, ch);
        s.pasteLength += 1;
        input = true;
        i += 1;
        continue;
      }
      if (ch === '\x1b') {
        const seq = escapeSequence(data, i);
        i += seq.length;
        if (seq.kind === 'reply') continue;
        input = true;
        if (seq.kind === 'edits') this.unknown(s);
        else if (seq.kind === 'delete') this.deleted(s);
        continue;
      }
      input = true;
      i += 1;
      if (ch === '\r' || ch === '\n') { this.enter(s, user); continue; }
      if (ch === '\x13') { this.stash(s, user); continue; }
      if (ch === '\x7f' || ch === '\x08') { this.deleted(s); continue; }
      if (ch === '\x03') { if (origin === 'at-prompt') this.cleared(s); continue; }
      // Tab (completion), Ctrl+G (external editor), Ctrl+R (history search),
      // Ctrl+V (image paste): the line may now hold anything.
      if (ch === '\t' || ch === '\x07' || ch === '\x12' || ch === '\x16') { this.unknown(s); continue; }
      const code = ch.charCodeAt(0);
      if (code >= 0x20) this.typed(s, ch);
      // Other control characters (Ctrl+U, Ctrl+W, …): unchanged.
    }
    if (input && user) s.lastInputAt = this.now();
  }

  private startLine(s: PtyInput, ch: string): void {
    if (s.line === 'empty') s.line = ch === '/' ? 'slash' : 'text';
  }

  private typed(s: PtyInput, ch: string): void {
    this.startLine(s, ch);
    if (s.length !== null) s.length += 1;
    if (ch === '@') s.atToken = true;
    else if (ch === ' ') s.atToken = false;
  }

  /** A bracketed paste ended: short and single-line adds its length. */
  private pasted(s: PtyInput): void {
    if (s.pasteMultiLine || s.pasteLength > PASTE_LONG) this.unknown(s);
    else if (s.length !== null) s.length += s.pasteLength;
  }

  /** Backspace or Delete: one character fewer, if there was one. */
  private deleted(s: PtyInput): void {
    if (s.length === null) return;
    s.length = Math.max(0, s.length - 1);
    if (s.length === 0) this.cleared(s);
  }

  /** The line is known to be empty. */
  private cleared(s: PtyInput): void {
    s.length = 0;
    s.line = 'empty';
    s.atToken = false;
  }

  /** Something changed the line that the tracker can't read. */
  private unknown(s: PtyInput): void {
    s.length = null;
    if (s.line === 'empty') s.line = 'unknown';
  }

  private stash(s: PtyInput, user: boolean): void {
    if (user) s.userStashAt = this.now();
    else s.pattonStashAt = this.now();
    if (s.length !== null && s.length > 0) {
      // A non-empty line is stashed and the line emptied.
      s.stashed = { line: s.line, length: s.length };
      this.cleared(s);
    } else if (s.length === null) {
      // Stashed or popped, the tracker can't tell: still unknown either way.
      s.stashed = { line: 'unknown', length: null };
      s.line = 'unknown';
    } else {
      // An empty line pops an older stash back, if Claude Code holds one.
      this.unknown(s);
    }
  }

  private enter(s: PtyInput, user: boolean): void {
    if (s.atToken) {
      // Enter may have picked an `@` completion rather than submitted.
      s.atToken = false;
      this.unknown(s);
      return;
    }
    if (s.line === 'slash' || s.line === 'unknown') s.slashSubmitAt = this.now();
    else if (s.line === 'text') s.slashSubmitAt = 0;
    // An empty Enter (a picker's choice, an empty prompt) leaves it.
    if (user && s.line !== 'empty') s.pattonStashAt = 0;
    this.cleared(s);
    if (s.stashed !== null) {
      // Claude Code restores the stash after the submit ("Draft restored").
      s.line = s.stashed.line;
      s.length = s.stashed.length;
      if (s.length === 0) s.length = null;
      s.stashed = null;
    }
  }
}

/** One escape sequence starting at data[i]: its length and what it does to the line. */
function escapeSequence(data: string, i: number): { length: number; kind: 'reply' | 'key' | 'edits' | 'delete' } {
  const next = data[i + 1];
  if (next === undefined) return { length: 1, kind: 'key' }; // a lone Esc
  if (next === '[') {
    // CSI: parameters and intermediates, then one final byte 0x40–0x7e.
    let j = i + 2;
    while (j < data.length) {
      const c = data.charCodeAt(j);
      if (c >= 0x40 && c <= 0x7e) break;
      j += 1;
    }
    const body = data.slice(i + 2, j);
    const final = data[j] ?? '';
    const length = Math.min(j + 1, data.length) - i;
    if (final === 'A' || final === 'B') return { length, kind: 'edits' }; // Up/Down: history
    if (final === 'u' && !body.startsWith('?')) {
      // Kitty keyboard key: Shift+Enter (13;2u, pane.ts) inserts a newline.
      return { length, kind: body.startsWith('13;') ? 'edits' : 'key' };
    }
    if (final === '~' && body === '3') return { length, kind: 'delete' };
    // Left/Right, Home/End, Page keys, Shift+Tab: keys that don't add text.
    if ('CDHFZ~'.includes(final) && !body.startsWith('?') && !body.startsWith('<')) return { length, kind: 'key' };
    // Cursor reports (R), device attributes (c), mode reports (y), focus in
    // and out (I, O), mouse (M, m) and anything else: the terminal's answers.
    return { length, kind: 'reply' };
  }
  if (next === ']' || next === 'P' || next === '_' || next === '^') {
    // OSC / DCS / APC / PM: up to BEL or ST. Always the terminal's answers.
    let j = i + 2;
    while (j < data.length) {
      if (data[j] === '\x07') { j += 1; break; }
      if (data[j] === '\x1b' && data[j + 1] === '\\') { j += 2; break; }
      j += 1;
    }
    return { length: j - i, kind: 'reply' };
  }
  if (next === 'O') {
    // SS3: arrow keys in application mode, F1–F4.
    const final = data[i + 2] ?? '';
    return { length: Math.min(3, data.length - i), kind: final === 'A' || final === 'B' ? 'edits' : 'key' };
  }
  // Alt+Enter inserts a newline in Claude Code; other Alt+key: a key.
  if (next === '\r' || next === '\n') return { length: 2, kind: 'edits' };
  return { length: 2, kind: 'key' };
}
