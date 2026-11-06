import type { Tab } from '../components/tab';
import { rlog } from './renderer-logger';

/** How long to wait for the shell's first prompt before typing anyway. */
const PROMPT_FALLBACK_MS = 1500;

/**
 * Type the user's startup command (Settings → Startup Command, e.g. `claude`)
 * into a freshly opened tab's shell.
 *
 * Timing: wait for the shell's first prompt signal (OSC 133) rather than a
 * fixed delay. A slow shell (plugins, slow .zshrc) can take longer than any
 * fixed delay on cold start, and a command typed before the shell is ready
 * gets swallowed. The fallback timer covers shells without shell integration
 * (no OSC 133 emitted).
 *
 * Used at launch (the first or restored active tab) and when a project
 * bookmark opens a new tab.
 */
export function runStartupCommand(tab: Tab, cmd: string): void {
  const ptyId = tab.ptyId;
  if (!cmd || ptyId === null) return;

  let fired = false;
  let disposePrompt: (() => void) | null = null;
  const fire = (via: 'prompt' | 'fallback') => {
    if (fired) return;
    fired = true;
    disposePrompt?.();
    window.patton.pty.write(ptyId, cmd + '\r');
    rlog('info', '[STARTUP] Startup command sent', { via });
  };

  disposePrompt = tab.focusedPane.terminalView.onPromptState((state) => {
    if (state === 'prompt') fire('prompt');
  });
  setTimeout(() => fire('fallback'), PROMPT_FALLBACK_MS);
}
