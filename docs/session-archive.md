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
