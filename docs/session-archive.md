# Patton — Session Log Archive

Older Session Log entries moved here to keep the primary CLAUDE.md under the 40k-character load-time threshold. Most recent sessions live in CLAUDE.md.

---

## 2026-04-18 (session 20) — Renderer-crash hardening pass

- Shipped renderer-crash hardening (Tier 1 + Tier 2 from the harden-patton-renderer-crashes plan): WebGL `onContextLoss` → DOM fallback, `render-process-gone` auto-reload, `unresponsive`/`responsive` breadcrumbs, `child-process-gone` logging for GPU/utility deaths, local-only `crashReporter` for post-mortem dumps.
- Ran a 10-agent epistemic review (`/reasoning`) plus UI/UX audit pass. Full report at `analysis/reasoning-modes/REPORT.md` (gitignored). 5 Kernel (HIGH-confidence) findings, 11 Supported, 10 Hypotheses, 2 Disputed.
- Worked through the **entire** resulting punch list in one session. Commit `34ce53e` covers 28 files, 683 insertions — grouped below.
- Crash resilience: crash counter (3-in-30s → static error page), `destroyByWindow()` before reload, session-clear after 2nd crash, `uncaughtException`/`unhandledRejection` handlers, WebGL 10s re-acquire retry + `refresh()` on fallback, synchronous PTY buffer flush in `destroy()`, graduated write-coalesce backoff (4/16/32ms tiers, 1MB hard cap).
- Security: store encryption replaced with random 32-byte key protected by `safeStorage` (Keychain) + legacy-key migration; modal confirmation on `startupCommand` change; `OnlyLoadAppFromAsar: true`; shell-setting allowlist alignment; `readonly` guard on `PATTON_SHELL_INTEGRATION_SCRIPT` in wrapper `.zshenv`; 100ms OSC 10/11 debounce; history control-char stripping; session-tree leaf cap; notification length caps + tabId validation; expanded env allowlist (CONDA, KUBECONFIG, ANDROID, DOTNET, AWS, GCLOUD, VIRTUAL_ENV, etc.).
- Command-done coordination: per-pane `fireCommandDone(source)` with 5s cross-source debounce; OSC 133 suppresses idle heuristic for 60s after any fire. Kills triple-notification.
- Session persistence: 30s periodic autosave (covers `beforeunload` teardown race); startup command waits for OSC 133;B prompt signal (1.5s fallback) instead of blind 500ms timer.
- Accessibility: `<html lang="en">`, global `prefers-reduced-motion`, reusable `services/focus-trap.ts` applied to 5 modals, quick-terminal ARIA + `aria-hidden` toggle, command-palette `id`+`aria-activedescendant`+combobox roles, tab-bar Arrow/Home/End roving-tabindex nav, global `services/announcer.ts` (aria-live) wired to tab ops / broadcast / settings / paste. Theme tokens `--broadcast`, `--prompt-ready`, `--prompt-ready-glow` replace hardcoded hex. Distinct "No command history yet" vs "No matches" empty states.
- Dead-code cleanup: removed `PTY_GET_DESCENDANTS` IPC chain (5 files, always returned `[]`).

## 2026-04-15 (session 19) — Light-theme contrast fix

- Fixed persistent light-theme text readability — CLI tool text (Claude Code, etc.) was unreadable on light backgrounds despite COLORFGBG and OSC 10/11 fixes from prior sessions.
- Root cause: xterm.js `minimumContrastRatio` was unset (defaults to 1 = disabled). VS Code uses the same ANSI palette but sets this to 4.5, which auto-corrects low-contrast colors. Patton copied the colors without the safety net.
- Fix 1: Added `minimumContrastRatio: 4.5` to Terminal constructor — xterm.js now auto-adjusts any foreground color below 4.5:1 contrast against the background.
- Fix 2: Replaced 6 ANSI colors in LIGHT_THEME that had terrible inherent contrast (e.g. `brightWhite` was 2.4:1, `brightGreen` was 2.0:1 — WCAG AA requires 4.5:1).
- Previous sessions: OSC 10/11 responses (18), tab rename fix (17), COLORFGBG env var (16).

## Session Log entries archived S27 trim (2026-05-07)

### 2026-04-20 (session 23) — input-path audit (no code changes)

- Diagnostic triggered by Enter appearing unresponsive at Claude Code's `/mcp` "Press Enter after authenticating" step. User confirmed Enter works in Claude Code's main prompt in the same session (messages sent to Claude), so any regression would be Enter-path-specific, not a blanket keystroke issue.
- Audited every Enter handler in the renderer. **`pane.ts:164-174`** (`attachCustomKeyEventHandler`) intercepts **only Shift+Enter** to emit the kitty `\x1b[13;2u` sequence — plain Enter returns `true` so xterm.js handles it natively (sends `\r` to the PTY). **`editor-input.ts:55-73`** captures Enter for compose-panel submit, but only when the textarea holds focus. All other Enter handlers (`context-menu.ts:46`, `paste-dialog.ts:45`, `history-search.ts:115`, `onboarding.ts:53`, `command-palette.ts:79`, `search-overlay.ts:69-72`, `tab-bar.ts:283`) are focus/open-gated on their respective modal. Conclusion: no Patton code path selectively swallows plain Enter in a Claude Code subscreen.
- Checked xterm.js v6.0.0 for kitty keyboard progressive-enhancement support — no `registerCsiHandler` for CSI-u and no DECSET 2017 registration in the codebase (grep confirmed). Patton never ACKs kitty mode, so Enter always resolves to `\r` regardless of what the TUI app requests. Rules out the hypothesis that Claude Code's `/mcp` expected `\x1b[13u`.
- Flow auto-completed via server-side OAuth poll before user could run a discriminating Ctrl+C / letter-key test, so the original repro is lost. Left unresolved — most likely Claude Code's auth-poll loop isn't reading stdin during the poll window; watching brief only.
- Investigation notes at `~/.claude/plans/enchanted-sauteeing-moonbeam.md`. No code changes this session; CLAUDE.md update only. [no-release] candidate.

### 2026-04-18 (session 22)

- **Rewired tab "awaiting input" dot through three signal paths** — old OSC 133 `'prompt'` subscription fired on every prompt redraw (startup, session restore, SIGWINCH, `clear`, Starship refresh), so the dot never actually appeared for meaningful events. Fix routes SET through (A) `onCommandDone` callback (session-20's `fireCommandDone()` coordinator), (B) title-prefix regex `/^[·•]/` on `onTitleChange`, (C) new OSC 9 handler → `fireCommandDone('osc9')`. All three converge on `raiseAwaitingInput()`. CLEAR paths unchanged.
- **Visual polish**: 8 → 10 px dot, dual box-shadow (2 px + 8 px), 1.8 s opacity pulse. Global `prefers-reduced-motion` zeroes the animation.
- **Confirm-before-quit dialog** for the class of event that lost three live Claude Code sessions (genome, lindus-therapeutics, new-house). Two hooks: `before-quit` (⌘Q) + `window.on('close')` (⌘W-to-last-window) because `before-quit` fires after PTY teardown. Uses `dialog.showMessageBoxSync` (async would race app teardown). Scope-expanded mid-plan to cover the close-last-window path.
- 3 commits (`f600248` + `39ed72a` + `d54ceb8`), ~135 LOC / 7 files. Patch release via CI. Verified strings in asar + Path A live-tested.

### 2026-04-18 (session 21)

- **Tab "awaiting input" indicator** shipped (iTerm-style green dot on inactive tabs at OSC 133 prompt-ready). Reuses `--prompt-ready` tokens for visual consistency. Plumbing: `tab.ts` state + subscription → `tab-manager.ts` → `tab-bar.ts` dot element. (Reworked in S22 — signal was wrong; this session wired the wrong SET path.)
- **File logger** (`src/main/logger.ts`, ~90 LOC): tees `console.*` to `~/Library/Application Support/Patton/logs/main.log` with 5 MB rotation. Eagerly creates file + startup line on install. Fixes the session-20 observability blind spot (Dock-launched Electron stderr goes to `/dev/null`).
- **Health script** (`scripts/patton-health.sh`, `npm run health`): one-shot diagnostic — counts crash dumps, greps session-20 error markers, verifies `config.json` + `key.enc`, `--hours=N` window works across log rotations.

## Decisions archived S27 trim (2026-05-07)

Pre-S24 Decisions (S20–S23 vintage). Kept verbatim — they remain context for any future change in the same area.

- **2026-04-20 — Enter unresponsive at Claude Code `/mcp` "Press Enter" is not a Patton code-path issue.** Verified by read-only audit of every Enter handler in the renderer. Only Shift+Enter is intercepted (`pane.ts:166-174`); compose-panel Enter is focus-gated; xterm.js v6 registers no kitty/CSI-u handler that could mutate Enter based on mode. Main-prompt Enter works in the same Claude Code session, so keystrokes ARE reaching the PTY. Repro lost before a Ctrl+C / letter-key discriminator could run — no fix proposed; watching brief only. If it recurs with any key (not just Enter), that reclassifies it as a Patton focus/keystroke-delivery bug and we add a dev-toggleable keystroke tracer to `terminal-view.ts`.
- **Dot fires on meaningful signals, not "shell at prompt"** — OSC 133 `'prompt'` fires on every prompt redraw (startup / SIGWINCH / `clear` / Starship refresh / session restore). Using it as a SET signal meant tabs running non-OSC-133 tools (Claude Code, npm, docker) never lit, and every plain-shell tab lit whenever the shell redrew. Rewired to set on command-done transitions (Path A), Claude Code's OSC 2 title prefix (Path B), and OSC 9 terminal notification escape (Path C). Three independent paths converge on a single `raiseAwaitingInput()` guard. CLEAR on tab activation + new command start, same as before.
- **Two quit-confirmation surfaces (before-quit + window close)** — Electron's `before-quit` fires after `window-all-closed`, by which point the existing `window.on('close')` handler has already destroyed PTYs via `destroyByWindow`. A single `before-quit` guard would therefore bypass the ⌘W-to-last-window path entirely. Rather than reorder PTY cleanup into a more complex state machine, I added a second dialog in `window-manager.ts` gated on `isLastWindow && ptyManager.size > 0`. Two surfaces share one UX; the second catches what the first can't see.
- **`dialog.showMessageBoxSync` deliberate** — `before-quit` doesn't await promises, and an async dialog would race app teardown. Sync blocks the main process until the user chooses, which is the required semantic.
- **Confirm for ANY live PTY, not just "busy" ones** — the main process doesn't know pane-level OSC 133 state; plumbing that through IPC just to silence the dialog for idle shells isn't worth the complexity. False-positive annoyance < silent data loss.
- **Consolidate the two close handlers instead of layering** — Electron fires all registered 'close' handlers even if one calls `e.preventDefault()`, so stacking a guard handler on top of the destroy-PTYs handler would kill PTYs before the user answered. Merged the guard into the existing close handler so the teardown only runs if the guard passes.
- **Accept visual redundancy of our dot + Claude Code's "·" title** — they don't visually collide (dot is tab chrome, "·" is inside title text). Suppressing ours when title begins with "·" would be a fragile contract with Claude Code's conventions.
- **File logger eagerly creates the log file on install, not lazily on first write** — first attempt only opened the stream on the first `console.*` call. On a fully clean session (no warns, no errors) nothing ever called `console.*`, so the file never materialized. Made the health script indistinguishable between "logger not installed" and "session ran clean." Writing a "Patton main process started" line on install guarantees the file exists after every launch.
- **Tab indicator shares prompt-ready theme tokens instead of its own color** — considered a distinct accent (blue, cyan) but picked `--prompt-ready` because the editor's prompt-ready glow uses the same signal. One visual language for "shell is ready for input" across surfaces; one token to tweak if the hue is ever wrong.
- **Dot suppressed on the active tab, not just styled differently** — active tab is where the user's attention already is, so a dot would be noise. Cleared on `show()` even if the pane re-enters `'prompt'` a moment later; `handlePaneStateChange` guards on `!this._isActive` so it can't be set while active.
- **safeStorage-backed random 32-byte key over deterministic SHA-256** — previous SHA-256(homedir:username) was reconstructable by any same-user process; new key lives in `userData/key.enc` encrypted via OS keychain. Legacy-key migration on first launch; fallback to legacy if `safeStorage` unavailable (Linux without GNOME keyring).
- **CommandDoneCoordinator (coordinate, don't eliminate)** — OSC 133;D authoritative when shell integration is on, idle heuristic covers non-OSC-133 children (Claude Code, npm, docker compose), bell is explicit. Per-pane coordinator debounces 5s across all three; OSC 133 suppresses idle 60s after fire.
- **Crash circuit breaker 3-in-30s → static error page** — below: transient GPU blip recovers silently. Above: deterministic cause loops forever. Session clear after 2nd crash breaks restore-triggered loops before hard cap.
- **Periodic 30s autosave over change-triggered** — single call-site vs 5+ wire points. Trades lsof roundtrip for coverage certainty.
- **Startup command waits for OSC 133;B, not a fixed timer** — slow shells exceed the old 500ms; readiness-based listener + 1.5s fallback for shells without integration.
- **Shell allowlist single-sourced (`ALLOWED_SHELLS` exported from `pty-manager.ts`)** — previous permissive regex in `store.ts` + strict set in pty-manager let users save a shell that silently fell back at spawn. Always consolidate security allowlists.
- **Crashpad `uploadToServer: false`** — local dumps only. Post-mortem diagnosis without any network channel.
- **ZDOTDIR for zsh / `--rcfile` for bash shell integration** — VS Code's pattern: custom init script restores user's startup files then sources integration. Avoids PTY write echo.
- **Kitty keyboard protocol for Shift+Enter** — sends `\x1b[13;2u` so apps can handle Shift+Enter as "newline without submit". Chosen over backslash-continuation (shell-only) and compose-panel-open (too disruptive).
- **COLORFGBG from renderer + OSC 10/11 responses** — env var for startup detection, escape-sequence response for runtime detection. CLI apps need both to pick readable colors.
- **minimumContrastRatio: 4.5** — xterm auto-adjusts fg colors below this contrast against bg. Same approach as VS Code. Palette fix alone is insufficient for 256-color / true-color values from CLI apps; ratio is the safety net.

## Gotchas archived S27 trim (2026-05-07)

Older Gotchas, preserved for context. The recurring / load-bearing ones (and S25/S27 family) stay in CLAUDE.md.

- `createWriteStream(..., { flags: 'a' })` does NOT create the file on construction; it creates on first write. A file-based logger that lazy-opens will never create the file on completely clean sessions where nothing logs. Eagerly write a "started" line on install.
- `window.reload()` does NOT destroy main-process PTYs. Without an explicit `ptyManager.destroyByWindow(window)` before reload, each crash-recovery reload leaks PTYs — they keep running in main, sending PTY_DATA for ids the new renderer doesn't recognize, eventually hitting `MAX_PTY_PER_WINDOW`.
- `beforeunload` is fire-and-forget and does NOT fire on renderer crash. A periodic autosave (30s) is the only way to keep persisted state close to reality for crash recovery.
- wrapper `.zshenv` in ZDOTDIR mode sources user's `.zshenv` AFTER ours runs but BEFORE Patton's integration script. A compromised user `.zshenv` can redirect `PATTON_SHELL_INTEGRATION_SCRIPT` to a malicious path unless we `typeset -r`/`readonly` the captured value first.
- Electron's `safeStorage` is only available after `app.ready`. Store must be lazy-initialized (first access inside `app.on('ready', ...)` is fine; at module load would fail).
- `electron-store` doesn't expose a "try decrypt" probe — any mismatch throws. Migration has to instantiate a temp store with the legacy key, snapshot `store.store`, delete the file, then reinit with the new key.
- xterm.js WebGL addon fires `onContextLoss` at runtime (sleep/wake, display unplug, GPU driver reset). A plain `try { loadAddon }` catches sync load errors only — runtime loss will take down the whole renderer unless you subscribe to `onContextLoss` and `dispose()` the addon (falls back to DOM). Same pattern as `minimumContrastRatio` — VS Code does it, copying only configuration without the safety nets is a trap.
- Dead IPC surfaces accumulate. `PTY_GET_DESCENDANTS` returned `[]` for months with no callers but was still exposed via preload — potential attack surface. Periodically grep for IPC handlers and confirm callers exist.
- Shell validation drift: `store.ts` had a permissive regex (`/^\/[a-zA-Z0-9/._-]+$/`) while `pty-manager.ts` enforced a tight `ALLOWED_SHELLS` Set. User could save `/usr/local/bin/fish`, see it persist, silently get the default. Always single-source security-relevant allowlists.
- `stty -echo` on the same line as `source ...` does NOT prevent echo — the terminal driver echoes characters as they arrive, before the shell executes anything. Must inject via shell startup (ZDOTDIR, --rcfile) not PTY write.
- Idle detection fires on ANY PTY data, including prompt redraws and background trickle. Duration guard is essential — byte count alone isn't enough since small periodic output accumulates.
- xterm.js treats Shift+Enter identically to Enter (`\r`) by default. Must use `attachCustomKeyEventHandler` to intercept and send a distinct escape sequence.
- xterm.js `attachCustomKeyEventHandler` fires for BOTH `keydown` AND `keypress`. Returning `false` only on `keydown` still lets `keypress` through, causing xterm to send `\r`. Must return `false` for both event types.
- CLI apps (Claude Code, etc.) use `COLORFGBG` env var to detect light vs dark terminal backgrounds. Without it, they assume dark and render light-colored text — invisible on light backgrounds. Must set at PTY spawn time; can't change env vars for running PTYs.
- CLI apps also query terminal colors at runtime via OSC 10/11 escape sequences (`\x1b]10;?\x07` and `\x1b]11;?\x07`). xterm.js doesn't respond to these by default — must hook `onData` and write back `rgb:RR/GG/BB` responses.
- `tabBar.update()` rebuilds the entire DOM (`innerHTML = ''`). Any click-triggered callback that calls `updateTabBar` will destroy elements mid-interaction (e.g., breaking `dblclick` because the first click's target is gone). Guard with early-returns for no-op state transitions.
- Light terminal ANSI colors need explicit contrast checking. xterm.js default `minimumContrastRatio` is 1 (disabled). Colors like `#a5a5a5` (brightWhite) or `#14ce14` (brightGreen) are invisible on white. VS Code uses the same palette but enables contrast enforcement — copying just the colors without the setting is a trap.
- **OSC 133 `'prompt'` is not "awaiting input".** It fires on every prompt redraw — shell startup, session restore, SIGWINCH, `clear`, async-prompt theme refreshes (Starship, Powerlevel10k). Using it as the SET signal for an attention indicator means every inactive tab lights up ~always.
- **Layering multiple `window.on('close')` handlers doesn't work for guards.** Electron runs every registered 'close' handler even if one calls `e.preventDefault()` — a guard handler registered before a destructive one can't prevent the destructive one from running. The guard must live INSIDE the destructive handler.
- **Claude Code's "·" tab-title prefix is text INSIDE the title (OSC 2), not a chrome element.** The user visually conflates it with any indicator Patton renders near the title. Visual amplification of Patton's own indicator (size / glow / pulse) is load-bearing so the two are distinguishable at a glance.
- **Testing that the dot fires requires the signal to arrive while the tab is INACTIVE.** `raiseAwaitingInput()` gates on `!_isActive`. Use a delayed command (`sleep N && <signal>`) and switch tabs during the delay.
- **Packaged Electron apps launched from Dock/Finder route main-process stderr to `/dev/null`.** Without a file logger, every hardening signal is invisible. See `src/main/logger.ts`.
- **Silent ENOENT in `main.log` for days before detection.** Before session 24, `spawn code ENOENT` had been logging 20+ times across 4 days because `code` wasn't on PATH. Worth a periodic log-scan in `scripts/patton-health.sh` or a session-start greeting that counts recent warnings.
- **xterm.js `ILink.activate(event, text)` receives the native `MouseEvent` — but whether `event.detail === 2` reliably fires for double-click is unverified as of session 24.** If double-click appears to do nothing, the fallback is a native `dblclick` listener on `terminal.element` that hit-tests against the active link range.
- **`setCustomTheme()` is called BEFORE `mount()` on new tabs that inherit the current theme** (`tab-manager.ts:153-155`). Any WebGL-aware code in setCustomTheme must guard `if (this.webglAddon)` — otherwise it'll try to dispose/reload an addon that doesn't exist yet.
