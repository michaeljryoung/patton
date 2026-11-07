import type { ILinkHandler, Terminal } from '@xterm/xterm';
import { rlog } from './renderer-logger';
import { describeLinkTarget, localHostNames, resolveHyperlink, type FileLinkOutcome, type LinkTarget } from './link-target';

/**
 * OSC 8 hyperlinks: `ESC ] 8 ; params ; URI ST text ESC ] 8 ; ; ST`.
 *
 * A program (Claude Code, ls --hyperlink, gcc, ripgrep…) says "this text links
 * to that URI". Patton advertises support with FORCE_HYPERLINK=1 (pty-manager.ts) in
 * the pane that runs the startup command, so Claude Code and the tools it
 * runs emit these, and the URI is untrusted input from
 * whatever is printing to the terminal: every target goes through
 * `resolveHyperlink` (link-target.ts), the same rules as Patton's other links,
 * and main re-validates what it is sent.
 *
 * Gesture matches the other links: double-click opens, a single click is left
 * to xterm for selection.
 */

let localHosts: Promise<string[]> | null = null;

/** This Mac's host names, asked of main once. `file://<hostname>/…` is what
 *  shells and tools print for a local file. */
function getLocalHosts(): Promise<string[]> {
  if (!localHosts) {
    localHosts = window.patton.getHostname().then(localHostNames).catch((): string[] => []);
  }
  return localHosts;
}

/** What a log line may say about a target: scheme, and host for web links.
 *  Never a file path (home-relative or not) or a query string. */
function describeForLog(target: LinkTarget): Record<string, string> {
  if (target.kind === 'web') {
    let host = '';
    try { host = new URL(target.url).host; } catch { /* keep empty */ }
    return { scheme: target.scheme, host };
  }
  if (target.kind === 'file') return { scheme: 'file' };
  return { scheme: target.scheme || '(none)', reason: target.reason };
}

export function createOsc8LinkHandler(terminal: Terminal, getCwd: () => string): ILinkHandler {
  let tooltip: HTMLElement | null = null;
  // Bumped on every hover and leave, so a late answer from main can't show a
  // tooltip for a link the pointer has already left.
  let hoverSeq = 0;

  const hideTooltip = (): void => {
    tooltip?.remove();
    tooltip = null;
  };

  const showTooltip = (event: MouseEvent, text: string): void => {
    const host = terminal.element;
    if (!host) return;
    hideTooltip();
    const el = document.createElement('div');
    // `xterm-hover` stops mouse events falling through to other links.
    el.className = 'xterm-hover osc8-tooltip';
    el.setAttribute('role', 'tooltip');
    el.textContent = text;
    const box = host.getBoundingClientRect();
    el.style.top = `${Math.max(0, event.clientY - box.top + 16)}px`;
    host.appendChild(el);
    // Keep the whole box inside the pane: shift left near the right edge.
    const left = Math.min(Math.max(0, event.clientX - box.left), Math.max(0, box.width - el.offsetWidth));
    el.style.left = `${left}px`;
    tooltip = el;
  };

  const open = async (uri: string): Promise<void> => {
    const target = resolveHyperlink(uri, getCwd(), await getLocalHosts());
    if (target.kind === 'refused') {
      rlog('warn', '[LINK] osc8 refused', describeForLog(target));
      return;
    }
    try {
      if (target.kind === 'web') await window.patton.openExternal(target.url);
      else await window.patton.editor.openFile(target.path);
      rlog('info', '[LINK] osc8 open', { ...describeForLog(target), outcome: 'sent' });
    } catch (err) {
      rlog('warn', '[LINK] osc8 open failed', { ...describeForLog(target), error: (err as Error).message });
    }
  };

  return {
    // Without this xterm drops every non-http(s) URI before we see it, and
    // file: is the one non-http scheme we do open. Everything is re-judged in
    // `open`, so javascript:, data: and the rest still end up refused.
    allowNonHttpProtocols: true,

    activate(event: MouseEvent, uri: string): void {
      if (event.detail !== 2) return;
      hoverSeq++;
      hideTooltip();
      void open(uri);
    },

    hover(event: MouseEvent, uri: string): void {
      // Show what a double-click will open, not the raw URI: the two differ
      // (`https://good.com\@evil.com/` opens good.com/@evil.com/, Cyrillic
      // hosts open as punycode), and a file main will only reveal says so.
      const seq = ++hoverSeq;
      void (async () => {
        const target = resolveHyperlink(uri, getCwd(), await getLocalHosts());
        let outcome: FileLinkOutcome | undefined;
        if (target.kind === 'file') {
          outcome = await window.patton.editor.linkAction(target.path).catch((): FileLinkOutcome => 'unknown');
        }
        if (seq !== hoverSeq) return; // pointer moved on
        showTooltip(event, describeLinkTarget(target, outcome));
      })();
    },

    leave(): void {
      hoverSeq++;
      hideTooltip();
    },
  };
}
