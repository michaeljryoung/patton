/**
 * The ONE place that decides whether a link target may be opened, and as what.
 * Shared by FileLinkProvider (paths guessed from text) and the OSC 8 handler
 * (targets a program asked us to link). Pure functions, no DOM, no IPC.
 *
 * Main re-validates everything it receives (ipc-handlers.ts: openWebUrl and
 * APP_OPEN_IN_EDITOR); these rules are the first gate, not the only one.
 */

import type { FileLinkAction } from '../../shared/types';

/** Main refuses longer URLs; refuse here too so nothing is sent just to fail. */
const MAX_URL_LENGTH = 2048;

/** A `..` path segment: the traversal check applied to every path we open. */
const TRAVERSAL_RE = /(?:^|\/)\.\.(?:\/|$)/;

export function hasTraversal(path: string): boolean {
  return TRAVERSAL_RE.test(path);
}

/**
 * Resolve a path printed by a program to what main is sent: traversal is
 * rejected before and after resolution, relative paths are joined to the
 * pane's cwd, and `~/…` stays as is (main expands it; the renderer doesn't
 * know $HOME). Returns null when the path is refused.
 */
export function resolveLocalPath(filePath: string, cwd: string): string | null {
  if (hasTraversal(filePath)) return null;
  let target = filePath;
  if (!target.startsWith('/') && !target.startsWith('~/') && cwd) {
    target = `${cwd}/${target}`;
  }
  if (hasTraversal(target)) return null;
  return target;
}

export type LinkTarget =
  | { kind: 'web'; url: string; scheme: string }
  | { kind: 'file'; path: string; scheme: 'file' }
  | { kind: 'refused'; scheme: string; reason: string };

/** Host names this Mac answers to, lower-cased, with and without ".local". */
export function localHostNames(hostname: string): string[] {
  const name = hostname.trim().toLowerCase();
  if (!name) return [];
  return name.endsWith('.local') ? [name, name.slice(0, -'.local'.length)] : [name, `${name}.local`];
}

function refuse(scheme: string, reason: string): LinkTarget {
  return { kind: 'refused', scheme, reason };
}

/**
 * Decide what an OSC 8 target (a URI) is allowed to open.
 *  - http: / https: → the default browser.
 *  - file: with an empty host, `localhost` or one of `localHosts` → a local
 *    path through the same rules as every other path link.
 *  - everything else (javascript:, data:, ftp:, ssh:, custom app schemes that
 *    can launch local apps…) is refused.
 */
export function resolveHyperlink(uri: string, cwd: string, localHosts: readonly string[]): LinkTarget {
  if (typeof uri !== 'string' || uri.length === 0) return refuse('', 'empty');
  if (uri.length > MAX_URL_LENGTH) return refuse('', 'too long');

  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return refuse('', 'not a URL');
  }
  const scheme = url.protocol.replace(/:$/, '');

  if (url.protocol === 'http:' || url.protocol === 'https:') {
    return { kind: 'web', url: url.href, scheme };
  }
  if (url.protocol !== 'file:') return refuse(scheme, 'scheme not allowed');

  const host = url.hostname.toLowerCase();
  if (host !== '' && host !== 'localhost' && !localHosts.includes(host)) {
    return refuse(scheme, 'remote host');
  }

  // `new URL` collapses `..` in the pathname, so look at the raw text too,
  // including the percent-encoded form (%2e%2e).
  const raw = uri.replace(/^file:\/\/[^/]*/i, '').replace(/[?#].*$/, '');
  let decodedRaw: string;
  let path: string;
  try {
    decodedRaw = decodeURIComponent(raw);
    path = decodeURIComponent(url.pathname);
  } catch {
    return refuse(scheme, 'bad percent-encoding');
  }
  if (hasTraversal(raw) || hasTraversal(decodedRaw) || hasTraversal(path)) return refuse(scheme, 'traversal');
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(path)) return refuse(scheme, 'control character');
  if (!path.startsWith('/') || path === '/') return refuse(scheme, 'not a file path');

  const resolved = resolveLocalPath(path, cwd);
  if (resolved === null) return refuse(scheme, 'traversal');
  return { kind: 'file', path: resolved, scheme: 'file' };
}

/**
 * Spans of `scheme://…` addresses in a line of text, as [start, end) offsets.
 * The bare-path pattern would otherwise read the part after the slashes as a
 * path: "https://www.clearscore.com" contains "/www.clearscore.com", which
 * opened as a missing file (main.log, 5 Nov). `file://` addresses are left
 * out: the path inside them IS the target, so the bare-path pass links it and
 * it goes through the same file rules as any other path.
 */
export function urlSpans(text: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  const re = /[a-z][a-z0-9+.-]*:\/\/[^\s<>"'`)\]]*/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    if (/^file:/i.test(match[0])) continue;
    spans.push([match.index, match.index + match[0].length]);
  }
  return spans;
}

/** Hover text never exceeds this many characters (the box wraps, never cuts). */
const TOOLTIP_MAX = 120;

/** Shorten `text` to `max` characters by cutting from the MIDDLE, so both
 *  ends (scheme and host, folder and file name) stay readable. */
export function elideMiddle(text: string, max: number): string {
  if (text.length <= max) return text;
  if (max <= 1) return '…';
  const keep = max - 1;
  const head = Math.ceil(keep / 2);
  return `${text.slice(0, head)}…${text.slice(text.length - (keep - head))}`;
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/** What main will do with a file link (main/link-open-policy.ts decides). */
export type FileLinkOutcome = FileLinkAction;

/**
 * The hover text for a link: exactly what a double-click will open, never
 * the raw URI a program printed. Web links show the normalised URL (punycode
 * host, `\` read as `/`), whose scheme and host are always shown in full;
 * file links show the decoded path with the file name always in full; a file
 * main will only reveal says so. Long text is cut in the middle.
 */
export function describeLinkTarget(target: LinkTarget, fileOutcome?: FileLinkOutcome): string {
  if (target.kind === 'refused') {
    return `Won't open ${target.scheme ? `${target.scheme}: link` : 'link'} (${target.reason})`;
  }
  if (target.kind === 'web') {
    let head = target.url;
    try {
      const u = new URL(target.url);
      const auth = u.username || u.password ? `${u.username}${u.password ? `:${u.password}` : ''}@` : '';
      const h = `${u.protocol}//${auth}${u.host}`;
      if (target.url.startsWith(h)) head = h;
    } catch { /* keep the whole URL as the head */ }
    const rest = target.url.slice(head.length);
    return head + elideMiddle(rest, Math.max(16, TOOLTIP_MAX - head.length));
  }
  const name = baseName(target.path);
  if (fileOutcome === 'reveal') return `Reveal in Finder: ${name}`;
  if (fileOutcome === 'missing') return `No such file: ${name}`;
  if (fileOutcome === 'refused') return `Won't open: ${name}`;
  const dir = target.path.slice(0, target.path.length - name.length);
  return elideMiddle(dir, Math.max(12, TOOLTIP_MAX - name.length)) + name;
}
