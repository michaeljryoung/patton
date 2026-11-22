/**
 * Opening a web address in the default browser, with a record of what came of
 * it. Until S61 main fired `shell.openExternal(...).catch(() => {})` and told
 * the caller nothing: a refused address or a failed hand-off to the browser
 * left no line in main.log and no sign in the panel, so "the bookmark does
 * nothing" could not be told from "the browser showed the wrong page".
 * Pure apart from the `opener` and `log` it is given.
 */

/** Longer addresses are refused (the renderer refuses them before sending, too). */
export const WEB_URL_MAX_CHARS = 2048;

/** The normalised address to open (punycode host, `\` read as `/`), or null when it may not be opened. */
export function parseWebUrl(url: unknown): string | null {
  if (typeof url !== 'string' || url.length > WEB_URL_MAX_CHARS) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null; // not a URL
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null; // other schemes can launch local apps
  return parsed.href;
}

export interface WebOpenLog {
  info: (msg: string, data?: object) => void;
  warn: (msg: string, data?: object) => void;
}

/** What a log line may say about an address: the host and the path's length, never the path (an artifact link can carry a share token). */
function describe(href: string): { scheme: string; host: string; pathChars: number } {
  const u = new URL(href);
  return { scheme: u.protocol.replace(':', ''), host: u.host, pathChars: (u.pathname + u.search).length };
}

/**
 * Hand the address to the browser. Resolves true once the hand-off was made,
 * false when the address was refused or the hand-off failed; each outcome is
 * logged, so a failure shows in main.log.
 */
export async function openWebUrl(
  url: unknown,
  opener: (href: string) => Promise<void>,
  log: WebOpenLog,
): Promise<boolean> {
  const href = parseWebUrl(url);
  if (href === null) {
    log.warn('[LINK] web open refused', {
      reason: typeof url !== 'string' ? 'not a string' : url.length > WEB_URL_MAX_CHARS ? 'too long' : 'not an http(s) address',
      chars: typeof url === 'string' ? url.length : 0,
    });
    return false;
  }
  try {
    await opener(href);
    log.info('[LINK] web open handed to the browser', describe(href));
    return true;
  } catch (err) {
    log.warn('[LINK] web open failed', { ...describe(href), error: (err as Error).message });
    return false;
  }
}
