import { TerminalView } from './terminal-view';
import { EditorInput, DEFAULT_COMPOSE_PLACEHOLDER } from './editor-input';
import { SearchOverlay } from './search-overlay';
import { HistorySearch } from './history-search';
import { PasteDialog } from './paste-dialog';
import { ContextMenu } from './context-menu';
import { HistoryManager } from '../services/history-manager';
import { FileLinkProvider } from '../services/file-link-provider';
import { createOsc8LinkHandler } from '../services/osc8-links';
import { rlog } from '../services/renderer-logger';
import { stripPasteControls } from '../services/paste-sanitize';
import { shouldConfirmMultilinePaste } from '../services/paste-confirm';
import { PATTON_QUOTES } from '../../shared/constants';
import { shortcutKeys } from '../../shared/shortcuts';

import type { ITheme } from '@xterm/xterm';
import type { TabFlag } from '../../shared/types';

/** Background work a parked Claude Code session is waiting on (Stop hook). */
export interface ParkedInfo {
  tasks: number;
  crons: number;
}

let paneIdCounter = 0;

export interface PaneCallbacks {
  onFocus: (pane: Pane) => void;
  onTitleChange: (pane: Pane) => void;
  /** The pane's working directory became known or changed (polled, so up to ~2s late). */
  onCwdChange?: (pane: Pane) => void;
  /** The pane now needs the user: Claude stopped, a command finished, a bell or notification. */
  onCommandDone?: () => void;
  /** Claude Code started working again, so any "needs you" signal is stale. */
  onWorkStarted?: () => void;
  /** Claude Code ended its turn but is waiting on its own background tasks or
   *  timers (info), or no longer is (null). Not a "needs you" event. */
  onParked?: (pane: Pane, info: ParkedInfo | null) => void;
  /** An automatic tab flag from the pane's title (`WAKE` → yellow), or null to drop it. */
  onAutoFlag?: (pane: Pane, flag: TabFlag | null) => void;
  onBroadcastWrite?: (data: string) => void;
  /** Broadcast a paste: each other pane pastes it through its own terminal,
   *  so the bracketing follows that pane's mode, not this one's. */
  onBroadcastPaste?: (text: string) => void;
  cwd?: string;
  /** Ask main to export PATTON_PROJECT_DIR (the validated cwd) into this shell. */
  projectDir?: boolean;
  shell?: string;
  historyManager?: HistoryManager;
}

export class Pane {
  readonly id: string;
  readonly element: HTMLElement;
  private terminalContainer: HTMLElement;
  private editorContainer: HTMLElement;
  terminalView: TerminalView;
  editorInput: EditorInput;
  searchOverlay: SearchOverlay;
  historySearch: HistorySearch;
  historyManager: HistoryManager;
  ptyId: number | null = null;
  title = 'Terminal';
  private disposables: (() => void)[] = [];
  private resizeTimer: ReturnType<typeof setTimeout> | null = null;
  private callbacks: PaneCallbacks;
  private ptyExited = false;
  private _isFocused = false;
  private pasteDialog: PasteDialog;
  private contextMenu: ContextMenu;
  private initialCwd: string | undefined;
  // Set before init() on the pane that will run the startup command: its
  // shell gets FORCE_HYPERLINK=1 (see PtyCreateOptions.hyperlinks).
  private hyperlinkEnv = false;
  private currentCwd = '';
  // Set by the first OSC 133 event: this pane's shell reports every prompt,
  // so the cwd can be re-read on prompts instead of polled.
  private shellIntegrated = false;
  private lastCwdCheckMs = 0;
  private static readonly CWD_POLL_MS = 2000;
  private static readonly CWD_SAFETY_NET_MS = 30_000;

  // --- "Needs you" signals (green dot, sound, notification) ---
  // Only signals that mean the pane is now waiting on the user: Claude Code
  // stopping work (see trackClaudeState), a shell command finishing (OSC 133),
  // the bell, and an OSC 9 notification. There is deliberately no "output went
  // quiet" guess: it fired whenever Claude paused mid-task or a dev server
  // went quiet. Several signals can arrive for one event (Claude stopping and
  // ringing the bell), so they share a short debounce.
  private lastCommandDoneMs = 0;
  private static readonly COMMAND_DONE_DEBOUNCE_MS = 5000;
  // Claude Code's terminal title starts with ◐/◑ (alternating) while it works
  // and ✳ once it stops — finished, or waiting on a question or a dialog.
  private static readonly CLAUDE_WORKING = /^[◐◑]/;
  private static readonly CLAUDE_STOPPED = /^✳/;
  // A stop only counts once it has lasted this long: between the turns of a
  // queued prompt the title can flash ✳ for a moment while Claude carries on.
  private static readonly CLAUDE_STOP_SETTLE_MS = 1500;
  private claudeWorking = false;
  private claudeStopTimer: ReturnType<typeof setTimeout> | null = null;
  // True once a Claude title glyph (◐ ◑ ✳) has been seen since the shell's
  // last prompt: Claude Code is running in this pane, so image pastes go to it
  // as Ctrl+V (it reads the clipboard itself) instead of as a file path.
  private claudeActive = false;
  private disposed = false;

  // --- Compose-first (Claude Code tabs) ---
  // The Settings value and the tab's session-only override (null = follow
  // the setting); the effective mode is override ?? setting.
  private composeFirstSetting = false;
  private composeFirstOverride: boolean | null = null;
  // Engaged: the box is open because Claude Code runs here in compose-first
  // mode. Nothing is guessed: Claude's presence is claudeActive (its title
  // glyph), and the box takes focus only on engage, after a submit, and when
  // Claude starts working again after a hand-off.
  private composeFirstEngaged = false;
  // The user gave the keyboard to the terminal (Esc in a non-empty box, or a
  // click in the terminal); nothing refocuses the box until Claude's next ◐.
  private composeHandedOff = false;
  // The user closed the box (⌘E) while engaged: it stays shut until Claude
  // exits or the mode changes, instead of reopening at the next title.
  private composeDismissed = false;
  private static readonly COMPOSE_FIRST_PLACEHOLDER =
    'Message Claude · Enter sends · Shift+Enter newline · Esc interrupts';
  private static readonly COMPOSE_FIRST_MAX_FRACTION = 0.4; // of the pane's height
  private static readonly COMPOSE_FIRST_MIN_PX = 60;
  private static readonly COMPOSE_DEFAULT_MAX_PX = 200;

  // --- Pasted-image thumbnails (see pasteImage) ---
  private static readonly PASTE_CHIP_TTL_MS = 10 * 60 * 1000;
  private static readonly PASTE_CHIP_MAX = 6;
  private pasteStrip!: HTMLElement;
  private pasteChips: { el: HTMLElement; timer: ReturnType<typeof setTimeout> }[] = [];

  // --- Claude Code Stop hook (OSC 777 `patton;stop;tasks=N;crons=M`) ---
  // Claude Code 2.1.318 shows ◐/◑ only while its main loop is busy and ✳
  // otherwise — including when the turn ended but subagents, background
  // shells or scheduled wakeups are still in flight. So ✳ alone can't tell
  // "parked on its own work" from "needs you"; Patton's Stop hook can (it
  // reads `background_tasks` and `session_crons` from the Stop input).
  //
  // A verdict is only a candidate: another Stop hook can return `block` (the
  // turn carries on) and a queued prompt starts a new turn, and Patton's hook,
  // finishing in ~30 ms, lands before either shows. It is not known whether
  // the title is still ◐ or already ✳ while Stop hooks run, so the machine
  // below is right in both orders: a verdict is applied only once ✳ has held
  // for the normal settle, exactly like a title-only stop.
  //
  // States: WORKING (claudeWorking), SETTLING (claudeStopTimer armed),
  // PARKED (parked set), STOPPED (none). `pendingVerdict` rides alongside.
  //   verdict      WORKING: store it (replaces an older one; expires 40 s
  //                after arrival). Otherwise: store it and (re)arm the settle
  //                timer at CLAUDE_STOP_SETTLE_MS.
  //   ✳ (from      → SETTLING: CLAUDE_STOP_SETTLE_MS if a verdict is stored,
  //   WORKING)       else the title-only wait (4 s once the pane has seen the
  //                  hook, so a late verdict can still land; 1.5 s without).
  //   settle fires verdict stored: apply it (tasks+crons > 0 → PARKED, no
  //                dot; 0 → STOPPED + needs-you, source `hook`). No verdict:
  //                PARKED stays silent, else STOPPED + needs-you (`claude`).
  //   ◐/◑          cancel the settle; WORKING (clears PARKED, resets the
  //                debounce, onWorkStarted). The stored verdict is kept, so a
  //                spinner tail frame after it is harmless; expiry or the next
  //                verdict retires it.
  //   OSC 133      prompt: Claude has exited → STOPPED, stored verdict dropped.
  //   bell/OSC 9   ignored in WORKING and SETTLING; otherwise needs-you
  //                (5 s debounce, shared with every source).
  private hookActive = false;
  private static readonly CLAUDE_STOP_SETTLE_WITH_HOOK_MS = 4000;
  // Claude Code shows ✳ only once every Stop hook has finished, so the gap
  // between this verdict and ✳ is the slowest other Stop hook. On Michael's
  // setup (closing-block-gate, source-critic) it measured 4.5–31 s on
  // 2026-11-06; at 10 s, 19 stops fell through to the title path and 2 of
  // those went green while the hook had reported background work. The TTL
  // also bounds the opposite failure: a stop another hook blocks keeps its
  // verdict while Claude carries on, and if Claude then shows ✳ with no Stop
  // hook (a question or permission dialog, Esc, an API error) a stale
  // tasks > 0 verdict parks the pane silently instead of alerting. Hence
  // just above the measured maximum, not more; `afterMs` on "Hook verdict
  // applied" is the data to retune it.
  private static readonly HOOK_VERDICT_TTL_MS = 40_000;
  private pendingVerdict: ParkedInfo | null = null;
  private pendingVerdictAtMs = 0;
  private pendingVerdictTimer: ReturnType<typeof setTimeout> | null = null;
  private parked: ParkedInfo | null = null;
  // `wake` (Michael's zsh function) titles the pane exactly WAKE while it
  // keeps the Mac awake; the tab gets a yellow flag for as long as it does.
  private autoFlagged = false;

  private fireCommandDone(source: 'osc133' | 'claude' | 'bell' | 'osc9' | 'hook'): void {
    // While Claude works (or its stop is still settling), a bell or OSC 9 is
    // incidental — e.g. a BEL in tool output — not Claude asking for you. A
    // real stop arrives through the title anyway.
    if ((source === 'bell' || source === 'osc9') && (this.claudeWorking || this.claudeStopTimer)) {
      return;
    }
    const now = Date.now();
    if (now - this.lastCommandDoneMs < Pane.COMMAND_DONE_DEBOUNCE_MS) {
      return;
    }
    this.lastCommandDoneMs = now;
    rlog('info', '[DOT] Needs-you signal', { pane: this.id, source });
    this.callbacks.onCommandDone?.();
  }

  /** Follow Claude Code's working/stopped state from its title. Going from
   *  working to stopped is the moment it needs the user (after the settle). */
  private trackClaudeState(title: string): void {
    // A title with neither glyph means Claude is gone (fish, or shell
    // integration off, never sends the OSC 133 prompt that would clear this).
    this.claudeActive = Pane.CLAUDE_WORKING.test(title) || Pane.CLAUDE_STOPPED.test(title);
    this.syncComposeFirst('title');
    if (Pane.CLAUDE_WORKING.test(title)) {
      this.cancelClaudeStop(); // the ✳ was only a flash between turns
      if (this.claudeWorking) return;
      this.claudeWorking = true;
      // A new stretch of work: the next stop is a new event, never a
      // duplicate of the last one, so it mustn't be debounced away.
      this.lastCommandDoneMs = 0;
      this.setParked(null);
      this.clearPasteChips(); // the pasted image has been sent along with the prompt
      this.callbacks.onWorkStarted?.();
      this.reclaimCompose('work-started');
    } else if (this.claudeWorking) {
      this.claudeWorking = false;
      if (Pane.CLAUDE_STOPPED.test(title)) {
        const wait = this.pendingVerdict || !this.hookActive
          ? Pane.CLAUDE_STOP_SETTLE_MS
          : Pane.CLAUDE_STOP_SETTLE_WITH_HOOK_MS;
        this.armClaudeStop(wait);
      }
    }
  }

  /** Arm (or re-arm) the settle timer; when it fires, the stop is real. */
  private armClaudeStop(ms: number): void {
    this.cancelClaudeStop();
    this.claudeStopTimer = setTimeout(() => {
      this.claudeStopTimer = null;
      this.settleClaudeStop();
    }, ms);
  }

  /** ✳ has held for the settle: apply the stored verdict, else the title path. */
  private settleClaudeStop(): void {
    const verdictAgeMs = Date.now() - this.pendingVerdictAtMs;
    const verdict = this.takeVerdict();
    if (verdict) {
      const { tasks, crons } = verdict;
      rlog('info', '[DOT] Hook verdict applied', { pane: this.id, tasks, crons, afterMs: verdictAgeMs });
      if (tasks + crons > 0) {
        rlog('info', '[DOT] Parked', { pane: this.id, tasks, crons, source: 'hook' });
        this.setParked({ tasks, crons });
      } else {
        this.setParked(null);
        this.fireCommandDone('hook');
      }
      return;
    }
    // A parked pane waits on its own work; ✳ alone mustn't turn that into a dot.
    if (this.parked) return;
    this.fireCommandDone('claude');
  }

  /** The Stop hook's verdict on a turn that is closing. Stored, never acted on
   *  at once (see the state machine above the hook fields). */
  private handleHookStop(tasks: number, crons: number): void {
    this.hookActive = true;
    if (this.pendingVerdictTimer) clearTimeout(this.pendingVerdictTimer);
    const replaced = this.pendingVerdict !== null;
    this.pendingVerdict = { tasks, crons };
    this.pendingVerdictAtMs = Date.now();
    this.pendingVerdictTimer = setTimeout(() => {
      this.pendingVerdictTimer = null;
      if (!this.pendingVerdict) return;
      rlog('info', '[DOT] Hook verdict expired', { pane: this.id, ...this.pendingVerdict });
      this.pendingVerdict = null;
    }, Pane.HOOK_VERDICT_TTL_MS);
    rlog('info', '[DOT] Hook verdict stored', {
      pane: this.id, tasks, crons, working: this.claudeWorking, replaced,
    });
    // Already off the spinner (✳, or no Claude title at all): settle now.
    // While working, the ✳ transition arms the settle.
    if (!this.claudeWorking) this.armClaudeStop(Pane.CLAUDE_STOP_SETTLE_MS);
  }

  /** Remove and return the stored verdict, stopping its expiry timer. */
  private takeVerdict(): ParkedInfo | null {
    const verdict = this.pendingVerdict;
    this.pendingVerdict = null;
    if (this.pendingVerdictTimer) {
      clearTimeout(this.pendingVerdictTimer);
      this.pendingVerdictTimer = null;
    }
    return verdict;
  }

  private setParked(info: ParkedInfo | null): void {
    if (info === null && this.parked === null) return;
    if (info && this.parked && info.tasks === this.parked.tasks && info.crons === this.parked.crons) return;
    this.parked = info;
    this.callbacks.onParked?.(this, info);
  }

  /** `WAKE` as the whole title → yellow tab flag; any other title drops it. */
  private trackAutoFlag(title: string): void {
    if (title === 'WAKE') {
      if (this.autoFlagged) return;
      this.autoFlagged = true;
      this.callbacks.onAutoFlag?.(this, 'yellow');
    } else if (this.autoFlagged) {
      this.autoFlagged = false;
      this.callbacks.onAutoFlag?.(this, null);
    }
  }

  /** Ask main for the shell's current folder (lsof) and report a change. */
  private refreshCwd(): void {
    void this.refreshCwdNow();
  }

  /**
   * Ask main for the shell's folder and update the cache. An empty answer
   * (refused by main's 10/s limit, or lsof failed) keeps the cached folder.
   * Resolves once the answer is applied, so autosave can space its calls.
   */
  refreshCwdNow(): Promise<void> {
    if (this.ptyId === null || this.ptyExited) return Promise.resolve();
    this.lastCwdCheckMs = Date.now();
    return window.patton.pty.getCwd(this.ptyId)
      .then((cwd) => {
        if (cwd && cwd !== this.currentCwd) {
          this.currentCwd = cwd;
          this.callbacks.onCwdChange?.(this);
        }
      })
      .catch(() => { /* ignore — the next prompt or poll retries */ });
  }

  private cancelClaudeStop(): void {
    if (this.claudeStopTimer) {
      clearTimeout(this.claudeStopTimer);
      this.claudeStopTimer = null;
    }
  }


  constructor(callbacks: PaneCallbacks) {
    this.id = `pane-${++paneIdCounter}`;
    this.callbacks = callbacks;
    this.initialCwd = callbacks.cwd;
    this.historyManager = callbacks.historyManager || new HistoryManager();

    // Create DOM structure
    this.element = document.createElement('div');
    this.element.className = 'pane';
    this.element.id = this.id;

    // Focus on click
    const focusHandler = () => this.callbacks.onFocus(this);
    this.element.addEventListener('mousedown', focusHandler);
    this.disposables.push(() => this.element.removeEventListener('mousedown', focusHandler));

    // Drag handle for pane swapping (visible only inside split containers via CSS)
    const dragHandle = document.createElement('div');
    dragHandle.className = 'pane-drag-handle';
    dragHandle.setAttribute('aria-label', 'Drag to swap pane');
    dragHandle.textContent = '\u2630'; // ☰ hamburger/grip icon
    this.element.appendChild(dragHandle);
    this.setupDragHandle(dragHandle);

    this.terminalContainer = document.createElement('div');
    this.terminalContainer.className = 'terminal-container';
    this.element.appendChild(this.terminalContainer);

    this.pasteStrip = document.createElement('div');
    this.pasteStrip.className = 'paste-strip';
    this.pasteStrip.setAttribute('role', 'group');
    this.pasteStrip.setAttribute('aria-label', 'Pasted images');
    this.pasteStrip.hidden = true;
    // Never take focus from the terminal when a chip is clicked.
    this.pasteStrip.addEventListener('mousedown', (e) => e.preventDefault());
    this.element.appendChild(this.pasteStrip);

    this.editorContainer = document.createElement('div');
    this.editorContainer.className = 'editor-container collapsed';
    this.element.appendChild(this.editorContainer);

    // Create terminal view
    this.terminalView = new TerminalView(this.terminalContainer);

    // Create editor input (compose panel — collapsed by default)
    this.editorInput = new EditorInput(this.editorContainer, {
      onSubmit: (command) => {
        this.handleSubmit(command);
        // Compose-first keeps the box open and focused for the next message.
        if (!this.composeFirstEngaged) this.collapseCompose();
      },
      onInterrupt: () => {
        this.handleInterrupt();
        if (!this.composeFirstEngaged) this.collapseCompose();
      },
      onHistoryUp: () => this.historyManager.up(this.editorInput.getValue()),
      onHistoryDown: () => this.historyManager.down(),
      onTab: () => this.handleTab(),
      // Reached only with text in the box when compose-first is engaged (an
      // empty box's Esc goes to Claude via onEmptyBoxKey): keep the draft and
      // hand the keyboard to Claude's own prompt.
      onEscape: () => {
        if (this.composeFirstEngaged) this.handOffCompose('Escape');
        else this.collapseCompose();
      },
      onImagePaste: () => { void this.pasteImage('compose'); },
      onEmptyBoxKey: (e) => this.forwardEmptyBoxKey(e),
      getMaxHeight: () => this.composeMaxHeight(),
    });

    // Compose-first: a click in the terminal hands it the keyboard (so the
    // box mustn't take focus back until Claude's next ◐); a click in the box
    // takes it back. Capture phase, so this runs before the pane's own
    // mousedown → onFocus → focus() path reads composeHandedOff.
    const terminalMouseDown = (e: MouseEvent) => {
      if (!this.composeFirstEngaged) return;
      if (e.button !== 0) return; // a right-click (context menu) keeps the keyboard where it is
      if ((e.target as Element | null)?.closest?.('.search-overlay')) return;
      this.handOffCompose('click');
    };
    this.terminalContainer.addEventListener('mousedown', terminalMouseDown, true);
    this.disposables.push(() => this.terminalContainer.removeEventListener('mousedown', terminalMouseDown, true));
    const editorMouseDown = () => {
      if (this.composeFirstEngaged && this.composeHandedOff) {
        this.composeHandedOff = false;
        rlog('info', '[COMPOSE] reclaim', { pane: this.id, reason: 'click' });
      }
    };
    this.editorContainer.addEventListener('mousedown', editorMouseDown, true);
    this.disposables.push(() => this.editorContainer.removeEventListener('mousedown', editorMouseDown, true));

    // Create search overlay
    this.searchOverlay = new SearchOverlay(
      this.terminalContainer,
      this.terminalView.searchAddon,
      () => this.terminalView.focus(),
    );

    // Create history search (Ctrl+R)
    this.historySearch = new HistorySearch(this.element, {
      onSelect: (command) => {
        this.expandCompose();
        this.editorInput.setValue(command);
        this.editorInput.focus();
      },
      onCancel: () => {
        this.terminalView.focus();
      },
    });

    // Click on collapsed compose bar expands it
    this.editorContainer.addEventListener('click', () => {
      if (this.editorContainer.classList.contains('collapsed')) {
        this.expandCompose();
      }
    });

    this.pasteDialog = new PasteDialog(this.element);
    this.contextMenu = new ContextMenu();
  }

  /** This pane will run the startup command (Claude): ask main for
   *  FORCE_HYPERLINK=1 in its shell. Only before init(); later it can't
   *  reach a shell that already exists. */
  enableHyperlinkEnv(): void {
    if (this.ptyId !== null) return;
    this.hyperlinkEnv = true;
  }

  async init(): Promise<void> {
    // Mount terminal
    this.terminalView.mount();

    // Shift+Enter: send kitty keyboard protocol escape sequence so apps
    // (Claude Code, fish, neovim, etc.) can distinguish it from plain Enter
    this.terminalView.terminal.attachCustomKeyEventHandler((e) => {
      if (e.key === 'Enter' && e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
        if (e.type === 'keydown' && this.ptyId !== null) {
          window.patton.pty.write(this.ptyId, '\x1b[13;2u');
        }
        return false; // block both keydown AND keypress to prevent xterm sending \r
      }
      // Ctrl+V reaches Claude Code unchanged (it reads the clipboard image
      // itself); Patton only shows a thumbnail of what was pasted.
      if (e.type === 'keydown' && e.ctrlKey && !e.metaKey && !e.altKey && e.key.toLowerCase() === 'v') {
        if (this.claudeActive && !e.repeat) void this.pasteImage('ctrl-v-key'); // a held key adds one chip
        return true;
      }
      return true; // let xterm handle all other keys
    });

    // Register file path link provider (Cmd+click to open in editor)
    const linkDisposable = this.terminalView.terminal.registerLinkProvider(
      new FileLinkProvider(this.terminalView.terminal, () => this.currentCwd),
    );
    this.disposables.push(() => linkDisposable.dispose());

    // OSC 8 hyperlinks a program prints (read from the option at hover time).
    this.terminalView.terminal.options.linkHandler = createOsc8LinkHandler(
      this.terminalView.terminal,
      () => this.currentCwd,
    );

    // Display welcome quote instantly (pre-PTY) so the tab feels responsive
    const quote = PATTON_QUOTES[Math.floor(Math.random() * PATTON_QUOTES.length)];
    this.terminalView.write(`\r\n  \x1b[1m"\x1b[3m${quote}\x1b[0m\x1b[1m"\x1b[0m\r\n  \x1b[2m— General George S. Patton\x1b[0m\r\n\r\n`);

    // Create PTY (shell path passed down from App to avoid per-pane IPC)
    const dims = this.terminalView.getDimensions();
    const shellPath = this.callbacks.shell;
    try {
      this.ptyId = await window.patton.pty.create({
        cols: dims.cols,
        rows: dims.rows,
        ...(this.initialCwd ? { cwd: this.initialCwd } : {}),
        ...(this.initialCwd && this.callbacks.projectDir ? { projectDir: true } : {}),
        ...(this.hyperlinkEnv ? { hyperlinks: true } : {}),
        ...(shellPath ? { shell: shellPath } : {}),
        isDark: this.terminalView.isDarkBackground(),
      });
      this.terminalView.setPtyId(this.ptyId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.terminalView.write(`\r\n\x1b[31mFailed to create terminal: ${msg}\x1b[0m\r\n`);
      return;
    }

    // Wire PTY data → terminal (unconditional — no mode checking)
    this.disposables.push(
      window.patton.pty.onData((id, data) => {
        if (id === this.ptyId) {
          this.terminalView.write(data);
        }
      }),
    );

    // Track PTY exit to avoid destroy-after-exit
    this.disposables.push(
      window.patton.pty.onExit((id) => {
        if (id === this.ptyId) {
          this.ptyExited = true;
        }
      }),
    );

    // Load history (skip if shared instance already loaded)
    if (!this.callbacks.historyManager) {
      await this.historyManager.load();
    }

    // Terminal bell → notification sound
    this.disposables.push(
      this.terminalView.onBell(() => this.fireCommandDone('bell')),
    );

    // OSC 9 (terminal notification escape) → needs-you signal. Standards-
    // based attention request from any tool that opts in; same treatment as
    // the bell. Progress-bar and other ConEmu-style OSC 9 forms are filtered
    // out in terminal-view.ts, so they never get here.
    this.disposables.push(
      this.terminalView.onOsc9(() => this.fireCommandDone('osc9')),
    );

    // Listen for title changes via xterm.js OSC sequences (no process polling needed)
    this.disposables.push(
      this.terminalView.onTitleChange((title) => {
        if (title) {
          this.title = title;
          // Tab title first, so a "needs you" alert names the tab as it is now.
          this.callbacks.onTitleChange(this);
          this.trackAutoFlag(title);
          this.trackClaudeState(title);
        }
      }),
    );

    // Claude Code Stop hook verdicts (OSC 777, see handleHookStop).
    this.disposables.push(
      this.terminalView.onPattonState((state) => {
        if (state.kind === 'stop') this.handleHookStop(state.tasks, state.crons);
      }),
    );
    this.disposables.push(() => {
      this.cancelClaudeStop();
      this.takeVerdict();
    });

    // Track the cwd for file link resolution and tab naming. With shell
    // integration the folder is re-read at every prompt (see the
    // onPromptState handler), so this timer is only a slow safety net;
    // shells without integration keep the 2s poll (focused pane only).
    this.currentCwd = this.initialCwd || '';
    if (this.currentCwd) this.callbacks.onCwdChange?.(this);
    const cwdPoll = setInterval(() => {
      if (!this._isFocused) return; // Skip polling for unfocused panes
      if (this.shellIntegrated && Date.now() - this.lastCwdCheckMs < Pane.CWD_SAFETY_NET_MS) return;
      this.refreshCwd();
    }, Pane.CWD_POLL_MS);
    this.disposables.push(() => clearInterval(cwdPoll));

    // Wire terminal data → PTY (unconditional forwarding)
    const termDataDispose = this.terminalView.onTerminalData((data) => {
      if (this.ptyId !== null) {
        window.patton.pty.write(this.ptyId, data);
      }
    });
    if (termDataDispose) this.disposables.push(termDataDispose);

    // --- Handle resize with debouncing ---
    const resizeObserver = new ResizeObserver(() => {
      if (this.resizeTimer) clearTimeout(this.resizeTimer);
      this.resizeTimer = setTimeout(() => {
        this.terminalView.fit();
        if (this.ptyId !== null) {
          const dims = this.terminalView.getDimensions();
          window.patton.pty.resize(this.ptyId, dims.cols, dims.rows);
        }
        // The box's cap is a share of the pane's height, so follow resizes.
        if (this.composeFirstEngaged) this.editorInput.refreshSize();
      }, 100);
    });
    resizeObserver.observe(this.terminalContainer);
    this.disposables.push(() => resizeObserver.disconnect());

    // Security: intercept paste to sanitize and warn on multi-line.
    // xterm registers its own paste listeners on its textarea and .xterm and
    // calls stopPropagation() (Clipboard.ts handlePasteEvent), so a bubble
    // listener up here never sees a paste in the terminal. Capture runs first.
    // Text is sanitised, confirmed, then handed to terminal.paste() so
    // bracketed-paste mode stays intact; an empty paste may be an image.
    const onPasteCapture = (e: ClipboardEvent) => {
      if (!(e.target as Element | null)?.closest?.('.xterm')) return; // e.g. the search box
      e.preventDefault();
      e.stopPropagation(); // else xterm sends an empty paste and the image attaches twice
      const raw = e.clipboardData?.getData('text') || '';
      if (raw) void this.safePaste(raw);
      else void this.pasteImage('paste');
    };
    this.terminalContainer.addEventListener('paste', onPasteCapture as EventListener, true);
    this.disposables.push(() => this.terminalContainer.removeEventListener('paste', onPasteCapture as EventListener, true));

    // Right-click context menu
    const contextMenuHandler = (e: MouseEvent) => {
      e.preventDefault();
      const hasSelection = !!this.terminalView.terminal.getSelection();
      this.contextMenu.show(e.clientX, e.clientY, [
        ...(hasSelection ? [{
          label: 'Copy',
          shortcut: shortcutKeys('copy'),
          action: () => {
            const sel = this.terminalView.terminal.getSelection();
            if (sel) navigator.clipboard.writeText(sel);
          },
        }] : []),
        {
          label: 'Paste',
          shortcut: shortcutKeys('paste'),
          action: () => {
            navigator.clipboard.readText().then(text => {
              if (text) this.safePaste(text);
              else void this.pasteImage('menu');
            });
          },
        },
        { separator: true as const },
        {
          label: 'Compose',
          shortcut: shortcutKeys('toggle-compose'),
          action: () => this.toggleCompose(),
        },
        {
          label: 'Clear',
          shortcut: shortcutKeys('clear'),
          action: () => this.terminalView.clear(),
        },
        { separator: true as const },
        {
          label: 'Split Right',
          shortcut: shortcutKeys('split-vertical'),
          action: () => {
            this.element.dispatchEvent(new CustomEvent('pane-split', { detail: 'vertical', bubbles: true }));
          },
        },
        {
          label: 'Split Down',
          shortcut: shortcutKeys('split-horizontal'),
          action: () => {
            this.element.dispatchEvent(new CustomEvent('pane-split', { detail: 'horizontal', bubbles: true }));
          },
        },
      ]);
    };
    this.element.addEventListener('contextmenu', contextMenuHandler);
    this.disposables.push(() => this.element.removeEventListener('contextmenu', contextMenuHandler));

    // OSC 133 shell integration: visual feedback on compose bar + command-done notification
    let wasRunning = false;
    this.disposables.push(
      this.terminalView.onPromptState((state) => {
        this.editorContainer.classList.toggle('prompt-ready', state === 'prompt');
        this.editorContainer.classList.toggle('command-running', state === 'command');
        // Fire command-done when transitioning from running → prompt/idle
        if (wasRunning && (state === 'prompt' || state === 'idle')) {
          this.fireCommandDone('osc133');
        }
        wasRunning = state === 'command';
        // A shell's folder can only change at a prompt, and every prompt sends
        // OSC 133 D ('idle') first — including the first one — so re-read it
        // now: a `cd` renames the tab instantly instead of on the next poll.
        this.shellIntegrated = true;
        if (state === 'idle') this.refreshCwd();
        // The shell is back at its prompt, so Claude isn't running here any
        // more — even if it quit mid-work and left a ◐ title behind. Without
        // this, the next `claude` launch's first ✳ would read as a stop.
        if (state === 'prompt') {
          this.claudeWorking = false;
          this.claudeActive = false;
          this.syncComposeFirst('shell-prompt');
          this.cancelClaudeStop();
          if (this.takeVerdict()) rlog('info', '[DOT] Hook verdict dropped: shell prompt', { pane: this.id });
          this.setParked(null);
          this.clearPasteChips();
        }
      }),
    );

    // Focus terminal on init (terminal is always the primary input)
    requestAnimationFrame(() => this.terminalView.focus());
  }

  private submitQueue: Promise<void> = Promise.resolve();

  private handleSubmit(command: string): void {
    if (this.ptyId === null) return;

    // Broadcast mode: also write to all other panes in the tab
    const broadcast = this.callbacks.onBroadcastWrite;

    // Never send the box's text with its own control characters: an ESC[201~
    // inside it would end the bracketed paste early (see paste-sanitize.ts).
    command = stripPasteControls(command);

    // Compose-first sends a multi-line draft to Claude Code as a bracketed
    // paste (terminal.paste wraps it in ESC[200~ … ESC[201~ when the program
    // asked for that, which Claude Code does), so it arrives as one block of
    // text: typed raw, each newline would be an Enter and send the first line
    // alone. Without bracketed-paste mode a paste is no better than typing, so
    // the mode is read when the submit actually runs, not when it is queued.
    const multiLineCompose = this.composeFirstEngaged && command.includes('\n');
    const lines = command ? command.split('\n').length : 0;

    // Queue submits sequentially to prevent rapid double-submit from dropping the first Enter.
    // Each submit writes text then Enter with a small gap, and the next submit waits for the previous.
    this.submitQueue = this.submitQueue.then(() => new Promise<void>((resolve) => {
      if (this.ptyId === null) { resolve(); return; }
      const route: 'paste' | 'type' =
        multiLineCompose && this.terminalView.terminal.modes.bracketedPasteMode ? 'paste' : 'type';
      rlog('info', '[COMPOSE] submit', { pane: this.id, lines, route });
      // xterm's scrollOnUserInput only sees its own keys, not the box's.
      this.terminalView.terminal.scrollToBottom();
      if (route === 'paste') {
        this.terminalView.terminal.paste(command);
        this.callbacks.onBroadcastPaste?.(command);
        // The Enter waits longer than a typed line's so Claude Code has taken
        // in the whole paste first: 60 ms is meant to clear its paste debounce
        // (a margin chosen by reading, not yet measured live).
        setTimeout(() => {
          if (this.ptyId !== null) {
            window.patton.pty.write(this.ptyId, '\r');
            broadcast?.('\r');
          }
          resolve();
        }, 60);
      } else if (command) {
        window.patton.pty.write(this.ptyId, command);
        broadcast?.(command);
        setTimeout(() => {
          if (this.ptyId !== null) {
            window.patton.pty.write(this.ptyId, '\r');
            broadcast?.('\r');
          }
          resolve();
        }, 10);
      } else {
        window.patton.pty.write(this.ptyId, '\r');
        broadcast?.('\r');
        resolve();
      }
    }));

    if (command.trim()) {
      this.historyManager.add(command);
    }
    this.historyManager.resetCursor();
  }

  private handleInterrupt(): void {
    if (this.ptyId === null) return;
    window.patton.pty.write(this.ptyId, '\x03');
  }

  private handleTab(): void {
    if (this.ptyId === null) return;
    window.patton.pty.write(this.ptyId, '\t');
  }

  /** Check if an overlay (settings, paste dialog, search, etc.) currently has focus. */
  private static isOverlayFocused(): boolean {
    const active = document.activeElement;
    if (!active) return false;
    return active.closest('[role="dialog"], .search-overlay, .paste-dialog-overlay') !== null;
  }

  /**
   * Whether compose-first may move the keyboard into the box unasked (on
   * engage, or when Claude starts working again): only in the tab's focused
   * pane, and only when the keyboard is in this pane or nowhere, so it never
   * takes it from the notes panel, the bookmarks sidebar, a tab-rename box, a
   * context menu or a dialog while the user is typing there.
   */
  private canTakeKeyboard(): boolean {
    if (!this._isFocused || Pane.isOverlayFocused()) return false;
    const active = document.activeElement;
    return !active || active === document.body || this.element.contains(active);
  }

  /**
   * Paste the clipboard image, if there is one. With Claude Code active we send
   * Ctrl+V (it reads the clipboard itself); otherwise the image is saved and its
   * quoted path typed at the prompt (inserted into the compose panel when the
   * paste came from there, so it lands where the caret is, not ahead of the
   * composed text). Either way a thumbnail chip is shown.
   * 'ctrl-v-key' means the user typed Ctrl+V, which already reached the PTY, so
   * only the thumbnail is added.
   */
  private async pasteImage(source: 'paste' | 'menu' | 'ctrl-v-key' | 'compose'): Promise<void> {
    if (this.ptyId === null || this.disposed) return;
    try {
      const sendCtrlV = this.claudeActive;
      const image = await window.patton.clipboard.readImage(!sendCtrlV);
      if (!image || this.disposed || this.ptyId === null) return;
      let route: 'ctrl-v' | 'path';
      if (sendCtrlV) {
        route = 'ctrl-v';
        if (source !== 'ctrl-v-key') window.patton.pty.write(this.ptyId, '\x16');
      } else {
        if (!image.path) return;
        route = 'path';
        const quoted = "'" + image.path.replace(/'/g, "'\\''") + "'";
        if (source === 'compose') this.editorInput.insertText(quoted);
        else window.patton.pty.write(this.ptyId, quoted);
      }
      this.addPasteChip(image.dataUrl, image.width, image.height);
      rlog('info', '[PASTE] image', { pane: this.id, route, width: image.width, height: image.height });
    } catch (err) {
      rlog('warn', '[PASTE] image paste failed', { pane: this.id, error: String(err) });
    }
  }

  private addPasteChip(dataUrl: string, width: number, height: number): void {
    const label = `${width}\u00d7${height}`;
    const chip = document.createElement('div');
    chip.className = 'paste-chip';

    const img = document.createElement('img');
    img.className = 'paste-chip-img';
    img.src = dataUrl;
    img.alt = `Pasted image, ${label}`;
    chip.appendChild(img);

    const text = document.createElement('span');
    text.className = 'paste-chip-label';
    text.textContent = label;
    chip.appendChild(text);

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'paste-chip-remove';
    remove.setAttribute('aria-label', `Remove pasted image preview, ${label}`);
    remove.textContent = '\u00d7';
    chip.appendChild(remove);

    const entry = {
      el: chip,
      timer: setTimeout(() => this.removePasteChip(entry), Pane.PASTE_CHIP_TTL_MS),
    };
    remove.addEventListener('click', () => {
      this.removePasteChip(entry);
      this.terminalView.focus();
    });

    this.pasteChips.push(entry);
    while (this.pasteChips.length > Pane.PASTE_CHIP_MAX) this.removePasteChip(this.pasteChips[0]);
    this.pasteStrip.appendChild(chip);
    this.setPasteStripVisible(true);
  }

  private removePasteChip(entry: { el: HTMLElement; timer: ReturnType<typeof setTimeout> }): void {
    clearTimeout(entry.timer);
    entry.el.remove();
    this.pasteChips = this.pasteChips.filter((c) => c !== entry);
    if (this.pasteChips.length === 0) this.setPasteStripVisible(false);
  }

  /** Showing or hiding the strip changes the terminal's height: re-fit and tell the PTY now. */
  private setPasteStripVisible(visible: boolean): void {
    if (this.pasteStrip.hidden === !visible) return;
    this.pasteStrip.hidden = !visible;
    if (this.disposed) return;
    this.terminalView.fit();
    if (this.ptyId !== null) {
      const dims = this.terminalView.getDimensions();
      window.patton.pty.resize(this.ptyId, dims.cols, dims.rows);
    }
  }

  private clearPasteChips(): void {
    for (const entry of [...this.pasteChips]) this.removePasteChip(entry);
  }

  /** Sanitize pasted text and, if the setting asks for it, confirm multi-line
   *  pastes before pasting into the terminal. */
  private async safePaste(raw: string): Promise<void> {
    if (this.ptyId === null || !raw) return;
    // Strip dangerous control characters (keep \n, \t, \r, printable)
    const sanitized = stripPasteControls(raw);
    if (!sanitized) return;

    const lines = sanitized.split(/\r\n|\r|\n/);
    if (lines.length >= 3) {
      const ask = shouldConfirmMultilinePaste();
      rlog('info', '[PASTE] multi-line text', {
        pane: this.id, lines: lines.length, confirm: ask,
        bracketed: this.terminalView.terminal.modes.bracketedPasteMode,
      });
      if (ask) {
        const confirmed = await this.pasteDialog.confirm(sanitized, lines.length);
        if (!confirmed || this.disposed || this.ptyId === null) return;
      }
    }
    // xterm's own paste: converts newlines and keeps bracketed-paste mode, so
    // Claude Code sees one paste, not Enter presses. Never pty.write pasted text.
    this.terminalView.terminal.paste(sanitized);
  }

  // --- Compose panel ---

  private get composeFirstEffective(): boolean {
    return this.composeFirstOverride ?? this.composeFirstSetting;
  }

  /** Set by the tab: the Settings value and the tab's override. */
  setComposeFirst(setting: boolean, override: boolean | null): void {
    if (setting === this.composeFirstSetting && override === this.composeFirstOverride) return;
    this.composeFirstSetting = setting;
    this.composeFirstOverride = override;
    rlog('info', '[COMPOSE] first-mode', {
      pane: this.id, setting, override, effective: this.composeFirstEffective,
    });
    this.syncComposeFirst('mode-change');
  }

  /** Open or close the compose-first box to match the mode and Claude's presence. */
  private syncComposeFirst(reason: string): void {
    // A dismissal (⌘E) lasts until Claude leaves or the mode changes.
    if (!this.claudeActive || !this.composeFirstEffective || reason === 'mode-change') {
      this.composeDismissed = false;
    }
    const want = this.composeFirstEffective && this.claudeActive && !this.composeDismissed;
    if (want && !this.composeFirstEngaged) this.engageComposeFirst(reason);
    else if (!want && this.composeFirstEngaged) this.disengageComposeFirst(reason);
  }

  private engageComposeFirst(reason: string): void {
    this.composeFirstEngaged = true;
    this.composeHandedOff = false;
    this.editorContainer.classList.add('compose-first');
    this.editorContainer.classList.remove('collapsed');
    this.editorInput.setPlaceholder(Pane.COMPOSE_FIRST_PLACEHOLDER);
    this.editorInput.setSpellcheck(true); // messages to Claude are prose
    this.editorInput.refreshSize();
    rlog('info', '[COMPOSE] engage', { pane: this.id, reason });
    // Only the tab's focused pane takes the keyboard, and never from a panel,
    // menu or dialog the user is typing in.
    if (this.canTakeKeyboard()) {
      this.editorInput.focus();
    } else if (this._isFocused && Pane.isOverlayFocused() && this.element.getClientRects().length > 0) {
      // A dialog (Settings, where the mode is switched on) hands focus back to
      // the terminal when it closes; count that as a hand-off, so Claude's
      // next ◐ brings the keyboard to the box.
      this.composeHandedOff = true;
    }
  }

  private disengageComposeFirst(reason: string): void {
    const hadFocus = this.editorInput.hasFocus();
    this.composeFirstEngaged = false;
    this.composeHandedOff = false;
    this.editorContainer.classList.remove('compose-first');
    this.editorContainer.classList.add('collapsed'); // the draft stays; ⌘E shows it
    this.editorInput.setPlaceholder(DEFAULT_COMPOSE_PLACEHOLDER);
    this.editorInput.setSpellcheck(false);
    this.editorInput.refreshSize();
    rlog('info', '[COMPOSE] disengage', { pane: this.id, reason });
    if (hadFocus) this.terminalView.focus();
  }

  /** Give the keyboard to the terminal (Claude's own prompt), keeping the draft. */
  private handOffCompose(key: 'Escape' | 'click'): void {
    if (!this.composeHandedOff) {
      this.composeHandedOff = true;
      rlog('info', '[COMPOSE] handoff', { pane: this.id, key, route: 'focus' });
    }
    if (key === 'Escape') this.terminalView.focus(); // a click focuses xterm itself
  }

  /** Claude started working again: the box takes the keyboard back after a hand-off. */
  private reclaimCompose(reason: string): void {
    if (!this.composeFirstEngaged || !this.composeHandedOff) return;
    // Keep the hand-off when the box can't take the keyboard now, so a later
    // ◐ (or a click in the box) still brings it back.
    if (!this.canTakeKeyboard()) return;
    this.composeHandedOff = false;
    rlog('info', '[COMPOSE] reclaim', { pane: this.id, reason });
    this.editorInput.focus();
  }

  /**
   * Compose-first, empty box: navigation and answer keys go to Claude Code as
   * the bytes xterm would send, so its menus, pickers and question dialogs
   * work from the box. Returns false for anything the box should handle.
   */
  private forwardEmptyBoxKey(e: KeyboardEvent): boolean {
    if (!this.composeFirstEngaged || this.ptyId === null) return false;
    if (e.metaKey || e.ctrlKey || e.altKey) return false;
    const seq = this.composeKeySequence(e);
    if (seq === null) return false;
    window.patton.pty.write(this.ptyId, seq);
    this.terminalView.terminal.scrollToBottom(); // as xterm's scrollOnUserInput would
    rlog('info', '[COMPOSE] handoff', {
      pane: this.id, key: e.shiftKey ? `Shift+${e.key}` : e.key, route: 'pty',
    });
    return true;
  }

  private composeKeySequence(e: KeyboardEvent): string | null {
    // Cursor keys follow DECCKM, as xterm's own keyboard handling does.
    const cursor = this.terminalView.terminal.modes.applicationCursorKeysMode ? '\x1bO' : '\x1b[';
    if (e.key === 'Tab') return e.shiftKey ? '\x1b[Z' : '\t'; // Shift+Tab cycles Claude's modes
    if (e.shiftKey) return null; // Shift+Enter is a newline in the box
    switch (e.key) {
      case 'ArrowUp': return cursor + 'A';
      case 'ArrowDown': return cursor + 'B';
      case 'ArrowRight': return cursor + 'C';
      case 'ArrowLeft': return cursor + 'D';
      case 'Home': return cursor + 'H';
      case 'End': return cursor + 'F';
      case 'PageUp': return '\x1b[5~';
      case 'PageDown': return '\x1b[6~';
      case 'Enter': return '\r';
      case 'Escape': return '\x1b';
      default: return null;
    }
  }

  private composeMaxHeight(): number {
    if (!this.composeFirstEngaged) return Pane.COMPOSE_DEFAULT_MAX_PX;
    const share = Math.floor(this.element.clientHeight * Pane.COMPOSE_FIRST_MAX_FRACTION);
    return Math.max(Pane.COMPOSE_FIRST_MIN_PX, share);
  }

  isComposeExpanded(): boolean {
    return !this.editorContainer.classList.contains('collapsed');
  }

  expandCompose(): void {
    // ⌘E after dismissing the compose-first box brings compose-first back.
    if (this.composeFirstEffective && this.claudeActive && !this.composeFirstEngaged) {
      this.composeDismissed = false;
      this.engageComposeFirst('expand');
      this.editorInput.focus();
      return;
    }
    this.editorContainer.classList.remove('collapsed');
    this.editorInput.focus();
  }

  collapseCompose(): void {
    if (this.composeFirstEngaged) {
      this.composeDismissed = true;
      this.disengageComposeFirst('dismissed');
      this.terminalView.focus();
      return;
    }
    this.editorContainer.classList.add('collapsed');
    this.terminalView.focus();
  }

  toggleCompose(): void {
    // Compose-first box open but the keyboard elsewhere (handed off): ⌘E
    // brings the keyboard back to it; only ⌘E from inside the box closes it.
    if (this.composeFirstEngaged && !this.editorInput.hasFocus()) {
      this.composeHandedOff = false;
      rlog('info', '[COMPOSE] reclaim', { pane: this.id, reason: 'toggle-key' });
      this.editorInput.focus();
      return;
    }
    if (this.isComposeExpanded()) {
      this.collapseCompose();
    } else {
      this.expandCompose();
    }
  }

  setProcessName(name: string): void {
    this.title = name || 'Terminal';
    this.callbacks.onTitleChange(this);
  }

  showHistorySearch(): void {
    if (this.historySearch.isVisible()) {
      this.historySearch.hide();
      this.terminalView.focus();
    } else {
      this.historySearch.show(this.historyManager.getEntries());
    }
  }

  focus(): void {
    if (this.isComposeExpanded() && !this.composeHandedOff && !Pane.isOverlayFocused()) {
      this.editorInput.focus();
    } else {
      this.terminalView.focus();
    }
  }

  show(): void {
    this.element.style.display = 'flex';
    this.terminalView.fit();
    // Always: a resize skipped while the tab was hidden (display:none) is redone here.
    this.editorInput.refreshSize();
  }

  hide(): void {
    this.element.style.display = 'none';
  }

  setFontSize(size: number): void {
    this.terminalView.setFontSize(size);
    this.editorInput.setFontSize(size);
  }

  setFontFamily(family: string): void {
    this.terminalView.setFontFamily(family);
    this.editorInput.setFontFamily(family);
  }

  setScrollback(lines: number): void {
    this.terminalView.setScrollback(lines);
  }

  /** A broadcast paste from another pane: through this terminal, so its own
   *  bracketed-paste mode decides the wrapping. */
  pasteBroadcast(text: string): void {
    if (this.ptyId === null || this.disposed) return;
    this.terminalView.terminal.paste(stripPasteControls(text));
  }

  setCopyOnSelect(enabled: boolean): void {
    this.terminalView.setCopyOnSelect(enabled);
  }

  setRenderer(mode: 'webgl' | 'dom'): void {
    this.terminalView.setUseWebgl(mode === 'webgl');
  }

  getScrollbackContent(): string {
    return this.terminalView.getScrollbackContent();
  }

  setTerminalTheme(theme: ITheme | null): void {
    this.terminalView.setCustomTheme(theme);
  }

  jumpToPrompt(direction: 'up' | 'down'): void {
    this.terminalView.jumpToPrompt(direction);
  }

  private setupDragHandle(handle: HTMLElement): void {
    let dragging = false;
    let overlay: HTMLElement | null = null;

    const onMouseDown = (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      dragging = true;

      // Create a floating overlay to indicate dragging
      overlay = document.createElement('div');
      overlay.className = 'pane-drag-overlay';
      overlay.textContent = this.title;
      overlay.style.left = `${e.clientX - 40}px`;
      overlay.style.top = `${e.clientY - 16}px`;
      document.body.appendChild(overlay);

      this.element.classList.add('dragging');
      document.body.style.cursor = 'grabbing';
      document.body.style.userSelect = 'none';
    };

    const onMouseMove = (e: MouseEvent) => {
      if (!dragging || !overlay) return;
      overlay.style.left = `${e.clientX - 40}px`;
      overlay.style.top = `${e.clientY - 16}px`;

      // Highlight the pane under the cursor as a drop target
      const target = document.elementFromPoint(e.clientX, e.clientY);
      const targetPane = target?.closest('.pane');
      // Clear all drop targets, then set the new one
      for (const el of document.querySelectorAll('.pane.drop-target')) {
        if (el !== targetPane || el === this.element) {
          el.classList.remove('drop-target');
        }
      }
      if (targetPane && targetPane !== this.element) {
        targetPane.classList.add('drop-target');
      }
    };

    const onMouseUp = (e: MouseEvent) => {
      if (!dragging) return;
      dragging = false;

      // Clean up overlay
      overlay?.remove();
      overlay = null;
      this.element.classList.remove('dragging');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';

      // Clear all drop targets
      for (const el of document.querySelectorAll('.pane.drop-target')) {
        el.classList.remove('drop-target');
      }

      // Find the target pane under the cursor
      const target = document.elementFromPoint(e.clientX, e.clientY);
      const targetPane = target?.closest('.pane');
      if (targetPane && targetPane !== this.element && targetPane.id) {
        // Dispatch a custom event on the tab content to signal a swap
        this.element.dispatchEvent(new CustomEvent('pane-swap', {
          bubbles: true,
          detail: { sourceId: this.id, targetId: targetPane.id },
        }));
      }
    };

    handle.addEventListener('mousedown', onMouseDown);
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    this.disposables.push(
      () => handle.removeEventListener('mousedown', onMouseDown),
      () => document.removeEventListener('mousemove', onMouseMove),
      () => document.removeEventListener('mouseup', onMouseUp),
    );
  }

  setFocused(focused: boolean): void {
    this._isFocused = focused;
    this.element.classList.toggle('focused', focused);
  }

  getCwd(): string {
    return this.currentCwd;
  }

  clear(): void {
    this.terminalView.clear();
  }

  dispose(): void {
    this.disposed = true;
    if (this.resizeTimer) clearTimeout(this.resizeTimer);
    this.clearPasteChips();
    for (const d of this.disposables) d();
    if (this.ptyId !== null && !this.ptyExited) {
      window.patton.pty.destroy(this.ptyId);
    }
    this.searchOverlay.dispose();
    this.historySearch.dispose();
    this.pasteDialog.dispose();
    this.contextMenu.dispose();
    this.editorInput.dispose();
    this.terminalView.dispose();
    this.element.remove();
  }
}
