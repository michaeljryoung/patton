import type { Pane } from '../components/pane';
import type { Tab } from '../components/tab';
import { DEFAULTS } from '../../shared/constants';
import type { AppSettings } from '../../shared/types';

/**
 * The project board's Wake button: the command it types into a new tab
 * (Settings → "Wake button command"; '' hides the button), and the pane that
 * shows the command is already running (its title is exactly WAKE).
 */

/** The title a pane carries while the `wake` command keeps the Mac awake
 *  (exactly this, the whole title): the tab gets a yellow flag (pane.ts), and
 *  the board's Wake button reads "Awake". */
export const WAKE_TITLE = 'WAKE';

/** The configured command. Absent in settings saved before it existed (and
 *  when settings can't be read): the default. Empty: no button. */
export function wakeCommandOf(settings: Partial<Pick<AppSettings, 'boardWakeCommand'>> | null | undefined): string {
  const value = settings?.boardWakeCommand;
  return typeof value === 'string' ? value.trim() : DEFAULTS.BOARD_WAKE_COMMAND;
}

/** The first pane in the window titled exactly WAKE, with its tab, or null. */
export function findWakePane(tabs: readonly Tab[]): { tab: Tab; pane: Pane } | null {
  for (const tab of tabs) {
    for (const pane of tab.panes) {
      if (pane.title === WAKE_TITLE) return { tab, pane };
    }
  }
  return null;
}
