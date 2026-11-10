// Is Ctrl+S still Claude Code's "stash the draft" key (chat:stash)? Pause all
// and the checkpoint clock press it before typing their word into a line that
// may hold a draft (unsent-input.ts). If the user's ~/.claude/keybindings.json
// rebinds chat:stash, or binds ctrl+s to something else, Ctrl+S would do that
// something else, so those panes are skipped instead.
//
// The file is read on every press (it is small). Format, from Claude Code
// 2.1.321's defaults: { "bindings": [ { "context": "Chat", "bindings":
// { "ctrl+s": "chat:stash", … } }, … ] }; a null action unbinds a key. Any
// file that can't be read as that shape counts as rebound: skipping a draft
// pane is safe, pressing an unknown key is not.

import { readFileSync } from 'node:fs';
import type { StashKeyVerdict } from '../shared/types';

/** "ctrl+s", "Ctrl + S", "control+s" → "ctrl+s"; chords keep their spaces as one. */
function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/\s*\+\s*/g, '+').replace(/\s+/g, ' ').replace(/\bcontrol\+/g, 'ctrl+').trim();
}

/** Decide from the file's text (null: no file). Pure, for the check script. */
export function stashKeyVerdict(text: string | null): StashKeyVerdict {
  if (text === null) return { ok: true };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, why: 'keybindings.json does not parse' };
  }
  const blocks = (parsed as { bindings?: unknown })?.bindings;
  if (!Array.isArray(blocks)) return { ok: false, why: 'keybindings.json has no bindings list' };
  for (const block of blocks) {
    const map = (block as { bindings?: unknown })?.bindings;
    if (!map || typeof map !== 'object') return { ok: false, why: 'keybindings.json block without bindings' };
    for (const [rawKey, action] of Object.entries(map as Record<string, unknown>)) {
      const key = normalizeKey(rawKey);
      const isCtrlS = key === 'ctrl+s';
      const startsChord = key.startsWith('ctrl+s ');
      if ((isCtrlS || startsChord) && action !== 'chat:stash') return { ok: false, why: `ctrl+s is bound to ${String(action)}` };
      if (action === 'chat:stash' && !isCtrlS) return { ok: false, why: `chat:stash is bound to ${key}` };
    }
  }
  return { ok: true };
}

/** Read ~/.claude/keybindings.json now and decide. */
export function readStashKeyVerdict(file: string): StashKeyVerdict {
  let text: string | null;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') text = null;
    else return { ok: false, why: `keybindings.json unreadable (${(err as NodeJS.ErrnoException)?.code ?? 'error'})` };
  }
  return stashKeyVerdict(text);
}
