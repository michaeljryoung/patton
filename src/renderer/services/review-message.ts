/**
 * The one message "Send comments to Claude" pastes into the Claude session
 * the document opened from (docs/review-tab.md R4). Pure, so a check can read
 * it. Comment and quote text is the document's, untrusted: control characters
 * go (the pane strips paste controls again), each comment stays on one line.
 */
import type { ReviewComment, ReviewDocInfo } from '../../shared/review';

/** Longest quote repeated in the message (the comment is anchored in the file anyway). */
export const MESSAGE_QUOTE_MAX = 200;

function oneLine(text: string): string {
  return text.replace(/[\p{Cc}\u2028\u2029]+/gu, ' ').replace(/\s+/g, ' ').trim();
}

function cut(text: string, max: number): string {
  const chars = [...text];
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join('')}…`;
}

export function reviewMessage(info: Pick<ReviewDocInfo, 'shownPath'>, comments: readonly ReviewComment[]): string {
  const lines = [`Comments on ${oneLine(info.shownPath)} (${comments.length}), saved in the file as Word comments:`, ''];
  comments.forEach((c, i) => {
    const quote = cut(oneLine(c.quote), MESSAGE_QUOTE_MAX);
    const who = oneLine(c.author);
    lines.push(`${i + 1}. ${quote ? `On "${quote}": ` : ''}${oneLine(c.text)}${who ? ` (${who})` : ''}`);
  });
  lines.push('', 'Please revise the document for these comments.');
  return lines.join('\n');
}
