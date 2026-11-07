/**
 * Install / remove Patton's Claude Code Stop hook (resources/claude-code-stop-hook.sh).
 *
 * The hook tells Patton whether a Claude Code turn that just ended is parked on
 * its own background work or really waiting on the user (see pane.ts
 * handleHookStop). Installing copies the script into Patton's userData folder,
 * so its path survives app updates, and adds one Stop entry to
 * ~/.claude/settings.json. Nothing here imports Electron: the caller passes
 * the paths, which keeps it testable outside the app.
 *
 * Threat notes: this edits a file that controls what Claude Code runs. It only
 * ever runs on an explicit click in Settings; it refuses to touch a
 * settings.json it can't parse; it writes a timestamped backup first (newest
 * five kept, with the file's own mode, since settings.json can hold `env`
 * secrets); it replaces files by rename, keeping settings.json's mode; and the
 * only command it adds is the single-quoted absolute path of a script Patton
 * itself wrote (mode 0755, in the user's own userData folder).
 */
import {
  chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync,
  renameSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { ClaudeHookStatus } from '../shared/types';

export interface ClaudeHookPaths {
  /** The script bundled with this Patton build. */
  bundledScript: string;
  /** Where the installed copy lives (userData/hooks/claude-code-stop-hook.sh). */
  installedScript: string;
  /** ~/.claude/settings.json */
  settingsFile: string;
}

interface HookCommand { type?: unknown; command?: unknown; [key: string]: unknown }
interface MatcherGroup { matcher?: unknown; hooks?: unknown; [key: string]: unknown }

/** Single-quote a string for a POSIX shell: nothing inside expands. */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** The command Claude Code runs through a shell (`sh -c`); userData contains a
 *  space ("Application Support"), so the path is quoted — single quotes, so a
 *  `$` or backtick in it can't expand. */
export function hookCommand(paths: ClaudeHookPaths): string {
  return shellQuote(paths.installedScript);
}

/** Ours in any form Patton has written: the current single-quoted one, the
 *  earlier double-quoted one, or the bare path. */
function isOurCommand(cmd: unknown, paths: ClaudeHookPaths): boolean {
  return typeof cmd === 'string' && (
    cmd === hookCommand(paths) || cmd === `"${paths.installedScript}"` || cmd === paths.installedScript
  );
}

const BACKUP_KEEP = 5;

/** Keep only the newest BACKUP_KEEP of Patton's own backups of `target`
 *  (`<name>.patton-bak-<ISO time>`, which sorts by time as plain text). */
function pruneBackups(target: string): void {
  const prefix = `${basename(target)}.patton-bak-`;
  const backups = readdirSync(dirname(target)).filter((n) => n.startsWith(prefix)).sort();
  for (const name of backups.slice(0, Math.max(0, backups.length - BACKUP_KEEP))) {
    try {
      unlinkSync(join(dirname(target), name));
      console.info('[HOOK] Pruned old settings backup', { backup: name });
    } catch (err) {
      console.warn('[HOOK] Could not prune settings backup', { backup: name, error: (err as Error).message });
    }
  }
}

/** Replace `target` atomically: write a sibling temp file with `mode`, then
 *  rename it over. A reader (Claude Code, or bash mid-way through the hook
 *  script) sees the old file or the new one, never a half-written one. */
function replaceFile(target: string, data: string | Buffer, mode: number): void {
  const tmp = join(dirname(target), `.${basename(target)}.patton-tmp-${process.pid}`);
  try {
    writeFileSync(tmp, data, { mode });
    chmodSync(tmp, mode); // the umask may have narrowed it
    renameSync(tmp, target);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* already gone */ }
    throw err;
  }
}

/** Install this build's script at the installed path (0755), by rename. */
function copyScript(paths: ClaudeHookPaths): void {
  mkdirSync(dirname(paths.installedScript), { recursive: true });
  replaceFile(paths.installedScript, readFileSync(paths.bundledScript), 0o755);
}

/** Read and parse settings.json. A missing file is `{}`; anything that isn't a
 *  JSON object throws, so callers change nothing. */
function readSettings(file: string): Record<string, unknown> {
  if (!existsSync(file)) return {};
  const raw = readFileSync(file, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${file} is not valid JSON (${(err as Error).message}); left unchanged`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${file} is not a JSON object; left unchanged`);
  }
  return parsed as Record<string, unknown>;
}

function stopGroups(settings: Record<string, unknown>): MatcherGroup[] | null {
  const hooks = settings.hooks;
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) return null;
  const stop = (hooks as Record<string, unknown>).Stop;
  return Array.isArray(stop) ? (stop as MatcherGroup[]) : null;
}

function hasOurEntry(settings: Record<string, unknown>, paths: ClaudeHookPaths): boolean {
  for (const group of stopGroups(settings) ?? []) {
    if (!group || !Array.isArray(group.hooks)) continue;
    if ((group.hooks as HookCommand[]).some((h) => h && isOurCommand(h.command, paths))) return true;
  }
  return false;
}

/** Back up, then replace atomically. A symlinked settings.json is written
 *  through to its target, so the link survives. */
function writeSettings(file: string, settings: Record<string, unknown>): void {
  const target = existsSync(file) ? realpathSync(file) : file;
  mkdirSync(dirname(target), { recursive: true });
  // Keep the file's mode (it can hold `env` secrets); a new file is 0600.
  let mode = 0o600;
  if (existsSync(target)) {
    mode = statSync(target).mode & 0o777;
    const backup = `${target}.patton-bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    copyFileSync(target, backup);
    chmodSync(backup, mode);
    console.info('[HOOK] Backed up settings', { backup });
    pruneBackups(target);
  }
  replaceFile(target, JSON.stringify(settings, null, 2) + '\n', mode);
  console.info('[HOOK] Wrote settings', { file: target, mode: mode.toString(8) });
}

/** Keep an installed copy in step with this build's script, so a Patton
 *  update that changes the hook reaches Claude Code without a reinstall. Runs
 *  at app startup (ipc-handlers.ts) and whenever Settings asks for the status.
 *  Never installs: without an installed copy it does nothing. */
export function refreshInstalledScript(paths: ClaudeHookPaths): void {
  if (!existsSync(paths.installedScript) || !existsSync(paths.bundledScript)) return;
  try {
    if (readFileSync(paths.bundledScript, 'utf8') !== readFileSync(paths.installedScript, 'utf8')) {
      copyScript(paths);
      console.info('[HOOK] Refreshed installed script from this build', { script: paths.installedScript });
    }
  } catch (err) {
    console.warn('[HOOK] Could not refresh installed script', { error: (err as Error).message });
  }
}

/** `refresh`: bring an installed script up to this build's copy. Only a
 *  packaged build may (`app.isPackaged`): a dev run shares the userData folder
 *  with the installed app and would overwrite its hook with the working tree's. */
export function getHookStatus(paths: ClaudeHookPaths, refresh: boolean): ClaudeHookStatus {
  const scriptPresent = existsSync(paths.installedScript);
  let entryPresent = false;
  let error: string | undefined;
  try {
    entryPresent = hasOurEntry(readSettings(paths.settingsFile), paths);
  } catch (err) {
    error = (err as Error).message;
  }
  if (scriptPresent && refresh) refreshInstalledScript(paths);
  return {
    installed: scriptPresent && entryPresent,
    scriptPresent,
    entryPresent,
    scriptPath: paths.installedScript,
    ...(error ? { error } : {}),
  };
}

export function installHook(paths: ClaudeHookPaths): ClaudeHookStatus {
  console.info('[HOOK] Install requested', { settings: paths.settingsFile });
  // Parse first: a broken settings.json aborts before anything is written.
  const settings = readSettings(paths.settingsFile);

  if (!existsSync(paths.bundledScript)) {
    throw new Error(`Bundled hook script not found at ${paths.bundledScript}`);
  }
  copyScript(paths);
  console.info('[HOOK] Copied script', { script: paths.installedScript });

  if (hasOurEntry(settings, paths)) {
    console.info('[HOOK] Stop entry already present; settings left unchanged');
  } else {
    if (!settings.hooks || typeof settings.hooks !== 'object' || Array.isArray(settings.hooks)) {
      if (settings.hooks !== undefined) {
        throw new Error('settings.json has a "hooks" value that is not an object; left unchanged');
      }
      settings.hooks = {};
    }
    const hooks = settings.hooks as Record<string, unknown>;
    if (hooks.Stop === undefined) hooks.Stop = [];
    if (!Array.isArray(hooks.Stop)) {
      throw new Error('settings.json has a "hooks.Stop" value that is not an array; left unchanged');
    }
    (hooks.Stop as MatcherGroup[]).push({
      matcher: '',
      hooks: [{ type: 'command', command: hookCommand(paths), timeout: 10 }],
    });
    writeSettings(paths.settingsFile, settings);
    console.info('[HOOK] Added Stop entry', { command: hookCommand(paths) });
  }
  return getHookStatus(paths, false);
}

/** Remove only Patton's own command. A matcher group left with no hooks is
 *  dropped; the Stop array itself is left alone even if it ends up empty. The
 *  installed script stays (harmless, and an Install puts the entry back). */
export function removeHook(paths: ClaudeHookPaths): ClaudeHookStatus {
  console.info('[HOOK] Remove requested', { settings: paths.settingsFile });
  const settings = readSettings(paths.settingsFile);
  const groups = stopGroups(settings);
  if (!groups || !hasOurEntry(settings, paths)) {
    console.info('[HOOK] No Patton Stop entry; settings left unchanged');
    return getHookStatus(paths, false);
  }
  const kept: MatcherGroup[] = [];
  for (const group of groups) {
    if (!group || !Array.isArray(group.hooks)) {
      kept.push(group);
      continue;
    }
    const remaining = (group.hooks as HookCommand[]).filter((h) => !(h && isOurCommand(h.command, paths)));
    if (remaining.length === group.hooks.length) kept.push(group);
    else if (remaining.length > 0) kept.push({ ...group, hooks: remaining });
  }
  (settings.hooks as Record<string, unknown>).Stop = kept;
  writeSettings(paths.settingsFile, settings);
  console.info('[HOOK] Removed Stop entry');
  return getHookStatus(paths, false);
}
