import type { ITheme } from '@xterm/xterm';

export interface PattonTheme {
  name: string;
  id: string;
  terminal: ITheme;
  ui: {
    bgPrimary: string;
    bgSecondary: string;
    bgTertiary: string;
    bgInput: string;
    textPrimary: string;
    textSecondary: string;
    textMuted: string;
    border: string;
    borderLight: string;
    accent: string;
    accentLight: string;
    hover: string;
    hoverStrong: string;
    scrollbar: string;
    scrollbarHover: string;
    shadow: string;
    submitFlash: string;
    accentText: string;
  };
}

const DRACULA: PattonTheme = {
  name: 'Dracula',
  id: 'dracula',
  terminal: {
    background: '#282a36',
    foreground: '#f8f8f2',
    cursor: '#f8f8f2',
    cursorAccent: '#282a36',
    selectionBackground: '#44475a',
    selectionForeground: '#f8f8f2',
    black: '#21222c',
    red: '#ff5555',
    green: '#50fa7b',
    yellow: '#f1fa8c',
    blue: '#bd93f9',
    magenta: '#ff79c6',
    cyan: '#8be9fd',
    white: '#f8f8f2',
    brightBlack: '#6272a4',
    brightRed: '#ff6e6e',
    brightGreen: '#69ff94',
    brightYellow: '#ffffa5',
    brightBlue: '#d6acff',
    brightMagenta: '#ff92df',
    brightCyan: '#a4ffff',
    brightWhite: '#ffffff',
  },
  ui: {
    bgPrimary: '#282a36',
    bgSecondary: '#21222c',
    bgTertiary: '#252630',
    bgInput: '#44475a',
    textPrimary: '#f8f8f2',
    textSecondary: '#bd93f9',
    textMuted: '#6272a4',
    border: '#44475a',
    borderLight: '#383a4a',
    accent: '#bd93f9',
    accentLight: '#44475a',
    hover: '#353746',
    hoverStrong: '#44475a',
    scrollbar: '#6272a4',
    scrollbarHover: '#bd93f9',
    shadow: 'rgba(0, 0, 0, 0.4)',
    submitFlash: '#2a2e40',
    accentText: '#bd93f9',
  },
};

const NORD: PattonTheme = {
  name: 'Nord',
  id: 'nord',
  terminal: {
    background: '#2e3440',
    foreground: '#d8dee9',
    cursor: '#d8dee9',
    cursorAccent: '#2e3440',
    selectionBackground: '#434c5e',
    selectionForeground: '#d8dee9',
    black: '#3b4252',
    red: '#bf616a',
    green: '#a3be8c',
    yellow: '#ebcb8b',
    blue: '#81a1c1',
    magenta: '#b48ead',
    cyan: '#88c0d0',
    white: '#e5e9f0',
    brightBlack: '#4c566a',
    brightRed: '#bf616a',
    brightGreen: '#a3be8c',
    brightYellow: '#ebcb8b',
    brightBlue: '#81a1c1',
    brightMagenta: '#b48ead',
    brightCyan: '#8fbcbb',
    brightWhite: '#eceff4',
  },
  ui: {
    bgPrimary: '#2e3440',
    bgSecondary: '#272c36',
    bgTertiary: '#2b303b',
    bgInput: '#3b4252',
    textPrimary: '#d8dee9',
    textSecondary: '#81a1c1',
    textMuted: '#4c566a',
    border: '#3b4252',
    borderLight: '#353b48',
    accent: '#88c0d0',
    accentLight: '#434c5e',
    hover: '#3b4252',
    hoverStrong: '#434c5e',
    scrollbar: '#4c566a',
    scrollbarHover: '#81a1c1',
    shadow: 'rgba(0, 0, 0, 0.35)',
    submitFlash: '#2e3848',
    accentText: '#88c0d0',
  },
};

const SOLARIZED_DARK: PattonTheme = {
  name: 'Solarized Dark',
  id: 'solarized-dark',
  terminal: {
    background: '#002b36',
    foreground: '#839496',
    cursor: '#839496',
    cursorAccent: '#002b36',
    selectionBackground: '#073642',
    selectionForeground: '#93a1a1',
    black: '#073642',
    red: '#dc322f',
    green: '#859900',
    yellow: '#b58900',
    blue: '#268bd2',
    magenta: '#d33682',
    cyan: '#2aa198',
    white: '#eee8d5',
    brightBlack: '#586e75',
    brightRed: '#cb4b16',
    brightGreen: '#586e75',
    brightYellow: '#657b83',
    brightBlue: '#839496',
    brightMagenta: '#6c71c4',
    brightCyan: '#93a1a1',
    brightWhite: '#fdf6e3',
  },
  ui: {
    bgPrimary: '#002b36',
    bgSecondary: '#00212b',
    bgTertiary: '#002630',
    bgInput: '#073642',
    textPrimary: '#839496',
    textSecondary: '#268bd2',
    textMuted: '#586e75',
    border: '#073642',
    borderLight: '#054050',
    accent: '#268bd2',
    accentLight: '#073642',
    hover: '#073642',
    hoverStrong: '#0a4a5a',
    scrollbar: '#586e75',
    scrollbarHover: '#268bd2',
    shadow: 'rgba(0, 0, 0, 0.4)',
    submitFlash: '#003440',
    accentText: '#268bd2',
  },
};

const ONE_DARK: PattonTheme = {
  name: 'One Dark',
  id: 'one-dark',
  terminal: {
    background: '#282c34',
    foreground: '#abb2bf',
    cursor: '#528bff',
    cursorAccent: '#282c34',
    selectionBackground: '#3e4451',
    selectionForeground: '#abb2bf',
    black: '#282c34',
    red: '#e06c75',
    green: '#98c379',
    yellow: '#e5c07b',
    blue: '#61afef',
    magenta: '#c678dd',
    cyan: '#56b6c2',
    white: '#abb2bf',
    brightBlack: '#5c6370',
    brightRed: '#e06c75',
    brightGreen: '#98c379',
    brightYellow: '#e5c07b',
    brightBlue: '#61afef',
    brightMagenta: '#c678dd',
    brightCyan: '#56b6c2',
    brightWhite: '#ffffff',
  },
  ui: {
    bgPrimary: '#282c34',
    bgSecondary: '#21252b',
    bgTertiary: '#24282f',
    bgInput: '#3e4451',
    textPrimary: '#abb2bf',
    textSecondary: '#61afef',
    textMuted: '#5c6370',
    border: '#3e4451',
    borderLight: '#353b45',
    accent: '#61afef',
    accentLight: '#3e4451',
    hover: '#2c313c',
    hoverStrong: '#3e4451',
    scrollbar: '#5c6370',
    scrollbarHover: '#61afef',
    shadow: 'rgba(0, 0, 0, 0.4)',
    submitFlash: '#2a3040',
    accentText: '#61afef',
  },
};

const MONOKAI: PattonTheme = {
  name: 'Monokai',
  id: 'monokai',
  terminal: {
    background: '#272822',
    foreground: '#f8f8f2',
    cursor: '#f8f8f2',
    cursorAccent: '#272822',
    selectionBackground: '#49483e',
    selectionForeground: '#f8f8f2',
    black: '#272822',
    red: '#f92672',
    green: '#a6e22e',
    yellow: '#f4bf75',
    blue: '#66d9ef',
    magenta: '#ae81ff',
    cyan: '#a1efe4',
    white: '#f8f8f2',
    brightBlack: '#75715e',
    brightRed: '#f92672',
    brightGreen: '#a6e22e',
    brightYellow: '#f4bf75',
    brightBlue: '#66d9ef',
    brightMagenta: '#ae81ff',
    brightCyan: '#a1efe4',
    brightWhite: '#f9f8f5',
  },
  ui: {
    bgPrimary: '#272822',
    bgSecondary: '#1e1f1a',
    bgTertiary: '#22231e',
    bgInput: '#49483e',
    textPrimary: '#f8f8f2',
    textSecondary: '#66d9ef',
    textMuted: '#75715e',
    border: '#49483e',
    borderLight: '#3e3d32',
    accent: '#a6e22e',
    accentLight: '#49483e',
    hover: '#3e3d32',
    hoverStrong: '#49483e',
    scrollbar: '#75715e',
    scrollbarHover: '#a6e22e',
    shadow: 'rgba(0, 0, 0, 0.4)',
    submitFlash: '#2e3028',
    accentText: '#a6e22e',
  },
};

const TOKYO_NIGHT: PattonTheme = {
  name: 'Tokyo Night',
  id: 'tokyo-night',
  terminal: {
    background: '#1a1b26',
    foreground: '#a9b1d6',
    cursor: '#c0caf5',
    cursorAccent: '#1a1b26',
    selectionBackground: '#33467c',
    selectionForeground: '#c0caf5',
    black: '#15161e',
    red: '#f7768e',
    green: '#9ece6a',
    yellow: '#e0af68',
    blue: '#7aa2f7',
    magenta: '#bb9af7',
    cyan: '#7dcfff',
    white: '#a9b1d6',
    brightBlack: '#414868',
    brightRed: '#f7768e',
    brightGreen: '#9ece6a',
    brightYellow: '#e0af68',
    brightBlue: '#7aa2f7',
    brightMagenta: '#bb9af7',
    brightCyan: '#7dcfff',
    brightWhite: '#c0caf5',
  },
  ui: {
    bgPrimary: '#1a1b26',
    bgSecondary: '#13141e',
    bgTertiary: '#161722',
    bgInput: '#292e42',
    textPrimary: '#a9b1d6',
    textSecondary: '#7aa2f7',
    textMuted: '#414868',
    border: '#292e42',
    borderLight: '#232538',
    accent: '#7aa2f7',
    accentLight: '#292e42',
    hover: '#24283b',
    hoverStrong: '#292e42',
    scrollbar: '#414868',
    scrollbarHover: '#7aa2f7',
    shadow: 'rgba(0, 0, 0, 0.45)',
    submitFlash: '#1c2038',
    accentText: '#7aa2f7',
  },
};

export const THEMES: PattonTheme[] = [
  DRACULA,
  NORD,
  SOLARIZED_DARK,
  ONE_DARK,
  MONOKAI,
  TOKYO_NIGHT,
];

export function getThemeById(id: string): PattonTheme | undefined {
  return THEMES.find(t => t.id === id);
}

/** Apply a theme's UI colors as CSS custom properties on :root */
export function applyThemeToCSS(theme: PattonTheme): void {
  const root = document.documentElement;
  const ui = theme.ui;
  root.style.setProperty('--bg-primary', ui.bgPrimary);
  root.style.setProperty('--bg-secondary', ui.bgSecondary);
  root.style.setProperty('--bg-tertiary', ui.bgTertiary);
  root.style.setProperty('--bg-input', ui.bgInput);
  root.style.setProperty('--text-primary', ui.textPrimary);
  root.style.setProperty('--text-secondary', ui.textSecondary);
  root.style.setProperty('--text-muted', ui.textMuted);
  root.style.setProperty('--border', ui.border);
  root.style.setProperty('--border-light', ui.borderLight);
  root.style.setProperty('--accent', ui.accent);
  root.style.setProperty('--accent-light', ui.accentLight);
  root.style.setProperty('--hover', ui.hover);
  root.style.setProperty('--hover-strong', ui.hoverStrong);
  root.style.setProperty('--scrollbar', ui.scrollbar);
  root.style.setProperty('--scrollbar-hover', ui.scrollbarHover);
  root.style.setProperty('--shadow', ui.shadow);
  root.style.setProperty('--submit-flash', ui.submitFlash);
  root.style.setProperty('--accent-text', ui.accentText);
}

/** Remove all inline CSS custom properties to revert to stylesheet defaults */
export function clearThemeCSS(): void {
  const root = document.documentElement;
  const props = [
    '--bg-primary', '--bg-secondary', '--bg-tertiary', '--bg-input',
    '--text-primary', '--text-secondary', '--text-muted',
    '--border', '--border-light', '--accent', '--accent-light',
    '--hover', '--hover-strong', '--scrollbar', '--scrollbar-hover',
    '--shadow', '--submit-flash', '--accent-text',
  ];
  for (const prop of props) {
    root.style.removeProperty(prop);
  }
}
