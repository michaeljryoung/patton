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
 * bookmark opens a new tab. `go`: whether to send it after all, decided while
 * the shell starts (launch sends nothing to a tab the project board covers);
 * the prompt is watched from the start either way, so a late answer doesn't
 * miss it.
 */
export function runStartupCommand(tab: Tab, cmd: string, go: Promise<boolean> = Promise.resolve(true)): void {
  const ptyId = tab.ptyId;
  if (!cmd || ptyId === null) return;

  let fired = false;
  let shellReady: 'prompt' | 'fallback' | null = null;
  let allowed: boolean | null = null;
  let disposePrompt: (() => void) | null = null;
  const fireIfDue = () => {
    if (fired || shellReady === null || allowed !== true) return;
    fired = true;
    window.patton.pty.write(ptyId, cmd + '\r');
    rlog('info', '[STARTUP] Startup command sent', { via: shellReady });
  };
  const ready = (via: 'prompt' | 'fallback') => {
    if (shellReady !== null) return;
    shellReady = via;
    disposePrompt?.();
    fireIfDue();
  };

  disposePrompt = tab.focusedPane.terminalView.onPromptState((state) => {
    if (state === 'prompt') ready('prompt');
  });
  setTimeout(() => ready('fallback'), PROMPT_FALLBACK_MS);
  go.then(
    (ok) => {
      allowed = ok;
      if (!ok) {
        disposePrompt?.();
        rlog('info', '[STARTUP] Startup command not sent', { reason: 'project board shown' });
      }
      fireIfDue();
    },
    () => { allowed = true; fireIfDue(); },
  );
}
