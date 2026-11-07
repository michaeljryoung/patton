import type { ILinkHandler, Terminal } from '@xterm/xterm';
import { rlog } from './renderer-logger';
import { localHostNames, resolveHyperlink, type LinkTarget } from './link-target';

/**
 * OSC 8 hyperlinks: `ESC ] 8 ; params ; URI ST text ESC ] 8 ; ; ST`.
 *
 * A program (Claude Code, ls --hyperlink, gcc, ripgrep…) says "this text links
 * to that URI". Patton advertises support with FORCE_HYPERLINK=1 (pty-manager.ts),
 * so more tools will start emitting these, and the URI is untrusted input from
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

  const hideTooltip = (): void => {
    tooltip?.remove();
    tooltip = null;
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
      hideTooltip();
      void open(uri);
    },

    hover(event: MouseEvent, uri: string): void {
      const host = terminal.element;
      if (!host) return;
      hideTooltip();
      const el = document.createElement('div');
      // `xterm-hover` stops mouse events falling through to other links.
      el.className = 'xterm-hover osc8-tooltip';
      el.setAttribute('role', 'tooltip');
      el.textContent = uri.length > 300 ? `${uri.slice(0, 300)}…` : uri;
      const box = host.getBoundingClientRect();
      el.style.left = `${Math.max(0, event.clientX - box.left)}px`;
      el.style.top = `${Math.max(0, event.clientY - box.top + 16)}px`;
      host.appendChild(el);
      tooltip = el;
    },

    leave(): void {
      hideTooltip();
    },
  };
}
