/**
 * Keeping a textarea's caret in view (docs/compose-box.md, D15: the box's
 * textarea scrolls past a third of the pane). The compose box sets the
 * textarea's height itself after every edit (EditorInput.autoResize), which
 * leaves the scroll where it was, so a long paste showed the top of the draft
 * with the caret out of sight below it until the next key.
 *
 * `scrollForCaret` is pure (jsdom checks it); `caretLineTop` measures where
 * the caret's line sits with a hidden mirror of the textarea.
 */

/** The scrollTop that brings the caret's line [lineTop, lineTop + lineH) into
 *  a viewport of `clientH` showing from `scrollTop`: unchanged when it is in
 *  view, else the least scroll that shows it (with the textarea's own padding
 *  kept at the edge it scrolled to), never below 0. */
export function scrollForCaret(
  lineTop: number, lineH: number, scrollTop: number, clientH: number, padTop: number, padBottom: number,
): number {
  if (!(clientH > 0) || !(lineH > 0)) return scrollTop;
  if (lineTop < scrollTop + padTop) return Math.max(0, lineTop - padTop);
  if (lineTop + lineH + padBottom > scrollTop + clientH) return Math.max(0, lineTop + lineH + padBottom - clientH);
  return scrollTop;
}

const MIRRORED = [
  'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'fontVariant', 'letterSpacing', 'wordSpacing',
  'lineHeight', 'textTransform', 'textIndent', 'tabSize', 'paddingTop', 'paddingRight', 'paddingBottom',
  'paddingLeft', 'wordBreak', 'textAlign',
] as const;

/** The top (px from the textarea's content top, padding included) and height
 *  of the line the caret is on, measured in a hidden copy of the text up to
 *  the caret. null when the textarea has no layout (a hidden tab). */
export function caretLineTop(ta: HTMLTextAreaElement): { top: number; height: number } | null {
  if (ta.clientWidth <= 0) return null;
  const cs = getComputedStyle(ta);
  const mirror = document.createElement('div');
  const st = mirror.style;
  for (const prop of MIRRORED) st[prop] = cs[prop];
  st.position = 'absolute';
  st.visibility = 'hidden';
  st.top = '0';
  st.left = '-99999px';
  st.boxSizing = 'border-box';
  st.width = `${ta.clientWidth}px`; // the text area's width less its scrollbar and borders
  st.border = '0';
  st.whiteSpace = 'pre-wrap';
  st.overflowWrap = 'break-word';
  const caret = ta.selectionDirection === 'backward' ? ta.selectionStart : ta.selectionEnd;
  mirror.textContent = ta.value.slice(0, caret);
  const marker = document.createElement('span');
  marker.textContent = '\u200b';
  mirror.appendChild(marker);
  document.body.appendChild(mirror);
  const out = { top: marker.offsetTop, height: marker.offsetHeight };
  mirror.remove();
  return out;
}

/** Scroll the textarea so the caret's line is visible. */
export function scrollCaretIntoView(ta: HTMLTextAreaElement): void {
  if (ta.scrollHeight <= ta.clientHeight) return;
  const line = caretLineTop(ta);
  if (!line) return;
  const cs = getComputedStyle(ta);
  const next = scrollForCaret(
    line.top, line.height, ta.scrollTop, ta.clientHeight,
    parseFloat(cs.paddingTop) || 0, parseFloat(cs.paddingBottom) || 0,
  );
  if (next !== ta.scrollTop) ta.scrollTop = next;
}

/** The caret's line is inside the textarea's visible part now. true when
 *  there is nothing to measure (no layout, or nothing to scroll). */
export function caretInView(ta: HTMLTextAreaElement): boolean {
  if (ta.scrollHeight <= ta.clientHeight) return true;
  const line = caretLineTop(ta);
  if (!line) return true;
  const cs = getComputedStyle(ta);
  return scrollForCaret(
    line.top, line.height, ta.scrollTop, ta.clientHeight,
    parseFloat(cs.paddingTop) || 0, parseFloat(cs.paddingBottom) || 0,
  ) === ta.scrollTop;
}
