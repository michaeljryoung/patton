import { app, Menu, BrowserWindow } from 'electron';
import { IPC } from '../shared/constants';
import { shortcut } from '../shared/shortcuts';
import { createWindow } from './window-manager';
import type { PtyManager } from './pty-manager';

/**
 * Build a menu item from the shortcuts registry. Only the menu's *structure*
 * (which submenu, what order, where the separators go) lives here — the label
 * and accelerator come from `shared/shortcuts.ts`, so the menu can't drift from
 * the command palette or the Settings grid.
 */
function menuItem(
  id: string,
  click: Electron.MenuItemConstructorOptions['click'],
): Electron.MenuItemConstructorOptions {
  const s = shortcut(id);
  if (s.rendererOnly) {
    // A menu accelerator is consumed by the main process before the renderer's
    // keydown listener ever runs, so registering one here would break the binding.
    throw new Error(`Shortcut "${id}" is rendererOnly and must not become a menu item`);
  }
  return { label: s.menuLabel ?? s.label, accelerator: s.accelerator, click };
}

/** Menu item that forwards to the focused window's renderer over IPC. */
function sendItem(id: string, channel: string): Electron.MenuItemConstructorOptions {
  return menuItem(id, (_item, window) => {
    (window as BrowserWindow | undefined)?.webContents.send(channel);
  });
}

export function buildMenu(ptyManager?: PtyManager): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        // Handled in the renderer via its settings listener
        sendItem('settings', IPC.APP_SETTINGS),
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'File',
      submenu: [
        sendItem('save-terminal', IPC.APP_SAVE_TERMINAL_MENU),
      ],
    },
    {
      label: 'Shell',
      submenu: [
        sendItem('new-tab', IPC.APP_NEW_TAB),
        sendItem('close-pane', IPC.APP_CLOSE_TAB),
        { type: 'separator' },
        sendItem('split-vertical', IPC.APP_SPLIT_VERTICAL),
        sendItem('split-horizontal', IPC.APP_SPLIT_HORIZONTAL),
        sendItem('zoom-split', IPC.APP_SPLIT_ZOOM),
        { type: 'separator' },
        sendItem('broadcast', IPC.APP_BROADCAST_INPUT),
        { type: 'separator' },
        sendItem('toggle-notes', IPC.APP_TOGGLE_NOTES),
        menuItem('new-window', () => {
          createWindow(ptyManager);
        }),
        sendItem('undo-close', IPC.APP_UNDO_CLOSE),
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        sendItem('search', IPC.APP_SEARCH),
        { type: 'separator' },
        sendItem('clear', IPC.APP_CLEAR),
        { type: 'separator' },
        sendItem('font-up', IPC.APP_FONT_SIZE_UP),
        sendItem('font-down', IPC.APP_FONT_SIZE_DOWN),
        { type: 'separator' },
        sendItem('prompt-up', IPC.APP_PROMPT_JUMP_UP),
        sendItem('prompt-down', IPC.APP_PROMPT_JUMP_DOWN),
        { type: 'separator' },
        sendItem('command-palette', IPC.APP_COMMAND_PALETTE),
        // No accelerator — reached via the configurable global hotkey (main.ts)
        sendItem('quick-terminal', IPC.APP_QUICK_TERMINAL),
        { type: 'separator' },
        ...(!app.isPackaged ? [
          { role: 'reload' as const },
          { role: 'toggleDevTools' as const },
        ] : []),
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { type: 'separator' },
        sendItem('next-tab', IPC.APP_NEXT_TAB),
        sendItem('prev-tab', IPC.APP_PREV_TAB),
        { type: 'separator' },
        // Nine generated items; the registry lists them as the single
        // `switch-tab` entry (⌘1–9) for display purposes.
        ...Array.from({ length: 9 }, (_, i) => ({
          label: `${shortcut('switch-tab').menuLabel} ${i + 1}`,
          accelerator: `CmdOrCtrl+${i + 1}`,
          click: (_item: Electron.MenuItem, window: Electron.BaseWindow | undefined) => {
            (window as BrowserWindow | undefined)?.webContents.send(IPC.APP_SWITCH_TAB, i);
          },
        })),
        { type: 'separator' },
        {
          label: 'Float on Top',
          type: 'checkbox',
          checked: false,
          click: (item, window) => {
            const win = window as BrowserWindow | undefined;
            if (win) {
              win.setAlwaysOnTop(item.checked);
            }
          },
        },
        { type: 'separator' },
        { role: 'front' as const },
      ],
    },
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}
