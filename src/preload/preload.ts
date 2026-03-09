import { contextBridge, ipcRenderer } from 'electron';
import { IPC } from '../shared/constants';
import type { PattonAPI } from '../shared/types';

const api: PattonAPI = {
  pty: {
    create: (opts) => ipcRenderer.invoke(IPC.PTY_CREATE, opts),
    write: (id, data) => ipcRenderer.send(IPC.PTY_WRITE, id, data),
    resize: (id, cols, rows) => ipcRenderer.send(IPC.PTY_RESIZE, id, cols, rows),
    destroy: (id) => ipcRenderer.send(IPC.PTY_DESTROY, id),
    getProcess: (id) => ipcRenderer.invoke(IPC.PTY_GET_PROCESS, id),
    getDescendants: (id) => ipcRenderer.invoke(IPC.PTY_GET_DESCENDANTS, id),
    getCwd: (id) => ipcRenderer.invoke(IPC.PTY_GET_CWD, id),
    onData: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, id: number, data: string) => callback(id, data);
      ipcRenderer.on(IPC.PTY_DATA, listener);
      return () => ipcRenderer.removeListener(IPC.PTY_DATA, listener);
    },
    onExit: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, id: number, code: number) => callback(id, code);
      ipcRenderer.on(IPC.PTY_EXIT, listener);
      return () => ipcRenderer.removeListener(IPC.PTY_EXIT, listener);
    },
    onTitle: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, id: number, title: string) => callback(id, title);
      ipcRenderer.on(IPC.PTY_TITLE, listener);
      return () => ipcRenderer.removeListener(IPC.PTY_TITLE, listener);
    },
  },
  history: {
    get: () => ipcRenderer.invoke(IPC.HISTORY_GET),
    add: (command) => ipcRenderer.invoke(IPC.HISTORY_ADD, command),
    clear: () => ipcRenderer.invoke(IPC.HISTORY_CLEAR),
  },
  settings: {
    get: () => ipcRenderer.invoke(IPC.SETTINGS_GET),
    set: (settings) => ipcRenderer.invoke(IPC.SETTINGS_SET, settings),
  },
  session: {
    get: () => ipcRenderer.invoke(IPC.SESSION_GET),
    set: (session) => ipcRenderer.invoke(IPC.SESSION_SET, session),
  },
  editor: {
    openFile: (filePath) => ipcRenderer.invoke(IPC.APP_OPEN_IN_EDITOR, filePath),
  },
  terminal: {
    saveOutput: (content, defaultName) => ipcRenderer.invoke(IPC.APP_SAVE_TERMINAL, content, defaultName),
  },
  app: {
    onSettings: (cb) => {
      const listener = () => cb();
      ipcRenderer.on(IPC.APP_SETTINGS, listener);
      return () => ipcRenderer.removeListener(IPC.APP_SETTINGS, listener);
    },
    onNewTab: (cb) => {
      const listener = () => cb();
      ipcRenderer.on(IPC.APP_NEW_TAB, listener);
      return () => ipcRenderer.removeListener(IPC.APP_NEW_TAB, listener);
    },
    onCloseTab: (cb) => {
      const listener = () => cb();
      ipcRenderer.on(IPC.APP_CLOSE_TAB, listener);
      return () => ipcRenderer.removeListener(IPC.APP_CLOSE_TAB, listener);
    },
    onNextTab: (cb) => {
      const listener = () => cb();
      ipcRenderer.on(IPC.APP_NEXT_TAB, listener);
      return () => ipcRenderer.removeListener(IPC.APP_NEXT_TAB, listener);
    },
    onPrevTab: (cb) => {
      const listener = () => cb();
      ipcRenderer.on(IPC.APP_PREV_TAB, listener);
      return () => ipcRenderer.removeListener(IPC.APP_PREV_TAB, listener);
    },
    onSwitchTab: (cb) => {
      const listener = (_event: Electron.IpcRendererEvent, index: number) => cb(index);
      ipcRenderer.on(IPC.APP_SWITCH_TAB, listener);
      return () => ipcRenderer.removeListener(IPC.APP_SWITCH_TAB, listener);
    },
    onClear: (cb) => {
      const listener = () => cb();
      ipcRenderer.on(IPC.APP_CLEAR, listener);
      return () => ipcRenderer.removeListener(IPC.APP_CLEAR, listener);
    },
    onSearch: (cb) => {
      const listener = () => cb();
      ipcRenderer.on(IPC.APP_SEARCH, listener);
      return () => ipcRenderer.removeListener(IPC.APP_SEARCH, listener);
    },
    onFontSizeUp: (cb) => {
      const listener = () => cb();
      ipcRenderer.on(IPC.APP_FONT_SIZE_UP, listener);
      return () => ipcRenderer.removeListener(IPC.APP_FONT_SIZE_UP, listener);
    },
    onFontSizeDown: (cb) => {
      const listener = () => cb();
      ipcRenderer.on(IPC.APP_FONT_SIZE_DOWN, listener);
      return () => ipcRenderer.removeListener(IPC.APP_FONT_SIZE_DOWN, listener);
    },
    onSplitVertical: (cb) => {
      const listener = () => cb();
      ipcRenderer.on(IPC.APP_SPLIT_VERTICAL, listener);
      return () => ipcRenderer.removeListener(IPC.APP_SPLIT_VERTICAL, listener);
    },
    onSplitHorizontal: (cb) => {
      const listener = () => cb();
      ipcRenderer.on(IPC.APP_SPLIT_HORIZONTAL, listener);
      return () => ipcRenderer.removeListener(IPC.APP_SPLIT_HORIZONTAL, listener);
    },
    onFocusPaneUp: (cb) => {
      const listener = () => cb();
      ipcRenderer.on(IPC.APP_FOCUS_PANE_UP, listener);
      return () => ipcRenderer.removeListener(IPC.APP_FOCUS_PANE_UP, listener);
    },
    onFocusPaneDown: (cb) => {
      const listener = () => cb();
      ipcRenderer.on(IPC.APP_FOCUS_PANE_DOWN, listener);
      return () => ipcRenderer.removeListener(IPC.APP_FOCUS_PANE_DOWN, listener);
    },
    onFocusPaneLeft: (cb) => {
      const listener = () => cb();
      ipcRenderer.on(IPC.APP_FOCUS_PANE_LEFT, listener);
      return () => ipcRenderer.removeListener(IPC.APP_FOCUS_PANE_LEFT, listener);
    },
    onFocusPaneRight: (cb) => {
      const listener = () => cb();
      ipcRenderer.on(IPC.APP_FOCUS_PANE_RIGHT, listener);
      return () => ipcRenderer.removeListener(IPC.APP_FOCUS_PANE_RIGHT, listener);
    },
    onSaveTerminal: (cb) => {
      const listener = () => cb();
      ipcRenderer.on(IPC.APP_SAVE_TERMINAL_MENU, listener);
      return () => ipcRenderer.removeListener(IPC.APP_SAVE_TERMINAL_MENU, listener);
    },
    onBroadcastInput: (cb) => {
      const listener = () => cb();
      ipcRenderer.on(IPC.APP_BROADCAST_INPUT, listener);
      return () => ipcRenderer.removeListener(IPC.APP_BROADCAST_INPUT, listener);
    },
    onSwitchTabById: (cb) => {
      const listener = (_event: Electron.IpcRendererEvent, id: string) => cb(id);
      ipcRenderer.on(IPC.APP_SWITCH_TAB_BY_ID, listener);
      return () => ipcRenderer.removeListener(IPC.APP_SWITCH_TAB_BY_ID, listener);
    },
    onSplitZoom: (cb) => {
      const listener = () => cb();
      ipcRenderer.on(IPC.APP_SPLIT_ZOOM, listener);
      return () => ipcRenderer.removeListener(IPC.APP_SPLIT_ZOOM, listener);
    },
    onUndoClose: (cb) => {
      const listener = () => cb();
      ipcRenderer.on(IPC.APP_UNDO_CLOSE, listener);
      return () => ipcRenderer.removeListener(IPC.APP_UNDO_CLOSE, listener);
    },
    onCommandPalette: (cb) => {
      const listener = () => cb();
      ipcRenderer.on(IPC.APP_COMMAND_PALETTE, listener);
      return () => ipcRenderer.removeListener(IPC.APP_COMMAND_PALETTE, listener);
    },
    onPromptJumpUp: (cb) => {
      const listener = () => cb();
      ipcRenderer.on(IPC.APP_PROMPT_JUMP_UP, listener);
      return () => ipcRenderer.removeListener(IPC.APP_PROMPT_JUMP_UP, listener);
    },
    onPromptJumpDown: (cb) => {
      const listener = () => cb();
      ipcRenderer.on(IPC.APP_PROMPT_JUMP_DOWN, listener);
      return () => ipcRenderer.removeListener(IPC.APP_PROMPT_JUMP_DOWN, listener);
    },
    onQuickTerminal: (cb) => {
      const listener = () => cb();
      ipcRenderer.on(IPC.APP_QUICK_TERMINAL, listener);
      return () => ipcRenderer.removeListener(IPC.APP_QUICK_TERMINAL, listener);
    },
  },
  notify: (title, body, tabId) => ipcRenderer.send(IPC.APP_NOTIFY, title, body, tabId),
  setOpacity: (opacity) => ipcRenderer.send(IPC.APP_SET_OPACITY, opacity),
  openExternal: (url) => ipcRenderer.invoke(IPC.APP_OPEN_EXTERNAL, url),
};

contextBridge.exposeInMainWorld('patton', api);
