import { app, Menu, BrowserWindow } from 'electron';
import { IPC } from '../shared/constants';
import { createWindow } from './window-manager';
import type { PtyManager } from './pty-manager';

export function buildMenu(ptyManager?: PtyManager): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        {
          label: 'Preferences...',
          accelerator: 'CmdOrCtrl+,',
          click: (_item, window) => {
            // Handled in renderer via keydown listener
            (window as BrowserWindow | undefined)?.webContents.send(IPC.APP_SETTINGS);
          },
        },
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
      label: 'Shell',
      submenu: [
        {
          label: 'New Tab',
          accelerator: 'CmdOrCtrl+T',
          click: (_item, window) => {
            (window as BrowserWindow | undefined)?.webContents.send(IPC.APP_NEW_TAB);
          },
        },
        {
          label: 'Close Tab',
          accelerator: 'CmdOrCtrl+W',
          click: (_item, window) => {
            (window as BrowserWindow | undefined)?.webContents.send(IPC.APP_CLOSE_TAB);
          },
        },
        { type: 'separator' },
        {
          label: 'Split Pane Right',
          accelerator: 'CmdOrCtrl+D',
          click: (_item, window) => {
            (window as BrowserWindow | undefined)?.webContents.send(IPC.APP_SPLIT_VERTICAL);
          },
        },
        {
          label: 'Split Pane Down',
          accelerator: 'CmdOrCtrl+Shift+D',
          click: (_item, window) => {
            (window as BrowserWindow | undefined)?.webContents.send(IPC.APP_SPLIT_HORIZONTAL);
          },
        },
        { type: 'separator' },
        {
          label: 'New Window',
          accelerator: 'CmdOrCtrl+N',
          click: () => {
            createWindow(ptyManager);
          },
        },
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
        {
          label: 'Find',
          accelerator: 'CmdOrCtrl+F',
          click: (_item, window) => {
            (window as BrowserWindow | undefined)?.webContents.send(IPC.APP_SEARCH);
          },
        },
        { type: 'separator' },
        {
          label: 'Clear Terminal',
          accelerator: 'CmdOrCtrl+K',
          click: (_item, window) => {
            (window as BrowserWindow | undefined)?.webContents.send(IPC.APP_CLEAR);
          },
        },
        { type: 'separator' },
        {
          label: 'Increase Font Size',
          accelerator: 'CmdOrCtrl+=',
          click: (_item, window) => {
            (window as BrowserWindow | undefined)?.webContents.send(IPC.APP_FONT_SIZE_UP);
          },
        },
        {
          label: 'Decrease Font Size',
          accelerator: 'CmdOrCtrl+-',
          click: (_item, window) => {
            (window as BrowserWindow | undefined)?.webContents.send(IPC.APP_FONT_SIZE_DOWN);
          },
        },
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
        {
          label: 'Select Next Tab',
          accelerator: 'CmdOrCtrl+Shift+]',
          click: (_item, window) => {
            (window as BrowserWindow | undefined)?.webContents.send(IPC.APP_NEXT_TAB);
          },
        },
        {
          label: 'Select Previous Tab',
          accelerator: 'CmdOrCtrl+Shift+[',
          click: (_item, window) => {
            (window as BrowserWindow | undefined)?.webContents.send(IPC.APP_PREV_TAB);
          },
        },
        { type: 'separator' },
        ...Array.from({ length: 9 }, (_, i) => ({
          label: `Tab ${i + 1}`,
          accelerator: `CmdOrCtrl+${i + 1}`,
          click: (_item: Electron.MenuItem, window: Electron.BaseWindow | undefined) => {
            (window as BrowserWindow | undefined)?.webContents.send(IPC.APP_SWITCH_TAB, i);
          },
        })),
        { type: 'separator' },
        { role: 'front' as const },
      ],
    },
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}
