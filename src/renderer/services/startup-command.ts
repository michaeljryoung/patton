import type { Tab } from '../components/tab';
import { rlog } from './renderer-logger';

/** How long to wait for the shell's first prompt before typing anyway. */
export const PROMPT_FALLBACK_MS = 1500;

/** The longest typeWhenShellReady waits for a shell that does report prompts
 *  but has not shown its first one (a very slow .zshrc), counted from when
 *  its PTY was created. */
export const SLOW_SHELL_MS = 10_000;

/** A pending send: `cancel` drops it (a tab that closed meanwhile). */
export interface PendingSend {
  cancel(): void;
}

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
 * Used at launch (the first or restored active tab), when a project
 * bookmark opens a new tab, and for the board's Wake button. `go`: whether to send it after all, decided while
 * the shell starts (launch sends nothing to a tab the project board covers);
 * the prompt is watched from the start either way, so a late answer doesn't
 * miss it.
 *
 * `opts.label` names the command in the log (default: "Startup command").
 * Returns null when nothing was armed (no command, or the tab has no PTY),
 * else a handle that cancels the send.
 */
export function runStartupCommand(
  tab: Tab,
  cmd: string,
  go: Promise<boolean> = Promise.resolve(true),
  opts: { label?: string } = {},
): PendingSend | null {
  const ptyId = tab.ptyId;
  const label = opts.label ?? 'Startup command';
  if (!cmd || ptyId === null) return null;

  let fired = false;
  let shellReady: 'prompt' | 'fallback' | null = null;
  let allowed: boolean | null = null;
  let disposePrompt: (() => void) | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const fireIfDue = () => {
    if (fired || shellReady === null || allowed !== true) return;
    fired = true;
    window.patton.pty.write(ptyId, cmd + '\r');
    rlog('info', `[STARTUP] ${label} sent`, { via: shellReady });
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
  timer = setTimeout(() => ready('fallback'), PROMPT_FALLBACK_MS);
  go.then(
    (ok) => {
      allowed = ok;
      if (!ok) {
        disposePrompt?.();
        rlog('info', `[STARTUP] ${label} not sent`, { reason: 'project board shown' });
      }
      fireIfDue();
    },
    () => { allowed = true; fireIfDue(); },
  );
  return {
    cancel: () => {
      fired = true;
      disposePrompt?.();
      if (timer) clearTimeout(timer);
    },
  };
}

/**
 * Whether terminal data is the user's input. The terminal also answers the
 * shell's queries (cursor position, device attributes, colours) through the
 * same data event; those are escape sequences, whereas typed and dictated
 * text is plain and a bracketed paste opens with ESC [ 200 ~.
 */
export function isUserInput(data: string): boolean {
  return !data.startsWith('\x1b') || data.startsWith('\x1b[200~');
}

/**
 * Type `cmd` into a tab's shell as soon as the shell is really ready, for a
 * click that comes at any time after the tab was created (the project board's
 * Claude button). The shell's progress is recorded by its pane from the moment
 * its PTY exists (Pane.shellProgress), so:
 *  - a shell that already showed its first prompt gets the command at once;
 *  - one still loading gets it at its first prompt (OSC 133 D, not the early
 *    A that zsh sends from .zshenv);
 *  - a shell that sends no OSC 133 at all gets it PROMPT_FALLBACK_MS after its
 *    PTY was created, one that sends marks but never a first prompt
 *    SLOW_SHELL_MS after (both logged as fallbacks).
 * Input typed in the pane while it waits would end up glued onto the command,
 * so the first key, paste, dictation or IME text cancels the send instead
 * (`opts.onTyped` tells the caller); the terminal's own replies to the shell's
 * queries do not. A pane closed meanwhile drops the send. `opts.onDone` runs
 * once when the send is over, however it ended.
 * Returns null when nothing was armed (no PTY), else a handle that cancels.
 */
export function typeWhenShellReady(
  tab: Tab,
  cmd: string,
  opts: { label: string; onTyped?: () => void; onDone?: () => void },
): PendingSend | null {
  const ptyId = tab.ptyId;
  if (!cmd || ptyId === null) return null;
  const pane = tab.focusedPane;
  const log = (what: string, extra: Record<string, unknown> = {}) =>
    rlog('info', `[STARTUP] ${opts.label} ${what}`, { tabId: tab.id, ptyId, ...extra });

  let done = false;
  let finished = false;
  const disposers: (() => void)[] = [];
  const timers: ReturnType<typeof setTimeout>[] = [];
  const finish = () => {
    done = true;
    if (finished) return;
    finished = true;
    for (const d of disposers) d();
    for (const t of timers) clearTimeout(t);
    opts.onDone?.();
  };
  const send = (via: string) => {
    if (done) return;
    finish();
    window.patton.pty.write(ptyId, cmd + '\r');
    log('sent', { via, sinceShellStartMs: Math.round(performance.now() - pane.shellProgress.startedAt) });
  };

  if (pane.shellProgress.sawFirstPrompt) {
    send('prompt already shown');
    return { cancel: finish };
  }
  disposers.push(pane.terminalView.onPromptState((state) => {
    if (state === 'idle') send('first prompt');
  }));
  const typed = () => {
    if (done) return;
    finish();
    log('not sent', { reason: 'input typed while waiting for the shell' });
    opts.onTyped?.();
  };
  const keys = pane.terminalView.terminal.onKey(typed);
  disposers.push(() => keys.dispose());
  // Paste, dictation and IME text reach the PTY as terminal data, not as keys.
  const input = pane.terminalView.onTerminalData((data) => {
    if (isUserInput(data)) typed();
  });
  if (input) disposers.push(input);
  disposers.push(pane.onDispose(() => {
    if (done) return;
    finish();
    log('not sent', { reason: 'pane closed while waiting for the shell' });
  }));
  const startedAt = pane.shellProgress.startedAt;
  timers.push(
    setTimeout(() => {
      if (!pane.shellProgress.sawSignal) send('fallback: no shell integration');
    }, Math.max(0, startedAt + PROMPT_FALLBACK_MS - performance.now())),
    setTimeout(() => send('fallback: slow shell'), Math.max(0, startedAt + SLOW_SHELL_MS - performance.now())),
  );
  return { cancel: finish };
}
