/**
 * Strip the control characters that pasted or composed text must never carry
 * to a PTY, keeping tab, newline and carriage return. ESC (0x1b) is among the
 * stripped ones, so text can't carry its own ESC[201~ and end a bracketed
 * paste early, which would run the rest of it as keystrokes.
 */
// eslint-disable-next-line no-control-regex -- intentional: sanitize pasted control chars
const PASTE_CONTROL_CHARS = /[\x00-\x08\x0b\x0c\x0e-\x1f]/g;

export function stripPasteControls(text: string): string {
  return text.replace(PASTE_CONTROL_CHARS, '');
}
