// In-app confirmations for ⌘Q / Dock Quit / the red close button (S46, v1.19).
//
// Until now these two paths asked with a native macOS box (dialog.showMessageBoxSync),
// which has no ⌘W: Michael wanted "Command-W should also work on the final
// screen where it says 'Are you sure you want to quit anyway?'". Main now asks
// the window's renderer to show the same in-app dialog the last-tab ⌘W uses
// (Enter, ⌘W or a second ⌘Q confirm; Esc/Cancel cancel) and acts on its answer.
// This supersedes the S45 decision "⌘Q and the red button keep the native guard".
//
// Protocol (channel names in shared/constants.ts):
//   main → renderer  WINDOW_CONFIRM_REQUEST  { requestId, kind, terminals }
//   renderer → main  WINDOW_CONFIRM_ACK      (requestId)  "the dialog is on screen"
//   renderer → main  WINDOW_CONFIRM_ANSWER   (requestId, ok)
//   main → renderer  WINDOW_CONFIRM_DISMISS  { requestId }  "close it, I have the answer"
//
// Safety: no ack within the timeout (the existing 1.5 s close-IPC timeout), a
// window that is hidden/minimized/destroyed/crashed, or a window that goes away
// while the dialog is up all resolve 'unavailable', and the caller falls back
// to the native box. Nothing here ever confirms on its own: 'confirmed' comes
// only from the renderer's answer, or from a second ⌘Q after the ack.
// One request per window at a time; a second request for the same window is
// 'busy', so dialogs never stack. No runtime Electron import, so the check
// scripts can drive it with fakes.
//
// Review fixes (S46):
// - A settled request is RETIRED: its id stays known for a while so a late ack
//   is refused and the renderer is told again to take its dialog down, and a
//   late answer is ignored. A renderer that withdraws its own dialog answers
//   false, so main never stays "acked" for a dialog that is gone.
// - A second ⌘Q / Dock Quit confirms only a dialog that has been up for
//   CONFIRM_SHORTCUT_DWELL_MS in a window that can still show it, and never
//   from key repeat (isCloseKeyRepeat: window-manager swallows repeated ⌘Q/⌘W).
// - Before asking, the window is shown and focused and Patton comes to the
//   front (the `raise` hook; quit-guard.ts installs the Electron one), so Dock
//   Quit from the background shows the dialog it is about to wait on.

import { randomUUID } from 'node:crypto';
import type { BrowserWindow } from 'electron';
import { CONFIRM_SHORTCUT_DWELL_MS, IPC } from '../shared/constants';

/** 'quit': ends every window's shells and quits Patton. 'close-window': ends one window's shells. */
export type ConfirmKind = 'quit' | 'close-window';

/** What the caller should do: act on 'confirmed', stop on 'cancelled'/'busy',
 *  fall back to the native box on 'unavailable'. */
export type ConfirmResult = 'confirmed' | 'cancelled' | 'unavailable' | 'busy';

/** What a second ⌘Q found: it confirmed the open dialog, found one still
 *  waiting for its ack (ignored, never stacked), or found none. */
export type QuitShortcutResult = 'confirmed' | 'waiting' | 'none';

/** How long the renderer has to show the dialog (its close-IPC timeout, tab-manager.ts closeIpcTimeoutMs). */
export const CONFIRM_ACK_TIMEOUT_MS = 1500;

/** How many settled request ids are remembered for refusing late acks and answers. */
const RETIRED_KEEP = 32;

/** A keyboard event as Electron's 'before-input-event' reports it (the fields used). */
export interface CloseKeyInput {
  type: string;
  key: string;
  isAutoRepeat?: boolean;
  meta?: boolean;
}

/**
 * True for an auto-repeated ⌘Q or ⌘W. window-manager.ts prevents those
 * (before-input-event also stops the menu accelerator), so a held key can never
 * confirm a quit/close dialog, however long the dialog has been up.
 */
export function isCloseKeyRepeat(input: CloseKeyInput): boolean {
  if (input.type !== 'keyDown' || input.isAutoRepeat !== true || input.meta !== true) return false;
  const key = String(input.key).toLowerCase();
  return key === 'q' || key === 'w';
}

export interface ConfirmRequestPayload {
  requestId: string;
  kind: ConfirmKind;
  terminals: number;
}

interface Pending {
  requestId: string;
  win: BrowserWindow;
  windowId: number;
  kind: ConfirmKind;
  acked: boolean;
  /** Clock reading when the ack arrived (the dialog went on screen). */
  ackedAt: number;
  settle: (result: ConfirmResult, tellRenderer: boolean) => void;
}

export interface CloseConfirmationsOptions {
  ackTimeoutMs?: number;
  /** Can this window show an in-app dialog right now? Default: alive, visible, not minimized. */
  isUsable?: (win: BrowserWindow) => boolean;
  newId?: () => string;
  /** Monotonic milliseconds. Default: performance.now. */
  now?: () => number;
  /** How long a dialog must have been up before a second ⌘Q confirms it. */
  dwellMs?: number;
  /** Bring `win` (already usable) and the app to the front before asking. Default: win.show() + win.focus(). */
  raise?: (win: BrowserWindow) => void;
}

function defaultRaise(win: BrowserWindow): void {
  win.show();
  win.focus();
}

function defaultIsUsable(win: BrowserWindow): boolean {
  try {
    return !win.isDestroyed() && !win.webContents.isDestroyed() && win.isVisible() && !win.isMinimized();
  } catch {
    return false;
  }
}

export class CloseConfirmations {
  private readonly pending = new Map<string, Pending>();
  private readonly ackTimeoutMs: number;
  private readonly isUsable: (win: BrowserWindow) => boolean;
  private readonly newId: () => string;
  private readonly now: () => number;
  private readonly dwellMs: number;
  private raise: (win: BrowserWindow) => void;
  /** Settled requests: id → the window that held the dialog (to tell it again). Oldest first. */
  private readonly retired = new Map<string, BrowserWindow>();

  constructor(opts: CloseConfirmationsOptions = {}) {
    this.ackTimeoutMs = opts.ackTimeoutMs ?? CONFIRM_ACK_TIMEOUT_MS;
    this.isUsable = opts.isUsable ?? defaultIsUsable;
    this.newId = opts.newId ?? randomUUID;
    this.now = opts.now ?? (() => performance.now());
    this.dwellMs = opts.dwellMs ?? CONFIRM_SHORTCUT_DWELL_MS;
    this.raise = opts.raise ?? defaultRaise;
  }

  /** Replace the raise hook (quit-guard.ts adds the app-level focus Electron needs). */
  setRaiser(raise: (win: BrowserWindow) => void): void {
    this.raise = raise;
  }

  /** Can `win` show the dialog now? (Synchronous, so a caller can pick the native box without waiting.) */
  canAsk(win: BrowserWindow): boolean {
    return this.isUsable(win);
  }

  hasPendingFor(windowId: number): boolean {
    for (const p of this.pending.values()) if (p.windowId === windowId) return true;
    return false;
  }

  hasPendingQuit(): boolean {
    for (const p of this.pending.values()) if (p.kind === 'quit') return true;
    return false;
  }

  /** Ask `win`'s renderer. Resolves when it is settled; never rejects. */
  ask(win: BrowserWindow, kind: ConfirmKind, terminals: number): Promise<ConfirmResult> {
    let windowId: number;
    try {
      windowId = win.id;
    } catch {
      return Promise.resolve('unavailable');
    }
    if (this.hasPendingFor(windowId)) {
      console.info('[CLOSE] in-app confirmation already open for this window', { windowId, kind });
      return Promise.resolve('busy');
    }
    if (!this.isUsable(win)) {
      console.info('[CLOSE] window cannot show the in-app confirmation', { windowId, kind });
      return Promise.resolve('unavailable');
    }
    return new Promise<ConfirmResult>((resolve) => {
      const requestId = this.newId();
      const onLost = () => settle('unavailable', false);
      const settle = (result: ConfirmResult, tellRenderer: boolean) => {
        if (!this.pending.delete(requestId)) return;
        this.retire(requestId, win);
        clearTimeout(timer);
        try {
          win.removeListener('closed', onLost);
          win.webContents.removeListener('render-process-gone', onLost);
        } catch { /* the window is already gone */ }
        if (tellRenderer) {
          try {
            win.webContents.send(IPC.WINDOW_CONFIRM_DISMISS, { requestId });
          } catch { /* destroyed: nothing to dismiss */ }
        }
        console.info('[CLOSE] in-app confirmation settled', { windowId, kind, requestId, result });
        resolve(result);
      };
      this.pending.set(requestId, { requestId, win, windowId, kind, acked: false, ackedAt: 0, settle });
      const timer = setTimeout(() => {
        const p = this.pending.get(requestId);
        if (p && !p.acked) {
          console.warn('[CLOSE] renderer did not show the in-app confirmation in time', { windowId, kind, ms: this.ackTimeoutMs });
          settle('unavailable', true);
        }
      }, this.ackTimeoutMs);
      try {
        this.raise(win);
      } catch (err) {
        console.warn('[CLOSE] could not bring the window to the front', { windowId, err: String(err) });
      }
      try {
        win.once('closed', onLost);
        win.webContents.once('render-process-gone', onLost);
        const payload: ConfirmRequestPayload = { requestId, kind, terminals };
        win.webContents.send(IPC.WINDOW_CONFIRM_REQUEST, payload);
      } catch (err) {
        console.warn('[CLOSE] could not send the in-app confirmation', { windowId, err: String(err) });
        settle('unavailable', false);
        return;
      }
      console.info('[CLOSE] in-app confirmation requested', { windowId, kind, terminals, requestId });
    });
  }

  private retire(requestId: string, win: BrowserWindow): void {
    this.retired.set(requestId, win);
    while (this.retired.size > RETIRED_KEEP) {
      const oldest = this.retired.keys().next().value;
      if (oldest === undefined) break;
      this.retired.delete(oldest);
    }
  }

  /** The renderer says its dialog is up. False for an unknown, late or foreign request (it must then close the dialog). */
  ack(senderWindowId: number, requestId: string): boolean {
    const p = this.pending.get(requestId);
    if (!p || p.windowId !== senderWindowId) {
      const gone = this.retired.get(requestId);
      if (gone) {
        // The request was settled (the 1.5 s fallback went native, or it was
        // answered): this dialog must not stay up. Tell its window again.
        console.warn('[CLOSE] late ack for a settled confirmation ignored; renderer told to withdraw', { requestId });
        try {
          gone.webContents.send(IPC.WINDOW_CONFIRM_DISMISS, { requestId });
        } catch { /* destroyed: nothing to dismiss */ }
      }
      return false;
    }
    p.acked = true;
    p.ackedAt = this.now();
    console.info('[CLOSE] in-app confirmation shown', { windowId: p.windowId, kind: p.kind, requestId });
    return true;
  }

  /** The user's answer. Only the request's own window can give it. */
  answer(senderWindowId: number, requestId: string, ok: boolean): boolean {
    const p = this.pending.get(requestId);
    if (!p || p.windowId !== senderWindowId) {
      if (this.retired.has(requestId)) console.info('[CLOSE] late answer for a settled confirmation ignored', { requestId, ok });
      return false;
    }
    p.settle(ok ? 'confirmed' : 'cancelled', false);
    return true;
  }

  /**
   * A second ⌘Q (or Dock/menu Quit) while a quit dialog is open confirms it:
   * the user saw the dialog and asked again. It is ignored ('waiting') before
   * the ack (the dialog is not on screen yet), for the first dwellMs after it
   * (a double-tap is not a decision) and while the window cannot show it
   * (hidden or minimized: nobody can have seen it).
   */
  quitShortcut(): QuitShortcutResult {
    for (const p of this.pending.values()) {
      if (p.kind !== 'quit') continue;
      if (!p.acked || this.now() - p.ackedAt < this.dwellMs || !this.isUsable(p.win)) return 'waiting';
      p.settle('confirmed', true);
      return 'confirmed';
    }
    return 'none';
  }

  /** A quit supersedes any open "Close this window?" dialog: cancel those and take their dialogs down. */
  cancelWindowRequests(): number {
    let n = 0;
    for (const p of [...this.pending.values()]) {
      if (p.kind !== 'close-window') continue;
      p.settle('cancelled', true);
      n++;
    }
    return n;
  }
}

/** The one instance main's quit guard, the window close guard and the IPC handlers share. */
export const closeConfirmations = new CloseConfirmations();
