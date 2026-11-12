// What a double-click on the tab strip's empty space does, from the Mac's
// "Double-click a window's title bar to" setting (AppleActionOnDoubleClick:
// "Maximize" = Zoom, "Minimize", "None"; some systems also report "Fill").
// Pure: no Electron import, so scripts/check-title-bar-action.mjs can run it.

export type TitleBarAction = 'zoom' | 'minimize' | 'none';

export function titleBarActionFor(pref: string | undefined | null, platform: string): TitleBarAction {
  if (platform !== 'darwin') return 'zoom';
  if (pref === 'Minimize') return 'minimize';
  if (pref === 'None') return 'none';
  // 'Maximize', 'Fill', missing, empty or unknown: zoom, the system default.
  return 'zoom';
}
