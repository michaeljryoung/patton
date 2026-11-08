// The ⌘Q / Dock Quit / app-menu Quit guard (main.ts 'before-quit').
//
// Today's incident (why it exists): three active Claude Code sessions were
// lost to a clean app.quit() with no confirmation step. It asks first whenever
// any PTY is alive; cleanup runs only after the user confirms (or when no PTYs
// exist).
//
// v1.19 (S46): the question is asked IN THE APP, in the focused (else first
// showing) window, with the same dialog the last-tab ⌘W uses, so Enter, ⌘W or
// a second ⌘Q confirm and Esc cancels (close-confirm.ts has the protocol). This
// supersedes the S45 decision "⌘Q and the red button keep the native guard":
// the native box (no ⌘W) stays only as the fallback when no window can show
// the dialog or the renderer does not answer in time.

import { app, BrowserWindow, dialog } from 'electron';
import { closeConfirmations } from './close-confirm';

let quitConfirmed = false;

/** True once the user confirmed this quit (in the app or in the native box):
 *  every window's close handler then lets its window go without asking again. */
export function isQuitConfirmed(): boolean {
  return quitConfirmed;
}

/** The native fallback box. True = Quit Anyway. */
function nativeQuitBox(terminals: number): boolean {
  const parent = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
  const options: Electron.MessageBoxSyncOptions = {
    type: 'warning',
    buttons: ['Cancel', 'Quit Anyway'],
    defaultId: 0,
    cancelId: 0,
    title: 'Quit Patton',
    message: `${terminals} terminal${terminals === 1 ? '' : 's'} still running`,
    detail:
      'Quitting will end every terminal session and kill any long-running processes inside them ' +
      '(Claude Code conversations, dev servers, watchers, remote shells). Transcripts on disk are ' +
      'preserved, but in-memory session state is not.\n\n' +
      'To keep a session alive, cancel and exit it gracefully from inside its tab first.',
  };
  const result = parent ? dialog.showMessageBoxSync(parent, options) : dialog.showMessageBoxSync(options);
  return result !== 0;
}

/** The window that asks: the focused one if it can show the dialog, else the first that can. */
function pickWindow(): BrowserWindow | null {
  const focused = BrowserWindow.getFocusedWindow();
  if (focused && closeConfirmations.canAsk(focused)) return focused;
  return BrowserWindow.getAllWindows().find((w) => closeConfirmations.canAsk(w)) ?? null;
}

/** Quit confirmed: from here every guard stands down, and the quit goes on. */
function confirmQuit(how: string, terminals: number): void {
  console.info('[CLOSE] quit confirmed', { how, terminals });
  quitConfirmed = true;
  app.quit();
}

/**
 * Call from 'before-quit'. Returns true when the quit may go on (main then
 * does its cleanup); false when it was prevented here (a dialog is, or was,
 * the answer; a confirmed quit calls app.quit() again and comes back as true).
 */
export function guardBeforeQuit(event: { preventDefault: () => void }, ptys: { readonly size: number }): boolean {
  if (quitConfirmed) return true;
  const terminals = ptys.size;
  if (terminals <= 0) return true;

  // A second ⌘Q while the dialog is open confirms it; while it is still on its
  // way (not acked) it is ignored, so dialogs never stack.
  const again = closeConfirmations.quitShortcut();
  if (again !== 'none') {
    event.preventDefault();
    console.info(again === 'confirmed' ? '[CLOSE] quit requested again: confirming the open dialog' : '[CLOSE] quit requested again: dialog not shown yet, ignored', { terminals });
    return false;
  }

  // A quit supersedes a "Close this window?" dialog that is open.
  const superseded = closeConfirmations.cancelWindowRequests();
  if (superseded > 0) console.info('[CLOSE] quit superseded open close-window dialogs', { superseded });

  const target = pickWindow();
  if (!target) {
    console.info('[CLOSE] quit: no window can show the in-app dialog; native box', { terminals });
    if (nativeQuitBox(terminals)) {
      console.info('[CLOSE] quit confirmed', { how: 'native', terminals });
      quitConfirmed = true;
      return true;
    }
    console.info('[CLOSE] quit cancelled', { how: 'native', terminals });
    event.preventDefault();
    return false;
  }

  event.preventDefault();
  console.info('[CLOSE] quit: asking in the app', { windowId: target.id, terminals });
  void closeConfirmations.ask(target, 'quit', terminals).then((result) => {
    if (result === 'confirmed') {
      confirmQuit('in-app', terminals);
    } else if (result === 'unavailable') {
      // Count again: a crashed renderer's shells are ended by the window's
      // crash handler before this runs, and the box must not state a stale number.
      const now = ptys.size;
      if (now <= 0) {
        confirmQuit('no-shells-left', 0);
        return;
      }
      console.info('[CLOSE] quit: in-app dialog unavailable; native box', { terminals: now });
      if (nativeQuitBox(now)) confirmQuit('native-fallback', now);
      else console.info('[CLOSE] quit cancelled', { how: 'native-fallback', terminals: now });
    } else {
      console.info('[CLOSE] quit not confirmed', { result, terminals });
    }
  });
  return false;
}
