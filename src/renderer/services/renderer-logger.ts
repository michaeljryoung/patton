// Forward renderer console calls to the main process so they land in main.log.
//
// The file logger in `src/main/logger.ts` only tees the main-process console.
// Renderer-side `console.info('[RENDER] ...')` calls go to DevTools only, so
// any signal we emit from terminal-view.ts (atlas flushes, WebGL context loss,
// resume-triggered flushes) is invisible to the health script and to anyone
// inspecting `~/Library/Application Support/Patton/logs/main.log` after the
// fact. This bridge fixes that — `rlog()` always logs to DevTools (so a dev
// tools session sees output as before) and additionally posts an IPC message
// the main side teases into the log file with a `[RENDERER]` prefix.

type Level = 'info' | 'warn' | 'error';

export function rlog(level: Level, ...args: unknown[]): void {
  // Local DevTools console — unchanged for live debugging.
  if (level === 'info') console.info(...args);
  else if (level === 'warn') console.warn(...args);
  else console.error(...args);

  // Forward to main. Wrapped in try/catch because `window.patton.log` may not
  // exist in test contexts (no preload bridge) and we don't want a missing
  // bridge to break the actual console output above.
  try {
    window.patton?.log?.send(level, args);
  } catch {
    // ignore — best-effort bridge, never throw from a logger.
  }
}
