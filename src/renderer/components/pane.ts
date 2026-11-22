import { TerminalView, type ProgramStatusEvent } from './terminal-view';
import type { ContextReading, PattonState } from '../services/patton-osc';
import { EditorInput, DEFAULT_COMPOSE_PLACEHOLDER } from './editor-input';
import { SearchOverlay } from './search-overlay';
import { HistorySearch } from './history-search';
import { PasteDialog } from './paste-dialog';
import { ContextMenu } from './context-menu';
import { HistoryManager } from '../services/history-manager';
import { FileLinkProvider } from '../services/file-link-provider';
import { createOsc8LinkHandler } from '../services/osc8-links';
import { rlog } from '../services/renderer-logger';
import { WAKE_TITLE } from '../services/board-wake';
import { announce } from '../services/announcer';
import { stripPasteControls } from '../services/paste-sanitize';
import { dropTarget, dropText, isFileDrag } from '../services/file-drop';
import { shouldConfirmMultilinePaste } from '../services/paste-confirm';
import { PATTON_QUOTES } from '../../shared/constants';
import { shortcutKeys } from '../../shared/shortcuts';
import type { CheckpointSource } from '../services/checkpoint-clock';
import {
  ProgramStatusRecords, isClaudeProgram, programSignal, rankProgram, shownText,
  type BlockedKind, type ProgramSignal, type ProgramState,
} from '../services/program-status';
import { paneActivity, type PaneActivity } from '../services/pane-activity';
import {
  turnEndSignal, verdictAfterRootChange, verdictAfterChildren, turnEndedOverWork, turnEndedAfterChange, endedTurnSignal,
  type HookVerdict,
} from '../services/turn-end';

import type { ITheme } from '@xterm/xterm';
import type { TabFlag, UnsentInputState } from '../../shared/types';
import type { PauseInput } from '../services/pause-all';
import {
  COMPOSE_ASIDE_HINT, COMPOSE_ASIDE_HOLD_MS, COMPOSE_ASIDE_LABEL, COMPOSE_SEND_HELD_LABEL, COMPOSE_SEND_HELD_MS,
  composeAsideReason, composeKeyboardWaitMs, composeBackTakesKeyboard, composeBlockedFact, isMenuLine,
  type ComposeAsideReason,
} from '../services/compose-aside';
import { readClaudeBar, type BarMissReason } from '../services/claude-bar';
import {
  COMPOSE_BAR_LOST_MS, COMPOSE_BAR_NOT_FOUND_LOG_MS, COMPOSE_OVERLAY_MAX_FRACTION, COMPOSE_OWN_TYPING_MS,
  COMPOSE_ROOM_HOLD_MS, COMPOSE_SETTLE_MAX_MS, COMPOSE_SETTLED_LOG_MS, COMPOSE_SWITCH_MIN_MS,
  barRowsInView, placementForReading,
  type ComposePlacement, type ComposePlacementReason,
} from '../services/compose-placement';
import { composeRoomRows } from '../services/compose-room';
import { onUiTextScaleApplied } from '../services/ui-text-scale';
import { SessionBarModel, stopListsOf, type ModelNote, type StopState } from '../services/session-bar-model';
import { SessionFeedWatch } from '../services/session-feed-watch';
import type { SessionFeedEvent } from '../../shared/session-feed';

/** Background work a parked Claude Code session is waiting on: from the Stop
 *  hook (tasks + crons), or from OSC 7501 child records (tasks + their titles,
 *  untrusted text, shown only as text). */
export interface ParkedInfo {
  tasks: number;
  crons: number;
  titles?: string[];
}

/** Where a pane's Claude state comes from: Claude Code's own OSC 7501 reports
 *  once it has sent one (authoritative), else its title glyphs plus the Stop
 *  hook's verdict (the fallback, unchanged). */
export type ClaudeStateSource = '7501' | 'title';

/** One pane's Claude Code state, whichever source it came from. */
export interface ClaudeState {
  source: ClaudeStateSource;
  /** Claude Code runs in this pane (on the 7501 path: it reports
   *  `app=claude-code`; another program's reports leave this false). */
  active: boolean;
  /** Mid-turn (7501 `working`, or a ◐/◑ title). */
  working: boolean;
  /** Waiting on a permission, a question, a login or a dialog (7501 only). */
  blocked: boolean;
  /** The 7501 root state, null on the title path. */
  root: ProgramState | null;
  /** Why the pane last raised "needs you" (7501 only), as plain text. */
  needsYouText: string | null;
  parked: ParkedInfo | null;
  /** Claude's own title for the session (7501 root `title`), untrusted text. */
  title: string | null;
  /** What a blocked root waits on (7501 `kind`, `msg`), untrusted text. */
  blockedKind: BlockedKind | null;
  msg: string | null;
  /** A background task asking for input (7501 child, blocked): its title. */
  blockedTask: string | null;
  /** What the pane is doing in one word, and since when (ms epoch). */
  activity: PaneActivity;
  since: number;
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
  /** What the checkpoint clock shows for this pane changed (Claude started or
   *  stopped running or working, or the Stop hook sent a context reading). */
  onCheckpointChange?: (pane: Pane) => void;
  /** What the pane's status shows changed (activity, root state, kind, msg,
   *  blocked task, parked, needs-you reason): the hover card re-reads it. */
  onStatusChange?: (pane: Pane) => void;
  /** An automatic tab flag from the pane's title (`WAKE` → yellow), or null to drop it. */
  onAutoFlag?: (pane: Pane, flag: TabFlag | null) => void;
  /** The pane's "checkpoint finished" mark was set or cleared (checkpointDone). */
  onCheckpointMark?: (pane: Pane) => void;
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

/** A pasted image's thumbnail: its strip chip (with ×), and what the box draws (D14). */
interface PasteChipEntry {
  el: HTMLElement;
  label: string;
  dataUrl: string;
  timer: ReturnType<typeof setTimeout>;
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
  // The PTY id a respawn is replacing, from the moment it starts: its output
  // and exit are dropped (its buffered tail is flushed ahead of main's reply
  // and would otherwise land in the new shell's terminal).
  private replacingPtyId: number | null = null;
  private replacedPtyExited = false;
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
  // What this pane's shell has shown since its PTY was created, kept because
  // an OSC 133 event is not replayed to a late listener (see shellProgress).
  private shellStartedAt = 0;
  private shellSawSignal = false;
  private shellSawFirstPrompt = false;
  private startedShell = '';
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
  // True once Claude Code has reported (OSC 7501) or a Claude title glyph
  // (◐ ◑ ✳) has been seen since the shell's last prompt: Claude Code is
  // running in this pane, so image pastes go to it as Ctrl+V (it reads the
  // clipboard itself) instead of as a file path.
  private claudeActive = false;
  /** What the session bar shows for this pane (docs/session-bar.md D3–D6). */
  readonly sessionBarModel = new SessionBarModel();
  /** The pty main's transcript feed follows for this pane, null when none. */
  private feedPtyId: number | null = null;
  /** The transcript path last passed to main as a hint (from a Stop's `tp`). */
  private feedTranscriptHint: string | null = null;
  /** The watch() calls to main: one retry on a refusal (I), a re-watch on a
   *  7501 Claude report while unattached (F). */
  private readonly feedWatch = new SessionFeedWatch({
    api: () => window.patton.sessionFeed,
    current: () => (this.disposed ? null : this.feedPtyId),
    log: (level, msg, data) => rlog(level, msg, { pane: this.id, ...data }),
  });
  private barRowsLoggedAtMs = 0;
  private barRowsTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly BAR_ROWS_LOG_MS = 60_000;
  // Claude Code's own status (OSC 7501, services/program-status.ts). Once a
  // pane has had a report, it is the only source: Claude stops putting its
  // glyph in the title, so the title path stands aside, and the Stop hook's
  // tasks/crons verdict no longer decides the dot (it is kept only to turn a
  // plain done into the ring, see hookVerdict; its context reading is used). A
  // bare `state=clear` (Claude exiting), a full reset or the shell's next
  // prompt drops the records and hands the pane back to the title path.
  // claudeActive / claudeWorking / claudeBlocked / parked are the state both
  // sources write and every consumer reads (see `claudeState`).
  private programStatus = new ProgramStatusRecords();
  private statusReporting = false;
  private claudeBlocked = false;
  private lastProgramSignal: ProgramSignal = { kind: 'none' };
  private lastProgramLogKey = '';
  private lastIgnoredLogMs = 0;
  private needsYouText: string | null = null;
  // The Stop hook's verdict (tasks + crons) while 7501 reports, and when the
  // root last turned done. 7501 does not see every background task or timer
  // (8 Nov 2026: root done, no child records, hook said 2 tasks running, and
  // the dot went green), so a done root with no working child is parked when
  // the verdict reported work and came within the verdict TTL of the done
  // (either order): turnEndSignal. A verdict belongs to one turn: it is
  // cleared when the root enters `working` from another state, and when the
  // last working child finishes under a done root (the drain must alert).
  // A Stop over a root still working with working children (a subagent) is
  // the turn end itself: see turnEnded.
  // Known and left: a verdict landing after the dot was raised only re-parks
  // within the TTL; the hook preceded the done in all 206 logged verdicts.
  private hookVerdict: HookVerdict | null = null;
  // The turn ended (Stop hook) while 7501 still says the root works with
  // working children: Claude Code 2.1.321 does that for as long as a subagent
  // it launched runs, and sends no done at all (22 Nov 2026, House tab). The
  // pane shows the ring until a new turn: any change of the root or of the
  // working children (turnEndedAfterChange), or his own send
  // (noteTurnSubmitted). See endedTurnSignal. Known and left: when another
  // Stop hook blocks that stop, Claude carries on under the ring until its
  // next Stop or a child changes (Patton's hook can't see the block).
  private turnEnded = false;
  private lastWorkingChildren = 0;
  private rootDoneAtMs: number | null = null;
  private lastRootState: ProgramState | null = null;
  private lastStatusKey = '';
  // What the pane is doing and since when (see noteActivity): the hover
  // card's "Working · 2 min". Starts as a shell at creation.
  private lastActivity: PaneActivity = 'shell';
  private stateSince = Date.now();
  // Root done and its last child task just finished: Claude usually wakes to
  // read the task's result, so give it a moment to report working before
  // calling it a stop. Unmeasured; the [7501] state lines are the data.
  private static readonly PARKED_DRAIN_SETTLE_MS = 4000;
  private static readonly IGNORED_LOG_INTERVAL_MS = 5000;
  // The checkpoint clock's reading for this Claude session (Stop hook, OSC 777
  // `ctx=…;since=…[;cpt=…][;cpd=…]`); null until the first one, and cleared when
  // Claude stops running here. See services/checkpoint-clock.ts.
  private ctxTokens: number | null = null;
  private sinceTokens: number | null = null;
  private checkpointAt: number | null = null;
  private lastCheckpointKey = '';
  // The newest finished checkpoint (`cpd`) the user has SEEN this Claude
  // session (the tab selected while its mark was up, or a pre-session value
  // taken as the baseline; not the clock's `cpt` above), whether a /checkpoint finished since he last
  // looked (the tab's red circle), and the newest `cpd` that mark stands for.
  // The first and the last reset with the session.
  private ackedCheckpointAt: number | null = null;
  private _checkpointDone = false;
  private markedCheckpointAt: number | null = null;
  // The `cpt` whose finish was last logged as held back by background work
  // (one `[CKPT] finish held` line per checkpoint); reset with the session.
  private heldLoggedCheckpointAt: number | null = null;
  // A Stop-hook message (OSC 777) arrived since the last ◐ onset: the turn
  // ended on its own, so Claude's prompt is open. A question or permission
  // dialog also shows ✳ but fires no Stop hook, so ✳ alone is not enough.
  private stopSeenSinceWork = false;
  // When that Stop-hook message came (Date.now): user input after it (main's
  // unsent-input tracker) means the open prompt may since have become a
  // picker or a draft, so Pause all no longer trusts stopSeenSinceWork.
  private stopSeenAtMs = 0;
  // Pause all's view of the session (services/pause-all.ts):
  // - claudeSessionAtMs: when the current session began (Date.now), so a
  //   Ctrl+S the user pressed in an earlier session doesn't count as a stash
  //   held by this one. Restarted when Claude leaves (a bare 7501
  //   `state=clear`, the shell's prompt, the title losing its glyph) and when
  //   the shell is replaced.
  // - hadTurn: since 7501 reports began, the root has been something other
  //   than idle (a session that has only ever said idle is fresh).
  // - lastSignalAtMs: the last 7501 report or Stop-hook message (Date.now),
  //   the proof that a `/` command typed before it isn't still showing a menu.
  private claudeSessionAtMs = 0;
  private hadTurn = false;
  private lastSignalAtMs = 0;
  private disposed = false;

  // --- Compose-first (Claude Code tabs) ---
  // The Settings value and the tab's session-only override (null = follow
  // the setting); the effective mode is override ?? setting.
  private composeFirstSetting = false;
  private composeFirstOverride: boolean | null = null;
  // Engaged: the box is open because Claude Code runs here in compose-first
  // mode. Nothing is guessed: Claude's presence is claudeActive (its 7501
  // reports, else its title glyph), and the box takes focus only on engage, after a submit, and when
  // Claude starts working again after a hand-off.
  private composeFirstEngaged = false;
  // The user gave the keyboard to the terminal (Esc in a non-empty box, or a
  // click in the terminal); nothing refocuses the box until Claude's next ◐.
  private composeHandedOff = false;
  // The user closed the box (⌘E) while engaged: it stays shut until Claude
  // exits or the mode changes, instead of reopening at the next title.
  private composeDismissed = false;
  // The box stepped aside (services/compose-aside.ts): 'blocked' while Claude
  // asks something (held COMPOSE_ASIDE_HOLD_MS), 'menu' after a `/` line from
  // the box until Claude's next report or Stop hook. Dimmed, draft kept, the
  // keyboard on the terminal; composeAsideAtMs is when it stepped aside.
  private composeAside: ComposeAsideReason | null = null;
  private composeAsideAtMs = 0;
  private composeBlockedTimer: ReturnType<typeof setTimeout> | null = null;
  private composeBlockedHeld = false;
  private composeMenuPending = false;
  // When the box last had a keydown, and the timer that moves the keyboard to
  // the terminal once a 'blocked' aside finds him mid-typing (D2).
  private composeLastKeydownMs = 0;
  private composeKeyboardTimer: ReturnType<typeof setTimeout> | null = null;
  // Sends held while Claude asks: `[COMPOSE] send held` at most once a
  // second, carrying how many were held since the last line (key repeat).
  private composeHeldSince = 0;
  private composeHeldLoggedMs = 0;
  private static readonly COMPOSE_HELD_LOG_MS = 1000;
  private static readonly COMPOSE_FIRST_PLACEHOLDER =
    'Message Claude · Enter sends · Shift+Enter newline · Esc interrupts';
  private static readonly COMPOSE_FIRST_MAX_FRACTION = 0.4; // of the pane's height
  private static readonly COMPOSE_FIRST_MIN_PX = 60;
  private static readonly COMPOSE_DEFAULT_MAX_PX = 200;
  private static readonly COMPOSE_OVERLAY_CHROME_PX = 8; // editor.css: the overlay's padding and rules

  // --- One typing bar (docs/compose-box.md D8–D10, D12) ---
  // The box over Claude Code's own input bar ('over'), on the terminal's
  // bottom edge when scrolled up ('dock'), or under the terminal ('under').
  // Shown as the pane's data-compose-placement and the box's
  // placement-over / placement-dock classes (services/compose-placement.ts).
  private composeOverBarSetting = true;
  private composePlacement: ComposePlacement = 'under';
  // The last reading that found Claude's bar empty: its absolute row and when.
  private barRow = -1;
  private barLastMatchMs: number | null = null;
  // When the current run of counting misses began (null: no run). D8: the
  // 400 ms before `under` count from the first miss, never from the last
  // match, since a still screen takes no readings and the last match may be
  // seconds old. Cleared on a match, when an aside ends and on disengage.
  private barMissSinceMs: number | null = null;
  // The reason a lost bar logs: 'aside-end' while the 400 ms after an aside
  // runs (D10), otherwise 'lost'.
  private barLostReason: 'lost' | 'aside-end' = 'lost';
  private barLastMissWhy: BarMissReason = 'no-glyph';
  // The last reading that counted toward the lost wait held text (the box
  // goes under with reason holds-text) rather than missing the bar (lost).
  private barWaitHoldsText = false;
  // When this pane last typed into Claude itself (a send from the box):
  // readings within COMPOSE_OWN_TYPING_MS of it never count
  // toward the lost wait (D9 as amended).
  private composeOwnTypingMs = -Infinity;
  // D9, no loop: when Patton last refitted the terminal for a change between
  // `under` and the overlays (the refit opens a settling, composeSettle, in
  // which misses don't count toward the lost wait), and when a reading last
  // made such a change (the next waits COMPOSE_SWITCH_MIN_MS).
  private composeRefitMs = -Infinity;
  private composeSwitchMs = -Infinity;
  // What the overlay was last laid out from (see layoutComposeOverlay).
  private overlayLayoutKey = '';
  // The overlay's height cap as last laid out (px): a third of the pane, or
  // the room from its top edge to the pane's bottom if less. 0 under.
  private overlayMaxPx = 0;
  // D15: the whole rows the terminal gives up at its bottom so a long draft
  // grows down into them (k), when k last changed, and the timer that applies
  // a change D9's once-a-second rule held back.
  private composeRoomRows = 0;
  private composeRoomMs = -Infinity;
  private composeRoomTimer: ReturnType<typeof setTimeout> | null = null;
  // D15: the pane's height k was last worked out for (a height change of the
  // pane re-works it out; Patton's own padding change is not one).
  private composeRoomPaneH = 0;
  // D15, settling (S60): Patton's own resize of the terminal (room, a
  // placement change, show, a font change, a pane resize) trims Claude's
  // screen until Claude redraws after SIGWINCH: xterm pops the lines below the
  // cursor, which Claude parks on its `❯` line, so the bar's lower rule and
  // footer vanish and `barRow` is stale. From the resize until the first
  // reading that finds the bar empty after a write (Claude's redraw), or
  // COMPOSE_SETTLE_MAX_MS, misses don't count toward the lost wait, and a k
  // decision that needs the bar's row waits (composeRoomPending), then runs
  // once. An aside's end opens one too (Claude's screen moved with readings
  // frozen), ended by any empty-bar reading; its misses still count (no resize).
  private composeSettle: {
    sinceMs: number; cause: string; resize: boolean; writeSeq: number;
    // A reading found the bar empty before any write (at the ceiling, the k
    // that waited may run from it: the bar was there, Claude just didn't redraw).
    foundEarly: boolean;
  } | null = null;
  private composeSettleTimer: ReturnType<typeof setTimeout> | null = null;
  // Bumped on every parsed write: a resize's settling ends only on a reading
  // after a write that followed it (a reading straight after a resize that
  // grew the terminal still finds the bar, at its pre-redraw row).
  private composeWriteSeq = 0;
  // The k decision waiting for the settling's end: the trigger that asked
  // and which run (a room resize asks once more, run 2, to confirm k against
  // the redrawn bar; never a third time for the same trigger).
  private composeRoomPending: { reason: string; run: number } | null = null;
  // The k decision a settling's ceiling ended without a reading (Claude redrew
  // later than COMPOSE_SETTLE_MAX_MS): kept for the first empty-bar reading
  // while the box is still over or docked. It is still the non-reading
  // trigger's ask (that reading only says when the bar's row can be trusted);
  // cleared on disengage, under and a room resize, and handed to a new settling.
  private composeRoomKept: { reason: string; run: number } | null = null;
  // Anti-flap: the bar went lost within COMPOSE_ROOM_HOLD_MS of a room resize
  // and the box went under: no rows are given up again until the draft's
  // content changes. Logged once per hold, when it first refuses.
  private composeRoomHeld = false;
  private composeRoomHeldLogged = false;
  private composeRoomHeldDraft = '';
  private composeSettledLogMs = -Infinity;
  private composeSettledSkipped = 0;
  private barNotFoundLoggedMs = 0;
  private barLostTimer: ReturnType<typeof setTimeout> | null = null;
  private barReadFrame: number | null = null;
  private barViewportY = -1;
  // Placement frozen (D10): from Claude's first `blocked` report (the live
  // fact) and through any aside. Kept in step by syncComposeFreeze().
  private composePlacementFrozen = false;
  // Fractional wheel scroll carried over the box (D12), in lines.
  private composeWheelLines = 0;
  // D10: "Draft kept" at the pane's bottom right while an aside hides the box
  // in the overlays with a draft in it; announced once per aside.
  private draftNote!: HTMLElement;
  // D10: "Type here", in the note's place during a `menu` aside in the overlays.
  private typeHereButton!: HTMLButtonElement;
  private draftNoteAnnounced = false;

  // --- Pasted-image thumbnails (see pasteImage) ---
  private static readonly PASTE_CHIP_TTL_MS = 10 * 60 * 1000;
  private static readonly PASTE_CHIP_MAX = 6;
  /** D14: thumbnails inside the box (more than this many: the first ones and a "+N"). */
  private static readonly BOX_IMAGES_SHOWN = 3;
  private pasteStrip!: HTMLElement;
  /** D14: the thumbnails inside the box, left of the text, while it is engaged. */
  private boxImages!: HTMLElement;
  private pasteChips: PasteChipEntry[] = [];

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

  private fireCommandDone(source: 'osc133' | 'claude' | 'bell' | 'osc9' | 'hook' | '7501'): void {
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
    // Claude Code reports its state itself here (OSC 7501) and has dropped
    // the glyph from its title: the title says nothing about it.
    // Known gap: while reporting, the safety net below (a title with no glyph
    // means Claude is gone) is off. A Claude that is killed without sending
    // `state=clear`, in a pane without OSC 133 shell integration (fish, or
    // integration off), keeps its last 7501 state until the next prompt,
    // RIS or report.
    if (this.statusReporting) return;
    // A title with neither glyph means Claude is gone (fish, or shell
    // integration off, never sends the OSC 133 prompt that would clear this).
    const active = Pane.CLAUDE_WORKING.test(title) || Pane.CLAUDE_STOPPED.test(title);
    if (this.claudeActive && !active) this.newClaudeSession();
    if (!this.claudeActive && active) this.claudeSessionAtMs = Date.now();
    this.claudeActive = active;
    this.syncComposeFirst('title');
    try {
      this.trackClaudeWorking(title);
    } finally {
      this.notifyCheckpoint();
    }
  }

  private trackClaudeWorking(title: string): void {
    if (Pane.CLAUDE_WORKING.test(title)) {
      this.startWork(); // cancels the settle: the ✳ was only a flash between turns
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

  /** Claude started (or went back to) working, from either source. */
  private startWork(): void {
    this.cancelClaudeStop();
    // A turn has started: any menu a `/` line opened is gone (D3).
    if (this.composeMenuPending) {
      this.composeMenuPending = false;
      this.syncComposeAside('work-started');
    }
    if (this.claudeWorking) return;
    this.claudeWorking = true;
    this.stopSeenSinceWork = false;
    this.clearCheckpointDone('new turn');
    this.notifyCheckpoint();
    // A new stretch of work: the next stop is a new event, never a
    // duplicate of the last one, so it mustn't be debounced away.
    this.lastCommandDoneMs = 0;
    this.needsYouText = null;
    this.setParked(null);
    this.clearPasteChips(); // the pasted image has been sent along with the prompt
    this.callbacks.onWorkStarted?.();
    this.reclaimCompose('work-started');
  }

  /** Arm (or re-arm) the settle timer; when it fires, the stop is real. */
  private armClaudeStop(ms: number, onSettle: () => void = () => this.settleClaudeStop()): void {
    this.cancelClaudeStop();
    this.claudeStopTimer = setTimeout(() => {
      this.claudeStopTimer = null;
      onSettle();
    }, ms);
  }

  /** One OSC 7501 event from this pane's terminal. */
  private handleProgramStatus(event: ProgramStatusEvent): void {
    switch (event.type) {
      case 'probe':
        rlog('info', '[7501] probe answered', { pane: this.id });
        return;
      case 'invalid': {
        // Reasons are fixed strings, never report text. Throttled: `cat` of
        // a file full of sequences mustn't flood the log.
        const now = Date.now();
        if (now - this.lastIgnoredLogMs >= Pane.IGNORED_LOG_INTERVAL_MS) {
          this.lastIgnoredLogMs = now;
          rlog('warn', '[7501] report ignored', { pane: this.id, reason: event.reason });
        }
        return;
      }
      case 'reset':
        this.resetProgramStatus('reset');
        return;
      case 'clear':
        if (event.id === '') {
          this.resetProgramStatus('clear');
          return;
        }
        if (!this.statusReporting) return; // nothing of ours to remove
        this.programStatus.clear(event.id);
        break;
      case 'report':
        this.programStatus.set(event.id, event.record);
        break;
    }
    this.lastSignalAtMs = Date.now();
    // A report: a `/` line's menu (if any) is over (applyProgramStatus syncs the box).
    this.composeMenuPending = false;
    if (!this.statusReporting) {
      this.statusReporting = true;
      // From here on the hook's verdicts don't decide the dot; drop a stored one.
      if (this.takeVerdict()) rlog('info', '[DOT] Hook verdict dropped: 7501 reports', { pane: this.id });
    }
    this.applyProgramStatus();
  }

  /** Turn this pane's 7501 records into the pane state (see programSignal). */
  private applyProgramStatus(): void {
    const root = this.programStatus.root;
    // The bar's agents, workflows and root error come from Claude's records only.
    if (isClaudeProgram(this.programStatus)) {
      this.logBarNotes(this.sessionBarModel.applyProgramRecords(root, this.programStatus.children(), Date.now()));
    }
    const rootState = root?.state ?? null;
    if (rootState === 'done' && this.lastRootState !== 'done') this.rootDoneAtMs = Date.now();
    else if (rootState !== 'done') this.rootDoneAtMs = null;
    const kept = verdictAfterRootChange(this.hookVerdict, this.lastRootState, rootState);
    if (kept.cleared) {
      rlog('info', '[DOT] Hook verdict cleared: new turn', { pane: this.id, tasks: this.hookVerdict?.tasks, crons: this.hookVerdict?.crons });
    }
    this.hookVerdict = kept.verdict;
    const working = this.programStatus.children().filter((c) => c.record.state === 'working');
    const workingChildren = working.length;
    if (this.turnEnded && !turnEndedAfterChange(true, this.lastRootState, rootState, this.lastWorkingChildren, workingChildren)) {
      this.turnEnded = false;
      // The verdict belonged to the turn that ended; a new one has begun (or
      // the root left working, and 7501 decides that turn end itself).
      if (rootState === 'working' && this.hookVerdict) {
        rlog('info', '[DOT] Hook verdict cleared: new turn', { pane: this.id, tasks: this.hookVerdict.tasks, crons: this.hookVerdict.crons, via: 'children' });
        this.hookVerdict = null;
      }
    }
    const drained = verdictAfterChildren(this.hookVerdict, rootState, this.lastWorkingChildren, workingChildren);
    if (drained.cleared) {
      rlog('info', '[DOT] Hook verdict cleared: working children finished', { pane: this.id, tasks: this.hookVerdict?.tasks, crons: this.hookVerdict?.crons });
    }
    this.hookVerdict = drained.verdict;
    this.lastWorkingChildren = workingChildren;
    this.lastRootState = rootState;
    // Turn end: root done with no working child is parked, not "needs you",
    // when the Stop hook said tasks or timers are still running.
    const turnEnd = turnEndSignal(
      programSignal(this.programStatus), this.hookVerdict, this.rootDoneAtMs, Pane.HOOK_VERDICT_TTL_MS,
    );
    // Turn end over a still-working root (a subagent runs on): the ring too.
    const ended = endedTurnSignal(
      turnEnd.signal, this.turnEnded, this.hookVerdict, working.map((c) => shownText(c.record.title ?? c.id, 60)),
    );
    const signal = ended.signal;
    const crons = this.hookVerdict && (turnEnd.viaHook || ended.viaStop) ? this.hookVerdict.crons : 0;
    const children = this.programStatus.children().length;
    const isClaude = isClaudeProgram(this.programStatus);
    const logKey = [rootState, root?.kind, children, signal.kind, crons, isClaude].join('|');
    if (logKey !== this.lastProgramLogKey) {
      this.lastProgramLogKey = logKey;
      rlog('info', '[7501] state', {
        pane: this.id, root: rootState, kind: root?.kind ?? null, children, signal: signal.kind,
        crons, app: isClaude ? 'claude-code' : 'other',
      });
    }
    const previous = this.lastProgramSignal;
    this.lastProgramSignal = signal;
    // Only Claude Code's reports make this a Claude pane (image paste as
    // Ctrl+V, compose-first, /checkpoint); another program's still drive the
    // dot and ring below.
    if (this.claudeActive && !isClaude) this.newClaudeSession();
    if (!this.claudeActive && isClaude) this.claudeSessionAtMs = Date.now();
    this.claudeActive = isClaude;
    if (isClaude) this.feedWatch.claudeReport();
    this.claudeBlocked = rootState === 'blocked';
    if (rootState !== null && rootState !== 'idle') this.hadTurn = true;
    try {
      if (signal.kind === 'working') {
        this.startWork();
        return;
      }
      this.claudeWorking = false;
      if (signal.kind === 'parked') {
        this.cancelClaudeStop();
        const info: ParkedInfo = { tasks: signal.tasks, crons: signal.crons ?? 0, titles: signal.titles };
        if (previous.kind !== 'parked' || previous.tasks !== signal.tasks || previous.crons !== signal.crons) {
          const source = ended.viaStop ? 'hook-root-working'
            : !turnEnd.viaHook ? '7501' : signal.tasks > 0 ? 'hook-tasks' : 'hook-crons';
          rlog('info', '[DOT] Parked', { pane: this.id, tasks: signal.tasks, crons: info.crons, source });
        }
        // A needs-you raised before a late verdict is withdrawn with it.
        this.needsYouText = null;
        this.setParked(info);
      } else if (signal.kind === 'needs-you') {
        this.setParked(null);
        // The same wait again (a child record changed under a blocked root, a
        // late `msg` on done, a prompt whose text changed): never a second
        // alert. If it was already raised, only its reason is refreshed; if
        // it is still settling, the settle reads the latest signal.
        if (previous.kind === 'needs-you' && previous.key === signal.key) {
          if (this.needsYouText !== null && this.needsYouText !== signal.reason) {
            this.needsYouText = signal.reason;
            this.noteActivity();
          }
          return;
        }
        const wait = previous.kind === 'parked' ? Pane.PARKED_DRAIN_SETTLE_MS : Pane.CLAUDE_STOP_SETTLE_MS;
        this.armClaudeStop(wait, () => this.settleProgramStop());
      } else {
        this.cancelClaudeStop();
        this.setParked(null);
      }
    } finally {
      this.syncComposeFirst('7501');
      this.notifyCheckpoint();
    }
  }

  /** A 7501 "needs you" has held for the settle: raise it, reason as text. */
  private settleProgramStop(): void {
    const signal = this.lastProgramSignal;
    if (signal.kind !== 'needs-you') return;
    this.needsYouText = signal.reason;
    this.noteActivity();
    this.fireCommandDone('7501');
  }

  /** Drop every 7501 record and hand the pane back to the title path. */
  private resetProgramStatus(reason: 'clear' | 'reset' | 'shell-prompt'): void {
    const wasReporting = this.statusReporting;
    this.programStatus.clear();
    this.statusReporting = false;
    this.lastProgramSignal = { kind: 'none' };
    this.lastProgramLogKey = '';
    this.claudeBlocked = false;
    this.needsYouText = null;
    this.hookVerdict = null;
    this.turnEnded = false;
    this.rootDoneAtMs = null;
    this.lastRootState = null;
    this.lastWorkingChildren = 0;
    this.hadTurn = false;
    this.sessionBarModel.applyProgramRecords(null, [], Date.now());
    if (!wasReporting) return;
    // Claude left (a bare `state=clear`, the shell's prompt). A full reset
    // (RIS) alone doesn't end the session.
    if (reason !== 'reset' && this.claudeActive) this.newClaudeSession();
    rlog('info', '[7501] state', { pane: this.id, root: 'clear', kind: null, children: 0, reason });
    this.claudeWorking = false;
    this.claudeActive = false;
    this.cancelClaudeStop();
    this.setParked(null);
    this.syncComposeFirst('7501-clear');
    this.notifyCheckpoint();
  }

  /** This pane's Claude Code state: the one API every consumer reads. */
  get claudeState(): ClaudeState {
    const root = this.programStatus.root;
    const blockedTask = this.blockedTaskTitle();
    return {
      source: this.statusReporting ? '7501' : 'title',
      active: this.claudeActive,
      working: this.claudeWorking,
      blocked: this.claudeBlocked,
      root: root?.state ?? null,
      needsYouText: this.needsYouText,
      parked: this.parked,
      title: root?.title ?? null,
      blockedKind: root?.kind ?? null,
      msg: root?.msg ?? null,
      blockedTask,
      activity: this.currentActivity(),
      since: this.stateSince,
    };
  }

  /** The background task (7501 child) blocked on input, by title (else id),
   *  when it is what the pane stands on: a root dialog outranks it, as for
   *  the dot (rankProgram). */
  private blockedTaskTitle(): string | null {
    if (!this.statusReporting) return null;
    const standing = rankProgram(this.programStatus);
    return standing.kind === 'task-blocked' ? (standing.record.title ?? standing.id) : null;
  }

  private currentActivity(): PaneActivity {
    return paneActivity({
      active: this.claudeActive || this.statusReporting,
      working: this.claudeWorking,
      // A turn that ended over a still-working root stands on its ring.
      standing: !this.statusReporting ? null
        : this.turnEnded && this.parked ? 'parked' : rankProgram(this.programStatus).kind,
      parked: this.parked !== null,
    });
  }

  /** Restart the "for how long" clock when the pane's activity changes, and
   *  tell the tab when anything the hover card shows about it changed, for
   *  every pane, focused or not. The one place `stateSince` is written:
   *  called from notifyCheckpoint, which every working/blocked/active/7501
   *  transition reaches, setParked and the needs-you reason. */
  private noteActivity(): void {
    const activity = this.currentActivity();
    if (activity !== this.lastActivity) {
      this.lastActivity = activity;
      this.stateSince = Date.now();
    }
    const root = this.programStatus.root;
    const parked = this.parked;
    const key = JSON.stringify([
      activity, root?.state ?? null, root?.kind ?? null, root?.msg ?? null, root?.title ?? null,
      this.blockedTaskTitle(), parked ? [parked.tasks, parked.crons, parked.titles ?? []] : null,
      this.needsYouText,
    ]);
    if (key === this.lastStatusKey) return;
    this.lastStatusKey = key;
    this.callbacks.onStatusChange?.(this);
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
    // Claude Code reports its own state here, so the verdict is not the dot's
    // source; it is kept for this turn's end, where it turns a "done" that
    // 7501 shows no work behind into the ring (applyProgramStatus). The hook
    // does not see everything 7501 does, nor the reverse: 7501 child records
    // missed running tasks and timers in the field.
    if (this.statusReporting) {
      rlog('info', '[DOT] Hook verdict kept: 7501 reports', { pane: this.id, tasks, crons });
      this.hookVerdict = { tasks, crons, atMs: Date.now() };
      // A verdict after the done re-evaluates the turn end whatever it says:
      // work > 0 turns a settling needs-you into the ring, 0 / 0 turns a ring
      // back into needs-you (alerting once; an unchanged needs-you is a no-op
      // in applyProgramStatus). While the root works it is simply stored.
      if (this.lastRootState === 'done') this.applyProgramStatus();
      // Claude Code keeps the root working after the turn while a subagent
      // runs (no done follows): the turn has ended all the same, so the ring.
      else if (turnEndedOverWork(this.lastRootState, this.lastWorkingChildren)) {
        rlog('info', '[DOT] Turn ended over a working root', { pane: this.id, tasks, crons, children: this.lastWorkingChildren });
        this.turnEnded = true;
        this.applyProgramStatus();
      }
      return;
    }
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

  /** The Stop hook's context reading for the checkpoint clock. Never touches
   *  the dot: a verdict, if any, went through handleHookStop. */
  private handleContextReading(context: ContextReading): void {
    this.ctxTokens = context.ctxTokens;
    this.sinceTokens = context.sinceTokens;
    this.checkpointAt = context.checkpointAt;
    rlog('info', '[CKPT] ctx', {
      pane: this.id, ctx: context.ctxTokens, since: context.sinceTokens, cpt: context.checkpointAt,
      cpd: context.checkpointDoneAt,
    });
    // `cpt` drives the clock and hover card; the red circle follows `cpd`.
    this.noteCheckpointFinished(context.checkpointDoneAt);
    this.notifyCheckpoint();
  }

  /** A /checkpoint in this session has finished: the hook reports `cpd` (the
   *  checkpoint's start time) only at a Stop with none of its own background
   *  work in flight, and never for a checkpoint that was interrupted before
   *  its commit step, so the first Stop after a start no longer counts as its
   *  finish (18 Nov 2026: red too early, then green at the real finish). Only
   *  a `cpd` newer than the last one he has seen AND not older than the
   *  session counts (a relaunch or `claude --resume` carries the transcript's
   *  old checkpoint, which only becomes the baseline). Whole seconds, as the
   *  hook reports them. Deduped on "he has seen it", not "reported once": a
   *  finished checkpoint's mark can be cleared by a new turn and the next
   *  Stop carries the same `cpd`, and the mark must come back then. */
  private noteCheckpointFinished(cpd: number | null): void {
    if (cpd === null || this.claudeSessionAtMs === 0) return;
    // `cpd` is floored to the second and the session start is stamped tens of
    // ms after the transcript's own, so one second of slack: a session whose
    // first command is /checkpoint must not lose to a second boundary.
    if (cpd < Math.floor(this.claudeSessionAtMs / 1000) - 1) {
      this.ackedCheckpointAt = Math.max(this.ackedCheckpointAt ?? -Infinity, cpd);
      return;
    }
    if (cpd <= (this.ackedCheckpointAt ?? -Infinity)) return;
    this.markedCheckpointAt = Math.max(this.markedCheckpointAt ?? -Infinity, cpd);
    if (this._checkpointDone) return;
    this._checkpointDone = true;
    rlog('info', '[CKPT] finished', { pane: this.id, cpd });
    this.callbacks.onCheckpointMark?.(this);
  }

  /** A checkpoint finished here and the user hasn't looked yet (red circle). */
  get checkpointDone(): boolean {
    return this._checkpointDone;
  }

  /** Drop the red mark: the tab was selected, a new turn began, or the Claude
   *  session ended. A no-op when it isn't set. */
  clearCheckpointDone(reason: 'selected' | 'new turn' | 'new session' | 'active tab'): void {
    if (!this._checkpointDone) return;
    this._checkpointDone = false;
    // Seen: selecting the tab, or the mark landing on the tab he is on. A new
    // turn or session is not him looking, so the next Stop may raise it again.
    if ((reason === 'selected' || reason === 'active tab') && this.markedCheckpointAt !== null) {
      this.ackedCheckpointAt = Math.max(this.ackedCheckpointAt ?? -Infinity, this.markedCheckpointAt);
    }
    this.markedCheckpointAt = null;
    rlog('info', '[CKPT] finished mark cleared', { pane: this.id, reason });
    this.callbacks.onCheckpointMark?.(this);
  }

  /** Tell the tab when what the checkpoint clock shows has changed. A pane
   *  no longer running Claude forgets its reading first, so the next session
   *  starts at "✓ —". */
  private notifyCheckpoint(): void {
    this.noteActivity();
    this.syncSessionFeed();
    if (!this.claudeActive) {
      this.ctxTokens = null;
      this.sinceTokens = null;
      this.checkpointAt = null;
    }
    const key = [this.claudeActive, this.claudeWorking, this.claudeBlocked, this.checkpointReady, this.ctxTokens, this.sinceTokens, this.checkpointAt].join('|');
    if (key === this.lastCheckpointKey) return;
    this.lastCheckpointKey = key;
    this.callbacks.onCheckpointChange?.(this);
  }

  /** What the checkpoint clock needs from this pane. */
  get checkpointSource(): CheckpointSource {
    return {
      claudeActive: this.claudeActive,
      // A permission prompt or question (7501 `blocked`) can't take a typed
      // /checkpoint either.
      claudeWorking: this.claudeWorking || this.claudeBlocked,
      ready: this.checkpointReady,
      ctxTokens: this.ctxTokens,
      sinceTokens: this.sinceTokens,
      checkpointAt: this.checkpointAt,
    };
  }

  /** Whether `/checkpoint` may be typed into this pane now. The one gate for
   *  the clock's click and the palette entry.
   *  Limitation: if the user has a half-typed draft in Claude's prompt, Patton
   *  cannot see it and the command is appended to it; erasing it (Ctrl+U)
   *  would destroy his text, so nothing is sent to clear it. */
  private get checkpointReady(): boolean {
    if (!this.claudeActive || this.ptyId === null) return false;
    // Claude Code reports its own state (OSC 7501): its prompt is open only
    // when the root is done or idle, never while working or blocked on a
    // question or permission prompt (which has no Stop hook to wait for).
    if (this.statusReporting) {
      const root = this.programStatus.root?.state;
      return root === 'done' || root === 'idle';
    }
    return !this.claudeWorking && this.stopSeenSinceWork;
  }

  /** Type `/checkpoint` and Enter into this pane's Claude session, through the
   *  compose box's submit path (control characters stripped, no paste dialog,
   *  never broadcast). Only while Claude runs here and has stopped: its root
   *  is done or idle (OSC 7501), else its Stop hook has reported since the
   *  last ◐ (a dialog shows ✳ but sends none) and nothing was typed since.
   *  Not while a `/` command typed since Claude last reported may still show
   *  a menu (Enter would pick from it). A draft in Claude's input line (main's
   *  unsent-input tracker) is stashed first with Ctrl+S, and Claude Code puts
   *  it back after the submit; if Ctrl+S isn't the stash key here, nothing is
   *  sent. Resolves to null when sent, else why not. */
  async runCheckpoint(): Promise<string | null> {
    if (!this.checkpointReady) {
      rlog('info', '[CKPT] run skipped', {
        pane: this.id, claude: this.claudeActive, working: this.claudeWorking, blocked: this.claudeBlocked,
        stopSeen: this.stopSeenSinceWork, root: this.programStatus.root?.state ?? null,
      });
      if (!this.claudeActive) return 'Checkpoint: Claude Code is not running in this pane';
      if (this.claudeBlocked) return 'Checkpoint: Claude is waiting on a question or permission prompt';
      return 'Checkpoint: wait until Claude has finished replying';
    }
    const ptyId = this.ptyId;
    const [input, key] = await Promise.all([this.readInputState(), window.patton.pauseAll.stashKey()]);
    if (this.ptyId !== ptyId || !this.checkpointReady) return 'Checkpoint: the session changed, try again';
    const facts = this.inputFacts(input);
    const keyWhy = 'why' in key ? key.why : null;
    const skip = facts.menu ? 'menu'
      : !this.statusReporting && !facts.stopSeen ? 'typed-since-stop'
      : facts.draft && keyWhy !== null ? 'draft'
      : facts.draft && facts.stashed ? 'stashed'
      : null;
    if (skip) {
      rlog('info', '[CKPT] run skipped', { pane: this.id, reason: skip, ...(keyWhy === null ? {} : { stashKey: keyWhy }) });
      if (skip === 'menu') return 'Checkpoint: Claude may be showing a menu (a / command was typed)';
      if (skip === 'draft') return 'Checkpoint: a draft may be in Claude\'s input and Ctrl+S is not its stash key';
      if (skip === 'stashed') return 'Checkpoint: a draft is in Claude\'s input and another is already set aside here';
      return 'Checkpoint: something was typed since Claude stopped';
    }
    rlog('info', '[CKPT] run', { pane: this.id, stash: facts.draft });
    this.queueSubmit('/checkpoint', false, { stashFirst: facts.draft, origin: 'patton' });
    return null;
  }

  /** Main's unsent-input tracker on this pane's PTY; null if it can't say. */
  async readInputState(): Promise<UnsentInputState | null> {
    if (this.ptyId === null) return null;
    try {
      const [state] = await window.patton.pty.inputState([this.ptyId]);
      return state ?? null;
    } catch (err) {
      rlog('warn', '[PAUSE-ALL] input state unavailable', { pane: this.id, error: String(err) });
      return null;
    }
  }

  /** What main's tracker adds to this pane's own state. Unknown input counts
   *  as a draft (stashing an empty line is the cheaper mistake).
   *  - draft: something may be in the input line.
   *  - menu: the last line sent began with `/` (or can't be read) and no 7501
   *    report or Stop hook has come since: a picker such as /model may be open.
   *  - stopSeen (title path): the Stop hook reported and no input came after it.
   *  - stashed: Claude Code may already hold a stash, so Ctrl+S would overwrite
   *    or pop it: the user pressed Ctrl+S in this Claude session, or Patton
   *    stashed here and no line was submitted since. Unknown counts as held. */
  private inputFacts(input: UnsentInputState | null): { draft: boolean; menu: boolean; stopSeen: boolean; stashed: boolean } {
    if (input === null) return { draft: true, menu: false, stopSeen: this.stopSeenSinceWork, stashed: true };
    return {
      draft: input.dirty,
      stashed: (input.userStashAt > 0 && input.userStashAt >= this.claudeSessionAtMs) || input.pattonStashAt > 0,
      menu: input.slashSubmitAt > 0 && input.slashSubmitAt >= this.lastSignalAtMs,
      stopSeen: this.stopSeenSinceWork && input.lastInputAt < this.stopSeenAtMs,
    };
  }

  /** The Claude session here may have changed: restart its clock. */
  private newClaudeSession(): void {
    this.claudeSessionAtMs = Date.now();
    this.ackedCheckpointAt = null;
    this.heldLoggedCheckpointAt = null;
    this.clearCheckpointDone('new session');
  }

  /** 'at-prompt' while Claude's root is done or idle with nothing blocked
   *  (7501): a Ctrl+C typed then empties Claude's input line, and main's
   *  unsent-input tracker may count the line clean. */
  private get atPromptOrigin(): 'at-prompt' | undefined {
    if (!this.statusReporting || this.claudeBlocked) return undefined;
    const root = this.programStatus.root?.state;
    if (root !== 'done' && root !== 'idle') return undefined;
    if (this.programStatus.children().some((c) => c.record.state === 'blocked')) return undefined;
    return 'at-prompt';
  }

  /** What Pause all needs to decide whether this pane gets `pause`
   *  (services/pause-all.ts pauseSkipReason), given main's tracker state. */
  pauseInput(input: UnsentInputState | null): PauseInput {
    const facts = this.inputFacts(input);
    return {
      live: this.ptyId !== null && !this.ptyExited,
      claude: this.claudeActive,
      source: this.statusReporting ? '7501' : 'title',
      root: this.statusReporting ? this.programStatus.root?.state ?? null : null,
      working: this.claudeWorking,
      blocked: this.claudeBlocked,
      taskBlocked: this.statusReporting && this.programStatus.children().some((c) => c.record.state === 'blocked'),
      hadTurn: this.hadTurn,
      stopSeen: facts.stopSeen,
      menu: facts.menu,
      draft: facts.draft,
      stashed: facts.stashed,
    };
  }

  /** Type `pause` and Enter, through the same submit path as the
   *  checkpoint clock's /checkpoint (never broadcast, no scroll). The caller
   *  decided this pane may take it. With `stash`, Ctrl+S first moves a draft
   *  out of the way; Claude Code restores it after the submit by itself, so
   *  no second Ctrl+S is sent (it would stash the restored draft again). */
  typePauseWord(opts: { stash: boolean }): void {
    this.queueSubmit('pause', false, { stashFirst: opts.stash, scroll: false, origin: 'patton' });
  }

  // ---- Session bar (docs/session-bar.md) ----

  /** Claude runs in this pane (7501 `app=claude-code`, else the title fallback). */
  get isClaudePane(): boolean {
    return this.claudeActive;
  }

  /** The terminal's grid columns now. */
  get columns(): number {
    return this.terminalView.getDimensions().cols;
  }

  /** The width the grid is cut from and one cell's width (px), for the bar's
   *  narrow fold; null while the terminal can't be measured. */
  sessionBarWidthInfo(): { availWidth: number; cellWidth: number } | null {
    return this.terminalView.fitWidthInfo();
  }

  /** A transcript-feed event main sent for this pane's pty (TabManager routes it). */
  applyFeedEvent(ptyId: number, event: SessionFeedEvent): void {
    // Late events for a session the pane no longer follows are dropped.
    if (this.feedPtyId === null || ptyId !== this.feedPtyId) return;
    this.feedWatch.noteEvent(event);
    if (event.type === 'error') {
      rlog('warn', '[BAR] feed error', { pane: this.id, why: event.why });
    }
    this.logBarNotes(this.sessionBarModel.applyFeed(event, Date.now()));
  }

  /** The container changed size for the bar: fit now through the pane's
   *  normal resize path, not after the observer's 100 ms debounce. */
  refitAfterLayout(): void {
    if (this.disposed) return;
    if (this.resizeTimer) {
      clearTimeout(this.resizeTimer);
      this.resizeTimer = null;
    }
    this.fitToContainer();
  }

  /** Follow the pane's Claude session in main while Claude runs here; stop
   *  (and clear the bar's lists) once it leaves or the pty changes. Called
   *  from notifyCheckpoint, which every Claude start and exit reaches. */
  private syncSessionFeed(): void {
    const want = this.claudeActive && !this.disposed && this.ptyId !== null && !this.ptyExited ? this.ptyId : null;
    if (want === this.feedPtyId) return;
    if (this.feedPtyId !== null) this.stopSessionFeed();
    if (want === null) return;
    this.feedPtyId = want;
    this.feedTranscriptHint = null;
    this.watchSessionFeed(want);
  }

  private watchSessionFeed(ptyId: number, transcriptPath?: string): void {
    this.feedWatch.watch(ptyId, transcriptPath);
  }

  private stopSessionFeed(): void {
    const ptyId = this.feedPtyId;
    this.feedPtyId = null;
    this.feedTranscriptHint = null;
    this.feedWatch.reset();
    this.sessionBarModel.reset();
    if (ptyId === null) return;
    // An exited pty was already unwatched by main's exit listener (L).
    if (this.ptyExited && ptyId === this.ptyId) return;
    window.patton.sessionFeed?.unwatch(ptyId).catch(() => { /* main forgets it with the pty */ });
  }

  /** A Stop: reconcile the bar with the hook's lists, and pass its transcript
   *  path to main when it is new (D8: accepted only if main's checks pass). */
  private applyStopToBar(state: StopState): void {
    const lists = stopListsOf(state);
    this.sessionBarModel.applyStop(lists, Date.now());
    const tp = lists.transcriptPath;
    if (tp && this.feedPtyId !== null && tp !== this.feedTranscriptHint) {
      this.feedTranscriptHint = tp;
      this.watchSessionFeed(this.feedPtyId, tp);
    }
  }

  /** D11: `[BAR] link` and `[BAR] failure` as the model adds them. */
  private logBarNotes(notes: ModelNote[]): void {
    for (const n of notes) {
      if (n.note === 'link') rlog('info', '[BAR] link', { pane: this.id, kind: n.kind });
      else rlog('info', '[BAR] failure', { pane: this.id, kind: n.kind });
    }
  }

  /** D11: `[BAR] rows` at most once a minute per pane; a change inside the
   *  minute is logged when it ends. */
  private noteBarRows(): void {
    if (this.barRowsTimer !== null || this.disposed) return;
    const wait = this.barRowsLoggedAtMs + Pane.BAR_ROWS_LOG_MS - Date.now();
    if (wait <= 0) { this.logBarRows(); return; }
    this.barRowsTimer = setTimeout(() => {
      this.barRowsTimer = null;
      if (!this.disposed) this.logBarRows();
    }, wait);
  }

  private logBarRows(): void {
    this.barRowsLoggedAtMs = Date.now();
    const v = this.sessionBarModel.view(this.barRowsLoggedAtMs);
    rlog('info', '[BAR] rows', { pane: this.id, running: v.liveCount, scheduled: v.scheduled.length, failures: v.failures.length, links: v.links.length });
  }

  /** Claude isn't running in this pane any more: the shell is back at its
   *  prompt, or the pane's shell was replaced (respawn) and the new one has
   *  never run it. Drops every sign of the old session. */
  private claudeGone(reason: 'shell-prompt' | 'respawn'): void {
    this.resetProgramStatus('shell-prompt');
    this.claudeWorking = false;
    if (this.claudeActive) this.newClaudeSession();
    this.claudeActive = false;
    this.stopSeenSinceWork = false;
    this.notifyCheckpoint();
    this.syncComposeFirst(reason);
    this.cancelClaudeStop();
    if (this.takeVerdict()) rlog('info', '[DOT] Hook verdict dropped: ' + (reason === 'respawn' ? 'respawn' : 'shell prompt'), { pane: this.id });
    this.setParked(null);
    this.clearPasteChips();
  }

  /** A Claude Code Stop-hook message (OSC 777): the turn ended on its own. */
  private handlePattonState(state: PattonState): void {
    this.stopSeenSinceWork = true;
    this.stopSeenAtMs = Date.now();
    this.lastSignalAtMs = this.stopSeenAtMs;
    this.composeMenuPending = false;
    this.syncComposeAside('stop-hook');
    if (state.kind === 'stop') this.applyStopToBar(state);
    if (state.kind === 'stop') this.handleHookStop(state.tasks, state.crons);
    if (state.kind === 'stop' && state.context) this.noteFinishHeld(state.tasks, state.context);
    if (state.context) this.handleContextReading(state.context);
    else this.notifyCheckpoint();
  }

  /** Log only: a Stop whose new checkpoint (`cpt` from this session, newer
   *  than any he has seen or that is marked) came without `cpd` because its
   *  own background work is still running, so the red circle waits for a
   *  later Stop. Once per `cpt`, so main.log shows how often a finish is held. */
  private noteFinishHeld(tasks: number, context: ContextReading): void {
    const cpt = context.checkpointAt;
    if (tasks <= 0 || cpt === null || context.checkpointDoneAt !== null || this.claudeSessionAtMs === 0) return;
    if (cpt < Math.floor(this.claudeSessionAtMs / 1000) - 1) return;
    if (cpt <= Math.max(this.ackedCheckpointAt ?? -Infinity, this.markedCheckpointAt ?? -Infinity)) return;
    if (cpt === this.heldLoggedCheckpointAt) return;
    this.heldLoggedCheckpointAt = cpt;
    rlog('info', '[CKPT] finish held', { pane: this.id, cpt, tasks });
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
    if (info && this.parked && info.tasks === this.parked.tasks && info.crons === this.parked.crons
      && (info.titles ?? []).join('\n') === (this.parked.titles ?? []).join('\n')) return;
    this.parked = info;
    this.noteActivity();
    this.callbacks.onParked?.(this, info);
  }

  /** `WAKE` as the whole title → yellow tab flag; any other title drops it. */
  private trackAutoFlag(title: string): void {
    if (title === WAKE_TITLE) {
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
    const askedId = this.ptyId;
    return window.patton.pty.getCwd(askedId)
      .then((cwd) => {
        // Asked of a shell that has since been replaced (respawn): its folder
        // is not this pane's any more.
        if (this.ptyId !== askedId) return;
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
    dragHandle.setAttribute('role', 'img'); // an aria-label on a role-less div is ignored
    dragHandle.setAttribute('aria-label', 'Drag to swap pane');
    dragHandle.title = 'Drag to swap pane';
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

    // D10: shown while an aside hides the box in the overlays and the box
    // holds a draft. Words only, no click (pointer-events: none).
    this.draftNote = document.createElement('div');
    this.draftNote.className = 'compose-draft-note';
    this.draftNote.textContent = 'Draft kept';
    this.draftNote.hidden = true;
    this.element.appendChild(this.draftNote);

    // D10: during a `menu` aside in the overlays the hidden box can't be
    // clicked, so this button does D3's click for it. mousedown must not move
    // the keyboard before the click runs.
    this.typeHereButton = document.createElement('button');
    this.typeHereButton.type = 'button';
    this.typeHereButton.className = 'compose-type-here';
    this.typeHereButton.textContent = 'Type here';
    this.typeHereButton.title = 'Claude may be showing a menu above · click to type in the box';
    this.typeHereButton.setAttribute('aria-label', 'Type here: Claude may be showing a menu above, click to type in the box');
    this.typeHereButton.hidden = true;
    this.typeHereButton.addEventListener('mousedown', (e) => e.preventDefault());
    this.typeHereButton.addEventListener('click', () => this.chooseBoxByClick());
    this.element.appendChild(this.typeHereButton);

    // Create terminal view
    this.terminalView = new TerminalView(this.terminalContainer);

    // Create editor input (compose panel — collapsed by default)
    this.editorInput = new EditorInput(this.editorContainer, {
      onSubmit: (command) => {
        if (!this.handleSubmit(command)) return false; // held: the draft stays
        // Compose-first keeps the box open and focused for the next message.
        if (!this.composeFirstEngaged) this.collapseCompose();
        return true;
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
      getCopyFallback: () => this.terminalCopyFallback(),
      onContentHeight: () => this.syncComposeRoom('content'),
      onKillLine: (lines) => rlog('info', '[COMPOSE] kill line', { pane: this.id, lines }),
    });

    // Aside, a label takes Send's place (services/compose-aside.ts); the
    // slot is sized for the widest, so stepping aside never reflows the box.
    this.editorInput.reserveSlotWidthFor([
      'Send', ...Object.values(COMPOSE_ASIDE_LABEL), COMPOSE_SEND_HELD_LABEL,
    ]);
    // When the box last had a keydown: a 'blocked' aside waits for a pause
    // in his typing before it moves the keyboard (D2).
    const editorKeyDown = () => { this.composeLastKeydownMs = Date.now(); };
    this.editorContainer.addEventListener('keydown', editorKeyDown, true);
    this.disposables.push(() => this.editorContainer.removeEventListener('keydown', editorKeyDown, true));

    // The compose box, a click in the terminal (D4): on a pane with 7501
    // reports the box keeps the keyboard. xterm still gets the whole click
    // (it focuses itself, selects, sends mouse reports), and the box takes
    // the keyboard back once the click has run. Without 7501 reports nothing
    // says when Claude asks, so there the click hands the keyboard to the
    // terminal (so the box mustn't take focus back until Claude's next ◐).
    // Aside, the terminal takes it as usual. A click in the box takes it
    // back. Capture phase, so this runs before the pane's own mousedown →
    // onFocus → focus() path reads composeHandedOff.
    const terminalMouseDown = (e: MouseEvent) => {
      if (!this.composeFirstEngaged) return;
      if (e.button !== 0) return; // a right-click (context menu) keeps the keyboard where it is
      if ((e.target as Element | null)?.closest?.('.search-overlay')) return;
      if (this.composeAside !== null) return;
      if (this.statusReporting) {
        if (!this.composeHandedOff) setTimeout(() => this.keepBoxKeyboard(), 0);
        return;
      }
      this.handOffCompose('click');
    };
    this.terminalContainer.addEventListener('mousedown', terminalMouseDown, true);
    this.disposables.push(() => this.terminalContainer.removeEventListener('mousedown', terminalMouseDown, true));
    const editorMouseDown = () => {
      this.chooseBoxByClick();
    };
    this.editorContainer.addEventListener('mousedown', editorMouseDown, true);
    this.disposables.push(() => this.editorContainer.removeEventListener('mousedown', editorMouseDown, true));

    // D14: pasted images inside the box, first from its left, then the text. A press keeps the keyboard in the textarea.
    this.boxImages = document.createElement('div');
    this.boxImages.className = 'compose-images';
    this.boxImages.setAttribute('role', 'group');
    this.boxImages.setAttribute('aria-label', 'Pasted images');
    this.boxImages.hidden = true;
    this.boxImages.addEventListener('mousedown', (e) => e.preventDefault());
    this.editorInput.insertBeforeText(this.boxImages);

    this.wireComposePlacement();

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

  /** The shell this pane runs, as main started it ('' until main has said,
   *  then the shell the app asked for, if any). A tab's first pane is built
   *  before the app's shell setting reaches it, so it asks main, which falls
   *  back to $SHELL. */
  get shellPath(): string {
    return this.startedShell || this.callbacks.shell || '';
  }

  /**
   * Replace this pane's shell with a new one (the project board opening a
   * project in the board's own tab). Main starts the new shell the way a new
   * tab's is started (`cwd` validated, `projectDir` exports PATTON_PROJECT_DIR,
   * `hyperlinks` FORCE_HYPERLINK=1) and ends the old one, so no exit event
   * reaches this pane for it. Afterwards the pane looks like a freshly created
   * one: blank terminal, shell progress restarted, folder `cwd` (or home).
   * Returns the old and new PTY ids; throws, leaving the old shell running, if
   * main refuses or cannot start the new one.
   */
  async respawn(opts: { cwd?: string; projectDir?: boolean; hyperlinks?: boolean }): Promise<{ oldId: number; newId: number }> {
    const oldId = this.ptyId;
    if (this.disposed || oldId === null) throw new Error('This pane has no shell to replace');
    if (this.replacingPtyId !== null) throw new Error('This pane\'s shell is already being replaced');
    // From here the old shell's output and exit are ignored, then what was
    // already handed to xterm is parsed, so reset() below has nothing queued
    // behind it. On failure the old shell carries on (its exit, if it came
    // meanwhile, is applied below; the few bytes dropped are of a shell the
    // board was covering).
    this.replacingPtyId = oldId;
    this.replacedPtyExited = false;
    let newId: number;
    try {
      await this.terminalView.drainWrites();
      const dims = this.terminalView.getDimensions();
      const shellPath = this.callbacks.shell;
      newId = await window.patton.pty.respawn(oldId, {
        cols: dims.cols,
        rows: dims.rows,
        ...(opts.cwd ? { cwd: opts.cwd } : {}),
        ...(opts.cwd && opts.projectDir ? { projectDir: true } : {}),
        ...(opts.hyperlinks ? { hyperlinks: true } : {}),
        ...(shellPath ? { shell: shellPath } : {}),
        isDark: this.terminalView.isDarkBackground(),
      });
    } catch (err) {
      if (this.replacedPtyExited) this.ptyExited = true;
      throw err;
    } finally {
      this.replacingPtyId = null;
    }
    if (this.disposed) {
      // Closed while main was starting the shell: nothing owns the new one.
      window.patton.pty.destroy(newId);
      throw new Error('Pane closed while its shell was being replaced');
    }
    // The new shell has never run Claude: the old session's state goes first,
    // before the pane points at the new shell.
    this.claudeGone('respawn');
    this.ptyId = newId;
    this.ptyExited = false;
    this.newClaudeSession();
    this.terminalView.setPtyId(newId);
    this.terminalView.resetForNewShell();
    if (opts.hyperlinks) this.hyperlinkEnv = true;
    this.initialCwd = opts.cwd;
    this.shellStartedAt = performance.now();
    this.shellSawSignal = false;
    this.shellSawFirstPrompt = false;
    this.shellIntegrated = false;
    this.startedShell = '';
    window.patton.pty.getShell(newId).then((shell) => {
      if (this.ptyId === newId) this.startedShell = shell;
    }).catch((err: unknown) => rlog('warn', '[PTY] could not read the shell', { ptyId: newId, error: String(err) }));
    // The folder the tab is named from: the project's, or home (unknown) again.
    this.currentCwd = opts.cwd ?? '';
    this.callbacks.onCwdChange?.(this);
    // The old shell's window title is stale for the new one (and a WAKE title
    // would keep the yellow flag): back to the default until it sets its own.
    this.title = 'Terminal';
    this.callbacks.onTitleChange(this);
    this.trackAutoFlag('Terminal');
    return { oldId, newId };
  }

  /** Run `cb` when this pane is disposed (closed). Returns a remover. */
  onDispose(cb: () => void): () => void {
    this.disposables.push(cb);
    return () => {
      this.disposables = this.disposables.filter((d) => d !== cb);
    };
  }

  /**
   * How far this pane's shell has got, from the moment its PTY was created:
   * when that was, whether it has sent any OSC 133 mark (it has shell
   * integration), and whether it has shown its first real prompt. zsh marks a
   * prompt at .zshenv time, long before .zshrc is done, so only the first
   * `D` (every prompt sends D then A) means the shell is ready for input.
   */
  get shellProgress(): { startedAt: number; sawSignal: boolean; sawFirstPrompt: boolean } {
    return { startedAt: this.shellStartedAt, sawSignal: this.shellSawSignal, sawFirstPrompt: this.shellSawFirstPrompt };
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

    // Track the shell's progress from before its PTY exists. A first OSC 133
    // mark can be parsed while init() awaits the history load below (a tab's
    // first pane has no shared history manager yet), long before the listener
    // that drives the compose bar is registered; shellProgress must not miss it.
    this.disposables.push(
      this.terminalView.onPromptState((state) => {
        this.shellIntegrated = true;
        this.shellSawSignal = true;
        if (state === 'idle') this.shellSawFirstPrompt = true;
      }),
    );

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
      this.shellStartedAt = performance.now();
      const createdId = this.ptyId;
      window.patton.pty.getShell(createdId).then((shell) => {
        if (this.ptyId === createdId) this.startedShell = shell;
      }).catch((err: unknown) => rlog('warn', '[PTY] could not read the shell', { ptyId: createdId, error: String(err) }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.terminalView.write(`\r\n\x1b[31mFailed to create terminal: ${msg}\x1b[0m\r\n`);
      return;
    }

    // Wire PTY data → terminal (unconditional — no mode checking)
    this.disposables.push(
      window.patton.pty.onData((id, data) => {
        if (id === this.ptyId && id !== this.replacingPtyId) {
          this.terminalView.write(data);
        }
      }),
    );

    // Track PTY exit to avoid destroy-after-exit
    this.disposables.push(
      window.patton.pty.onExit((id) => {
        if (id === this.replacingPtyId) {
          this.replacedPtyExited = true;
        } else if (id === this.ptyId) {
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

    // Claude Code's own status reports (OSC 7501, see handleProgramStatus).
    this.disposables.push(
      this.terminalView.onProgramStatus((event) => this.handleProgramStatus(event)),
    );

    // Claude Code Stop hook verdicts (OSC 777, see handleHookStop).
    this.disposables.push(
      this.terminalView.onPattonState((state) => this.handlePattonState(state)),
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
        window.patton.pty.write(this.ptyId, data, data.includes('\x03') ? this.atPromptOrigin : undefined);
        // A lone Enter sends the message: a paste arrives as one larger string and
        // Shift+Enter as `\x1b[13;2u`, neither is exactly '\r'.
        if (data === '\r') this.noteEnterSent();
      }
    });
    if (termDataDispose) this.disposables.push(termDataDispose);

    // --- Handle resize with debouncing ---
    const resizeObserver = new ResizeObserver(() => {
      if (this.resizeTimer) clearTimeout(this.resizeTimer);
      this.resizeTimer = setTimeout(() => {
        this.resizeTimer = null;
        this.fitToContainer();
      }, 100);
    });
    resizeObserver.observe(this.terminalContainer);
    this.disposables.push(() => resizeObserver.disconnect());
    // D11: the bar's rows line follows the model.
    this.disposables.push(this.sessionBarModel.onChange(() => this.noteBarRows()));

    // In the overlays the paste strip sits on the box's top edge, which moves
    // as the box grows upward (D12). Not debounced, unlike the terminal's fit
    // above: this only writes one style, and a lag would leave the strip over
    // the box. Here in init(), not the constructor, as the terminal's observer.
    const boxResize = new ResizeObserver(() => this.placePasteStrip());
    boxResize.observe(this.editorContainer);
    this.disposables.push(() => boxResize.disconnect());

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

    // D5: dropped files add their escaped paths (services/file-drop.ts).
    const onFileDragOver = (e: DragEvent) => {
      if (!isFileDrag(e.dataTransfer)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    };
    const onFileDrop = (e: DragEvent) => {
      if (!isFileDrag(e.dataTransfer)) return;
      e.preventDefault();
      this.dropFiles(Array.from(e.dataTransfer?.files ?? []));
    };
    this.element.addEventListener('dragover', onFileDragOver);
    this.element.addEventListener('drop', onFileDrop);
    this.disposables.push(() => {
      this.element.removeEventListener('dragover', onFileDragOver);
      this.element.removeEventListener('drop', onFileDrop);
    });
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
        if (state === 'idle') this.refreshCwd();
        // The shell is back at its prompt, so Claude isn't running here any
        // more — even if it quit mid-work and left a ◐ title behind. Without
        // this, the next `claude` launch's first ✳ would read as a stop.
        if (state === 'prompt') this.claudeGone('shell-prompt');
      }),
    );

    // Focus terminal on init (terminal is always the primary input)
    requestAnimationFrame(() => this.terminalView.focus());
  }

  private submitQueue: Promise<void> = Promise.resolve();

  /** Send a line from the box. False when it was held back (the draft stays). */
  private handleSubmit(command: string): boolean {
    // Claude is asking something above: a line typed now would land in the
    // question's own input (and its Enter pick the default option), so
    // nothing is sent until it is answered. From the first report, not only
    // once the box has stepped aside after the 250 ms hold.
    if (this.composeAside === 'blocked' || (this.composeFirstEngaged && this.claudeAsksNow())) {
      this.editorInput.flashAsideLabel(COMPOSE_SEND_HELD_LABEL, COMPOSE_SEND_HELD_MS);
      this.logComposeSendHeld();
      return false;
    }
    if (this.ptyId === null) return true;
    // D3: his own slash command from the box may open a picker. Counted from
    // the Enter, as main's tracker counts slashSubmitAt for Pause all's
    // `menu`. Only on a pane with 7501 reports: nothing else would end it.
    const menu = this.composeFirstEngaged && this.statusReporting && isMenuLine(stripPasteControls(command));
    command = this.queueSubmit(command, true, {
      own: true, ...(menu ? { onEnterSent: () => this.noteComposeMenuSent() } : {}),
    });
    if (command.trim()) {
      this.historyManager.add(command);
    }
    this.historyManager.resetCursor();
    return true;
  }

  /** `[COMPOSE] send held {pane, held}`, at most once per COMPOSE_HELD_LOG_MS
   *  (a held Enter repeats ~30 times a second); `held` counts the sends held
   *  since the last line, this one included. */
  private logComposeSendHeld(): void {
    this.composeHeldSince++;
    const now = Date.now();
    if (now - this.composeHeldLoggedMs < Pane.COMPOSE_HELD_LOG_MS) return;
    rlog('info', '[COMPOSE] send held', { pane: this.id, held: this.composeHeldSince });
    this.composeHeldLoggedMs = now;
    this.composeHeldSince = 0;
  }

  /** Claude Code waits on him right now (7501: the root or a background task
   *  `blocked`), from the first report, without the box's 250 ms hold. */
  private claudeAsksNow(): boolean {
    if (!this.statusReporting) return false;
    return composeBlockedFact(this.programStatus.root, this.programStatus.children()).blocked;
  }

  /** For broadcast input (Tab): this pane's Claude is asking a question or
   *  permission, so typing broadcast into it would answer that instead. */
  get waitsOnAnswer(): boolean {
    return !this.disposed && this.claudeAsksNow();
  }

  /** Delay between Ctrl+S (stash) and the word, so Claude Code has emptied
   *  the input line first. Chosen by reading, not measured live. */
  private static readonly STASH_SETTLE_MS = 150;

  /** Write one submitted line (then Enter) to the pty: the compose box's
   *  route, shared with the checkpoint clock and Pause all. Returns the line
   *  as sent. Options (Patton's own words only, never the compose box):
   *  `stashFirst` sends Ctrl+S and waits STASH_SETTLE_MS before the line;
   *  `scroll: false` leaves the view where it is; `origin: 'patton'` tells
   *  main's unsent-input tracker the user didn't type it; `own` (the box's
   *  send) stamps each write as this pane's own typing, so
   *  Claude echoing it in its bar never moves the box (D9). */
  private queueSubmit(
    command: string,
    allowBroadcast: boolean,
    opts: { stashFirst?: boolean; scroll?: boolean; origin?: 'patton'; onEnterSent?: () => void; own?: boolean } = {},
  ): string {
    // Broadcast mode: also write to all other panes in the tab
    const broadcast = allowBroadcast ? this.callbacks.onBroadcastWrite : undefined;
    const broadcastPaste = allowBroadcast ? this.callbacks.onBroadcastPaste : undefined;

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
    const origin = opts.origin;
    const own = opts.own === true ? () => this.noteOwnTyping() : () => {};
    this.submitQueue = this.submitQueue.then(() => new Promise<void>((resolve) => {
      if (this.ptyId === null) { resolve(); return; }
      if (opts.stashFirst) {
        own();
        window.patton.pty.write(this.ptyId, '\x13', origin);
        setTimeout(() => {
          if (this.ptyId === null) { resolve(); return; }
          submitLine(resolve);
        }, Pane.STASH_SETTLE_MS);
        return;
      }
      submitLine(resolve);
    }));
    const submitLine = (resolve: () => void): void => {
      if (this.ptyId === null) { resolve(); return; }
      const route: 'paste' | 'type' =
        multiLineCompose && this.terminalView.terminal.modes.bracketedPasteMode ? 'paste' : 'type';
      rlog('info', '[COMPOSE] submit', { pane: this.id, lines, route, ...(opts.stashFirst ? { stashed: true } : {}) });
      // The user's own send takes the pasted images with it; Patton's own typing
      // (Pause all, checkpoint) says nothing about the user's message.
      if (origin !== 'patton') this.clearPasteChipsOnSend('compose');
      // Patton's own lines (a /checkpoint) start a turn as his do.
      if (command.trim()) this.noteTurnSubmitted('compose');
      // xterm's scrollOnUserInput only sees its own keys, not the box's.
      if (opts.scroll !== false) this.terminalView.terminal.scrollToBottom();
      own();
      if (route === 'paste') {
        this.terminalView.terminal.paste(command);
        broadcastPaste?.(command);
        // The Enter waits longer than a typed line's so Claude Code has taken
        // in the whole paste first: 60 ms is meant to clear its paste debounce
        // (a margin chosen by reading, not yet measured live).
        setTimeout(() => {
          if (this.ptyId !== null) {
            own();
            window.patton.pty.write(this.ptyId, '\r');
            broadcast?.('\r');
            opts.onEnterSent?.();
          }
          resolve();
        }, 60);
      } else if (command) {
        window.patton.pty.write(this.ptyId, command, origin);
        broadcast?.(command);
        setTimeout(() => {
          if (this.ptyId !== null) {
            own();
            window.patton.pty.write(this.ptyId, '\r', origin);
            broadcast?.('\r');
            opts.onEnterSent?.();
          }
          resolve();
        }, 10);
      } else {
        if (this.turnEnded && this.claudeBarHoldsText()) this.noteTurnSubmitted('compose');
        window.patton.pty.write(this.ptyId, '\r', origin);
        broadcast?.('\r');
        resolve();
      }
    };
    return command;
  }

  private handleInterrupt(): void {
    if (this.ptyId === null) return;
    window.patton.pty.write(this.ptyId, '\x03', this.atPromptOrigin);
  }

  private handleTab(): void {
    if (this.ptyId === null) return;
    // D2: while Claude asks, the box's Tab stays in the box (forwardEmptyBoxKey).
    if (this.composeFirstEngaged && this.claudeAsksNow()) return;
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
    // Claude asks something (the live 7501 fact, as sends use): a Ctrl+V now
    // would reach the question's own input. Nothing is written and no chip is
    // made; a Ctrl+V he typed has already reached the pty, so only its chip is
    // skipped.
    if (this.claudeActive && this.claudeAsksNow()) {
      this.holdImagePaste(source);
      return;
    }
    try {
      const sendCtrlV = this.claudeActive;
      const image = await window.patton.clipboard.readImage(!sendCtrlV);
      if (!image || this.disposed || this.ptyId === null) return;
      let route: 'ctrl-v' | 'path';
      if (sendCtrlV) {
        // The read took a moment: Claude may have started asking meanwhile.
        if (this.claudeAsksNow()) {
          this.holdImagePaste(source);
          return;
        }
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

  /** An image paste refused while Claude asks: the box's Send slot says so
   *  like a held send (its live region announces it); with no box engaged the
   *  announcer does. */
  private holdImagePaste(source: 'paste' | 'menu' | 'ctrl-v-key' | 'compose'): void {
    if (this.composeFirstEngaged) this.editorInput.flashAsideLabel(COMPOSE_SEND_HELD_LABEL, COMPOSE_SEND_HELD_MS);
    else announce(`${COMPOSE_SEND_HELD_LABEL}: image not pasted`);
    rlog('info', '[PASTE] image held', { pane: this.id, source });
  }

  private addPasteChip(dataUrl: string, width: number, height: number): void {
    const label = `${width}\u00d7${height}`;
    announce(`Image pasted, ${label}`);
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

    const entry: PasteChipEntry = {
      el: chip,
      label,
      dataUrl,
      timer: setTimeout(() => this.pasteChipExpired(entry), Pane.PASTE_CHIP_TTL_MS),
    };
    remove.addEventListener('click', () => {
      this.removePasteChip(entry);
      this.terminalView.focus();
    });

    this.pasteChips.push(entry);
    // Engaged, the chip is the only sign of the image in Claude's message: no
    // eviction (D14); the box's "+N" counts the ones beyond those it shows.
    while (!this.composeFirstEngaged && this.pasteChips.length > Pane.PASTE_CHIP_MAX) this.removePasteChip(this.pasteChips[0]);
    this.pasteStrip.appendChild(chip);
    this.syncPasteChipViews();
  }

  /** The 10-minute timer. While the box is engaged the thumbnail is the only
   *  sign of the image in Claude's message, so it stays (D14): the timer
   *  starts again instead. */
  private pasteChipExpired(entry: PasteChipEntry): void {
    if (!this.pasteChips.includes(entry)) return;
    if (this.composeFirstEngaged) {
      entry.timer = setTimeout(() => this.pasteChipExpired(entry), Pane.PASTE_CHIP_TTL_MS);
      return;
    }
    this.removePasteChip(entry);
  }

  private removePasteChip(entry: PasteChipEntry): void {
    clearTimeout(entry.timer);
    entry.el.remove();
    this.pasteChips = this.pasteChips.filter((c) => c !== entry);
    this.syncPasteChipViews();
  }

  /**
   * D14: while the box is engaged (every placement) the thumbnails sit inside
   * it, left of the text, with no ×, and the strip above it is not used; with
   * the box off or closed, the strip as before. `refit` false when the caller
   * changes the box's own height in the same run (engage, disengage): the
   * terminal's resize observer then refits once for both.
   */
  private syncPasteChipViews(refit = true): void {
    const inBox = this.composeFirstEngaged;
    this.renderBoxImages(inBox ? this.pasteChips : []);
    this.setPasteStripVisible(!inBox && this.pasteChips.length > 0, refit);
  }

  private renderBoxImages(entries: readonly PasteChipEntry[]): void {
    if (!this.boxImages) return; // before the constructor has built it
    const shown = entries.slice(0, Pane.BOX_IMAGES_SHOWN);
    const nodes: HTMLElement[] = shown.map((entry) => {
      const img = document.createElement('img');
      img.className = 'compose-image';
      img.src = entry.dataUrl;
      img.alt = `Pasted image, ${entry.label}`;
      img.title = `Pasted image, ${entry.label}`;
      return img;
    });
    const more = entries.length - shown.length;
    if (more > 0) {
      const count = document.createElement('span');
      count.className = 'compose-images-more';
      count.textContent = `+${more}`;
      const words = `${more} more pasted image${more === 1 ? '' : 's'}`;
      count.title = words;
      count.setAttribute('role', 'img');
      count.setAttribute('aria-label', words);
      nodes.push(count);
    }
    this.boxImages.replaceChildren(...nodes);
    this.boxImages.hidden = entries.length === 0;
    this.syncComposeRoom('chip'); // D15: a chip may change the box's height
  }

  /** The terminal's container changed size: fit, tell the PTY, re-place the box. */
  private fitToContainer(): void {
    // D15: rows given up stay given up at the new size (the padding that
    // gives them up is measured from the container's size).
    const before = this.terminalView.getDimensions();
    if (this.composeRoomRows > 0) this.terminalView.setRowsGivenUp(this.composeRoomRows);
    else this.terminalView.fit();
    const dims = this.terminalView.getDimensions();
    if (this.ptyId !== null) window.patton.pty.resize(this.ptyId, dims.cols, dims.rows);
    if (dims.rows !== before.rows || dims.cols !== before.cols) this.openComposeSettle('resize', true);
    // The box's cap is a share of the pane's height, so follow resizes.
    if (this.composeFirstEngaged) this.editorInput.refreshSize();
    this.layoutComposeOverlay();
    // D15: the cap on k is a third of the pane, so a pane that changed
    // height works k out again. The observer also fires for Patton's own
    // padding change (it narrows .terminal-container's content box), which
    // leaves the pane's height as it was and so does nothing here.
    if (this.element.clientHeight !== this.composeRoomPaneH) this.syncComposeRoom('resize');
    this.scheduleBarReading();
  }

  /** Showing or hiding the strip changes the terminal's height: re-fit and tell the PTY now. */
  private setPasteStripVisible(visible: boolean, refit = true): void {
    if (this.pasteStrip.hidden === !visible) return;
    this.pasteStrip.hidden = !visible;
    if (refit) this.refitTerminal();
  }

  /** A row under the terminal appeared or went: re-fit and tell the PTY now,
   *  rather than on the resize observer's 100 ms debounce. `before`: the grid
   *  before the caller's own change (a caller that changed the padding has
   *  already refit); a grid that changed opens a settling (D15, S60). */
  private refitTerminal(cause = 'refit', before = this.terminalView.getDimensions()): void {
    if (this.disposed) return;
    this.terminalView.fit();
    const dims = this.terminalView.getDimensions();
    if (this.ptyId !== null) window.patton.pty.resize(this.ptyId, dims.cols, dims.rows);
    if (dims.rows !== before.rows || dims.cols !== before.cols) this.openComposeSettle(cause, true);
  }

  private clearPasteChips(): void {
    for (const entry of [...this.pasteChips]) this.removePasteChip(entry);
  }

  /** An Enter reached this pane's PTY (typed, from the empty compose box, or
   *  broadcast from another pane). While Claude waits on a permission prompt or
   *  question that Enter answers the dialog and the image is still in the draft,
   *  so the chips stay. */
  noteEnterSent(): void {
    if (this.claudeBlocked) return;
    this.clearPasteChipsOnSend('enter');
    // An Enter on his own text in Claude's bar sends it; an empty bar's or a
    // menu's Enter starts no turn, so it leaves a turn-end ring alone.
    if (this.turnEnded && this.claudeBarHoldsText()) this.noteTurnSubmitted('enter');
  }

  private claudeBarHoldsText(): boolean {
    const reading = readClaudeBar(this.terminalView.terminal.buffer.active);
    return reading.found && !reading.empty;
  }

  /** A message went to Claude while the turn-end ring showed over a working
   *  root: 7501 sends nothing (the root already works), so this is the new
   *  turn's only sign. The verdict was that turn's; the pane goes to working. */
  private noteTurnSubmitted(via: 'enter' | 'compose'): void {
    if (!this.turnEnded) return;
    this.turnEnded = false;
    rlog('info', '[DOT] Hook verdict cleared: new turn', {
      pane: this.id, tasks: this.hookVerdict?.tasks, crons: this.hookVerdict?.crons, via,
    });
    this.hookVerdict = null;
    this.applyProgramStatus();
  }

  /** The user sent a message from this pane. Claude Code may take it into a turn
   *  that is already running (the pane never goes idle, so startWork's clear never
   *  fires), hence the clear on the send itself. */
  private clearPasteChipsOnSend(reason: 'enter' | 'compose'): void {
    const count = this.pasteChips.length;
    if (count === 0) return;
    this.clearPasteChips();
    rlog('info', '[PASTE] chips cleared', { pane: this.id, reason, count });
  }

  /** D5: files dropped on the pane. Paths only; nothing is read from the files. */
  private dropFiles(files: File[]): void {
    const text = dropText(files, (f) => window.patton.getPathForFile(f));
    if (!text) return;
    const target = dropTarget(this.composeFirstEngaged);
    rlog('info', '[DROP] files', { pane: this.id, count: files.length, target });
    // Aside, the paths go into the dimmed box but the keyboard stays put.
    if (target === 'box') this.editorInput.insertText(text, { focus: this.composeAside === null });
    else if (this.ptyId !== null) this.terminalView.terminal.paste(stripPasteControls(text));
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

  /** Settings: lay the box over Claude Code's own bar (D12). Off: `under`. */
  setComposeOverBar(enabled: boolean): void {
    if (enabled === this.composeOverBarSetting) return;
    this.composeOverBarSetting = enabled;
    this.composeSwitchMs = -Infinity; // his own move: never waits
    rlog('info', '[COMPOSE] over-bar setting', { pane: this.id, enabled });
    if (!enabled) {
      this.clearBarLostTimer();
      this.setComposePlacement('under', 'setting');
    } else {
      this.scheduleBarReading();
    }
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
    this.syncComposeAside(reason);
  }

  /** A `/` line from the box reached Claude (its Enter was written). */
  private noteComposeMenuSent(): void {
    if (this.disposed || !this.composeFirstEngaged) return;
    this.composeMenuPending = true;
    this.syncComposeAside('slash-line');
  }

  /**
   * Step the box aside or bring it back (D2, D3) to match Claude's state, the
   * 250 ms hold and a pending `/` menu. Called after every 7501 report, Stop
   * hook, engage and disengage; the rules are in services/compose-aside.ts.
   */
  private syncComposeAside(trigger: string): void {
    if (this.disposed) return;
    const fact = this.statusReporting
      ? composeBlockedFact(this.programStatus.root, this.programStatus.children())
      : { blocked: false, kind: null };
    // The hold runs whether or not the box is open, so a box opened (⌘E)
    // during a question that has already held steps aside at once.
    if (!fact.blocked) {
      this.clearComposeBlockedTimer();
      this.composeBlockedHeld = false;
    } else if (!this.composeBlockedHeld && this.composeBlockedTimer === null) {
      this.composeBlockedTimer = setTimeout(() => {
        this.composeBlockedTimer = null;
        this.composeBlockedHeld = true;
        this.syncComposeAside('held');
      }, COMPOSE_ASIDE_HOLD_MS);
    }
    if (!this.composeFirstEngaged) this.composeMenuPending = false;
    const next = composeAsideReason({
      engaged: this.composeFirstEngaged,
      blocked: fact.blocked,
      blockedHeld: this.composeBlockedHeld,
      menuPending: this.composeMenuPending,
      current: this.composeAside,
    });
    if (next !== this.composeAside) {
      if (next === null) {
        const reason = !this.composeFirstEngaged ? 'disengage'
          : this.composeAside === 'blocked' ? 'unblocked' : trigger;
        this.composeBack(reason);
      } else {
        this.composeStepAside(next, fact.kind);
      }
    }
    this.syncComposeFreeze();
  }

  private clearComposeBlockedTimer(): void {
    if (this.composeBlockedTimer !== null) {
      clearTimeout(this.composeBlockedTimer);
      this.composeBlockedTimer = null;
    }
  }

  private composeStepAside(reason: ComposeAsideReason, kind: string | null): void {
    const boxHadKeyboard = this.editorInput.hasFocus();
    if (this.composeAside === null) this.composeAsideAtMs = Date.now();
    this.composeAside = reason;
    this.editorContainer.classList.add('aside');
    this.editorInput.setAside({ label: COMPOSE_ASIDE_LABEL[reason], title: COMPOSE_ASIDE_HINT[reason] });
    // Mid-typing, a question dims the box at once but leaves the keyboard in
    // it until he pauses (a menu aside follows his own Enter, so never waits).
    const waitMs = reason === 'blocked'
      ? composeKeyboardWaitMs(boxHadKeyboard, Date.now(), this.composeLastKeydownMs, this.composeAsideAtMs) : 0;
    rlog('info', '[COMPOSE] aside', {
      pane: this.id, reason, ...(reason === 'blocked' ? { kind } : {}), ...(waitMs > 0 ? { deferredMs: waitMs } : {}),
    });
    if (waitMs > 0) {
      this.armComposeKeyboardTimer(waitMs);
      this.syncComposeAsideLook();
      return;
    }
    this.clearComposeKeyboardTimer();
    if (boxHadKeyboard || this.canTakeKeyboard()) this.terminalView.focus();
    this.syncComposeAsideLook();
  }

  /** The deferred move of a 'blocked' aside: once the box has been quiet for
   *  COMPOSE_TYPING_GRACE_MS, the keyboard goes to the terminal; a keydown in
   *  the meantime pushes it back, up to COMPOSE_TYPING_GRACE_MAX_MS from the
   *  aside's start. Only while still aside with the box holding the keyboard,
   *  in a pane on screen that may take it (its tab's focused pane, no
   *  overlay); otherwise the move is dropped. */
  private armComposeKeyboardTimer(ms: number): void {
    this.clearComposeKeyboardTimer();
    this.composeKeyboardTimer = setTimeout(() => {
      this.composeKeyboardTimer = null;
      this.composeKeyboardTimerFired();
      // The grace is over (or re-armed): hidden, the box may drop focus now.
      this.syncComposeAsideLook();
    }, ms);
  }

  private composeKeyboardTimerFired(): void {
    if (this.disposed || this.composeAside !== 'blocked' || !this.editorInput.hasFocus()) return;
    if (!this.isOnScreen() || !this.canTakeKeyboard()) {
      rlog('info', '[COMPOSE] aside keyboard dropped', {
        pane: this.id, onScreen: this.isOnScreen(), focused: this._isFocused,
      });
      return;
    }
    const left = composeKeyboardWaitMs(true, Date.now(), this.composeLastKeydownMs, this.composeAsideAtMs);
    if (left > 0) {
      this.armComposeKeyboardTimer(left);
      return;
    }
    rlog('info', '[COMPOSE] aside keyboard', { pane: this.id, afterMs: Date.now() - this.composeAsideAtMs });
    this.terminalView.focus();
  }

  /**
   * D10: in `over` or `dock` an aside hides the box (and its paste strip):
   * at once fully transparent and not taking the pointer (`aside-hidden`);
   * while D2's typing grace keeps the keyboard in it, still focusable, then
   * `visibility: hidden` (`aside-gone`). In `under` the aside is the v1.31
   * one (dimmed in place). While the hidden box holds a draft, "Draft kept"
   * shows at the pane's bottom right, announced once per aside. Called on
   * every aside change, placement change, grace timer, focus move and edit.
   */
  private syncComposeAsideLook(): void {
    if (!this.draftNote) return;
    const hide = this.composeAside !== null && this.composePlacement !== 'under';
    const grace = hide && this.composeKeyboardTimer !== null && this.editorInput.hasFocus();
    for (const el of [this.editorContainer, this.pasteStrip]) {
      el.classList.toggle('aside-hidden', hide);
      el.classList.toggle('aside-gone', hide && !grace);
    }
    this.typeHereButton.hidden = !(hide && this.composeAside === 'menu');
    // "Draft kept" is for a `blocked` aside; a menu aside has "Type here".
    const note = hide && this.composeAside === 'blocked' && this.editorInput.getValue().trim() !== '';
    if (this.draftNote.hidden !== note) return;
    this.draftNote.hidden = !note;
    if (note && !this.draftNoteAnnounced) {
      this.draftNoteAnnounced = true;
      announce('Draft kept');
    }
  }

  /** The pane is in the document and neither it nor an ancestor (its tab)
   *  is display:none. */
  private isOnScreen(): boolean {
    if (!this.element.isConnected) return false;
    for (let el: Element | null = this.element; el; el = el.parentElement) {
      if (getComputedStyle(el).display === 'none') return false;
    }
    return true;
  }

  private clearComposeKeyboardTimer(): void {
    if (this.composeKeyboardTimer !== null) {
      clearTimeout(this.composeKeyboardTimer);
      this.composeKeyboardTimer = null;
    }
  }

  /** The box back in place. It takes the keyboard back only from this pane's
   *  terminal or from nowhere (and never as it disengages). */
  private composeBack(reason: string): void {
    const afterMs = Date.now() - this.composeAsideAtMs;
    this.composeAside = null;
    this.clearComposeKeyboardTimer();
    this.editorContainer.classList.remove('aside');
    this.editorInput.setAside(null);
    this.draftNoteAnnounced = false;
    this.syncComposeAsideLook(); // shown again where it was (D10)
    rlog('info', '[COMPOSE] back', { pane: this.id, reason, afterMs });
    if (!this.composeFirstEngaged) return;
    const active = document.activeElement;
    const nothingFocused = !active || active === document.body;
    const take = composeBackTakesKeyboard({
      terminalHasFocus: !nothingFocused && this.terminalContainer.contains(active),
      nothingFocused,
      paneFocused: this._isFocused,
      overlayFocused: Pane.isOverlayFocused(),
    });
    if (!take) return;
    this.composeHandedOff = false;
    this.editorInput.focus();
  }

  /** He chose the box with a click (in the box, or on "Type here" while it is
   *  hidden by a menu aside): a pending question keyboard move is dropped
   *  (D2), a menu aside ends and the box takes the keyboard (D3), a hand-off
   *  is reclaimed. */
  private chooseBoxByClick(): void {
    // D2: a click in the box while a question's keyboard move is pending
    // means he chose the box: the move is dropped for this aside spell (the
    // box stays dimmed and sends stay held while Claude asks).
    if (this.composeAside === 'blocked' && this.composeKeyboardTimer !== null) {
      this.clearComposeKeyboardTimer();
      rlog('info', '[COMPOSE] aside keyboard kept', { pane: this.id, reason: 'click' });
    }
    // D3: a click in the box ends a menu aside and takes the keyboard.
    if (this.composeAside === 'menu') {
      this.composeMenuPending = false;
      this.syncComposeAside('click');
      this.editorInput.focus();
    }
    if (this.composeFirstEngaged && this.composeHandedOff) {
      this.composeHandedOff = false;
      rlog('info', '[COMPOSE] reclaim', { pane: this.id, reason: 'click' });
    }
  }

  /** D4: after a click in the terminal has run (xterm focused itself), the
   *  box takes the keyboard back, unless the click moved it out of this pane. */
  private keepBoxKeyboard(): void {
    if (this.disposed || !this.composeFirstEngaged || this.composeAside !== null || this.composeHandedOff) return;
    if (Pane.isOverlayFocused()) return;
    const active = document.activeElement;
    if (active && active !== document.body && !this.element.contains(active)) return;
    this.editorInput.focus();
  }

  // --- One typing bar: placement (docs/compose-box.md D8–D10, D12) ---

  /** Readings of Claude's bar after xterm has parsed a write, on scroll and
   *  on resize (at most once per animation frame); the box keeps its overlay
   *  geometry and the paste strip in step; a wheel over the box scrolls the
   *  terminal. Called once from the constructor. */
  private wireComposePlacement(): void {
    this.element.dataset.composePlacement = this.composePlacement;
    const term = this.terminalView.terminal;
    // The theme or the OS light/dark mode changed the terminal's background.
    this.disposables.push(this.terminalView.onFrameColor(() => this.applyOverlayColor()));
    const subs = [
      term.onWriteParsed(() => {
        this.composeWriteSeq++;
        this.scheduleBarReading();
      }),
      term.onScroll(() => this.scheduleBarReading()),
      term.onResize(() => this.scheduleBarReading()),
      // A scroll of the viewport alone (wheel, scrollbar) is caught here too,
      // in case onScroll doesn't report it: only a changed viewportY reads.
      term.onRender(() => {
        if (this.composePlacement === 'under' && this.barLastMatchMs === null) return;
        const y = term.buffer.active.viewportY;
        if (y === this.barViewportY) return;
        this.barViewportY = y;
        this.scheduleBarReading();
      }),
    ];
    this.disposables.push(() => { for (const d of subs) d.dispose(); });
    // D15: Interface Text Size changes the box's chrome and Send's height.
    this.disposables.push(onUiTextScaleApplied(() => {
      if (this.disposed) return;
      this.editorInput.refreshSize();
      this.syncComposeRoom('ui-scale');
    }));

    // The keyboard back in the box (after a hand-off): placement is worked
    // out again (D9).
    const editorFocusIn = () => this.scheduleBarReading();
    this.editorContainer.addEventListener('focusin', editorFocusIn);
    this.disposables.push(() => this.editorContainer.removeEventListener('focusin', editorFocusIn));

    // D10: the box hidden by an aside keeps its keyboard only through the
    // typing grace, and "Draft kept" follows the draft typed in that time.
    const asideLook = () => this.syncComposeAsideLook();
    for (const type of ['focusout', 'input'] as const) {
      this.editorContainer.addEventListener(type, asideLook);
      this.disposables.push(() => this.editorContainer.removeEventListener(type, asideLook));
    }

    // D12: a wheel over the box, outside a textarea that can still scroll
    // that way, scrolls the terminal. On the box's own element, not the
    // terminal's DOM (docs/reference/xterm-internals.md).
    const boxWheel = (e: WheelEvent) => {
      if (this.composePlacement === 'under' || e.deltaY === 0) return;
      const ta = (e.target as Element | null)?.closest?.('textarea');
      if (ta) {
        const canScroll = e.deltaY < 0 ? ta.scrollTop > 0 : ta.scrollTop + ta.clientHeight < ta.scrollHeight;
        if (canScroll) return;
      }
      e.preventDefault();
      const cellH = this.terminalCellHeight();
      const lines = e.deltaMode === WheelEvent.DOM_DELTA_LINE ? e.deltaY
        : e.deltaMode === WheelEvent.DOM_DELTA_PAGE ? e.deltaY * this.terminalView.terminal.rows
          : cellH > 0 ? e.deltaY / cellH : 0;
      this.composeWheelLines += lines;
      const whole = Math.trunc(this.composeWheelLines);
      if (whole === 0) return;
      this.composeWheelLines -= whole;
      this.terminalView.terminal.scrollLines(whole);
    };
    this.editorContainer.addEventListener('wheel', boxWheel, { passive: false });
    this.disposables.push(() => this.editorContainer.removeEventListener('wheel', boxWheel));
  }

  /** Read Claude's bar at the next animation frame (one reading per frame). */
  private scheduleBarReading(): void {
    if (this.disposed || this.barReadFrame !== null || !this.barReadingsWanted()) return;
    this.barReadFrame = requestAnimationFrame(() => {
      this.barReadFrame = null;
      this.takeBarReading();
    });
  }

  /** Readings are taken only while they can move the box. */
  private barReadingsWanted(): boolean {
    return this.composeFirstEngaged && this.composeOverBarSetting && !this.composePlacementFrozen
      && !this.composeHandedOff;
  }

  private takeBarReading(): void {
    if (this.disposed || !this.barReadingsWanted()) return;
    const buffer = this.terminalView.terminal.buffer.active;
    const reading = readClaudeBar(buffer);
    this.barViewportY = buffer.viewportY;
    const inView = reading.found && barRowsInView(reading.row, buffer.viewportY, this.terminalView.terminal.rows);
    const step = placementForReading({
      overSetting: this.composeOverBarSetting,
      handedOff: this.composeHandedOff,
      reading,
      inView,
      current: this.composePlacement,
    });
    if (step === null) {
      this.noteBarNotEmpty('why' in reading ? reading.why : 'holds-text');
      return;
    }
    if (reading.found && reading.empty) {
      this.barRow = reading.row;
      this.barLastMatchMs = Date.now();
      this.barMissSinceMs = null;
      this.barLostReason = 'lost';
      this.barWaitHoldsText = false;
      this.clearBarLostTimer();
      // D15 settling: the bar as Claude redrew it (after a resize, only a
      // reading after a write counts: one straight after a resize that grew
      // the terminal still finds the bar at its pre-redraw row).
      const settle = this.composeSettle;
      if (settle !== null) {
        if (!settle.resize || this.composeWriteSeq > settle.writeSeq) this.endComposeSettle(true);
        else settle.foundEarly = true;
      }
      this.runKeptComposeRoom();
    }
    if (step.reason !== 'setting' && step.reason !== 'handoff' && !this.switchMayHappen(step.placement)) return;
    this.setComposePlacement(step.placement, step.reason);
    this.layoutComposeOverlay(false); // a found-and-empty reading mostly changes nothing
  }

  /** D9, no loop: a reading changes the placement across `under` and the
   *  overlays at most once per COMPOSE_SWITCH_MIN_MS. Too soon: false, and a
   *  timer takes a fresh reading when the time is up, which decides again. */
  private switchMayHappen(next: ComposePlacement): boolean {
    if ((this.composePlacement === 'under') === (next === 'under')) return true;
    const wait = this.composeSwitchMs + COMPOSE_SWITCH_MIN_MS - Date.now();
    if (wait <= 0) return true;
    this.armBarLostTimer(wait);
    return false;
  }

  /** A reading with no empty bar (it missed the bar, or the bar holds text):
   *  keep the last good position; the box goes under once COMPOSE_BAR_LOST_MS
   *  pass with no empty-bar reading (D9). A reading within
   *  COMPOSE_OWN_TYPING_MS of this pane's own typing into Claude doesn't
   *  count: the wait starts no earlier than that window's end, and the bar is
   *  read again then (a still screen sends no further writes). Each timer
   *  takes a fresh reading, which decides. */
  private noteBarNotEmpty(why: BarMissReason | 'holds-text'): void {
    const now = Date.now();
    // Readings in the window after this pane's own typing don't count.
    const ownEnd = this.composeOwnTypingMs + COMPOSE_OWN_TYPING_MS;
    if (now < ownEnd) {
      this.armBarLostTimer(ownEnd - now);
      return;
    }
    // Nor does a miss while the screen is the one Patton's own resize trimmed
    // and Claude has yet to redraw (D15 settling): the settling's end, at the
    // latest its ceiling, reads again. Once a reading has found the bar whole
    // after the resize (a resize that grew the terminal trims nothing) misses
    // are Claude's own and count; so does a bar that holds text (both rules
    // found).
    const s = this.composeSettle;
    if (why !== 'holds-text' && s !== null && s.resize && !s.foundEarly) return;
    if (why === 'holds-text') {
      this.barWaitHoldsText = true;
    } else {
      this.barWaitHoldsText = false;
      this.barLastMissWhy = why;
    }
    if (this.barLastMatchMs === null) {
      this.barLost();
      return;
    }
    // The run starts at its first counting miss: a miss has to persist
    // COMPOSE_BAR_LOST_MS, whatever the age of the last match.
    if (this.barMissSinceMs === null) this.barMissSinceMs = now;
    const left = this.barMissSinceMs + COMPOSE_BAR_LOST_MS - now;
    if (left <= 0) this.barLost();
    else this.armBarLostTimer(left);
  }

  private armBarLostTimer(ms: number): void {
    this.clearBarLostTimer();
    this.barLostTimer = setTimeout(() => {
      this.barLostTimer = null;
      if (this.disposed || !this.barReadingsWanted()) return;
      this.takeBarReading();
    }, ms);
  }

  /** This pane is typing into Claude itself (D9): readings for the next
   *  COMPOSE_OWN_TYPING_MS don't count toward the lost wait. */
  private noteOwnTyping(): void {
    this.composeOwnTypingMs = Date.now();
  }

  /** No empty-bar reading for 400 ms: under, reason holds-text when the
   *  last counting reading found the bar holding text, else lost (or
   *  aside-end). A bar lost from the overlays (not one never found, as before
   *  Claude has drawn it) logs `[COMPOSE] bar not found`, at most once a
   *  minute per pane. */
  private barLost(): void {
    if (this.composePlacement === 'under') return;
    if (!this.switchMayHappen('under')) return;
    if (this.barWaitHoldsText) {
      this.setComposePlacement('under', 'holds-text');
      return;
    }
    const now = Date.now();
    if (now - this.barNotFoundLoggedMs >= COMPOSE_BAR_NOT_FOUND_LOG_MS) {
      this.barNotFoundLoggedMs = now;
      rlog('info', '[COMPOSE] bar not found', { pane: this.id, why: this.barLastMissWhy });
    }
    this.setComposePlacement('under', this.barLostReason);
  }

  private clearBarLostTimer(): void {
    if (this.barLostTimer !== null) {
      clearTimeout(this.barLostTimer);
      this.barLostTimer = null;
    }
  }

  /** Move the box. The terminal resizes on a change between `under` and the
   *  overlays (in the overlays it takes the pane's whole height, less the rows
   *  a long draft has it give up, D15); going under gives those rows back in
   *  the same refit. */
  private setComposePlacement(next: ComposePlacement, reason: ComposePlacementReason): void {
    if (next === this.composePlacement) return;
    const from = this.composePlacement;
    const gridBefore = this.terminalView.getDimensions();
    this.composePlacement = next;
    rlog('info', '[COMPOSE] place', { pane: this.id, placement: next, from, reason });
    this.element.dataset.composePlacement = next;
    for (const el of [this.editorContainer, this.pasteStrip]) {
      el.classList.toggle('placement-over', next === 'over');
      el.classList.toggle('placement-dock', next === 'dock');
    }
    if (next === 'under') this.clearComposeOverlayStyle();
    else this.layoutComposeOverlay();
    this.syncComposeAsideLook();
    // The height cap differs between under and the overlays: apply it before
    // the refit, so a long draft refits once (a box that changes height after
    // the refit would make the resize observer refit again).
    // The hold's inputs are read first: refreshSize can fire onContentHeight,
    // which (placement already `under`) takes the rows back through
    // syncComposeRoom, so afterwards a room resize more than a second old reads
    // as k 0 and no hold would be set.
    const roomRowsBefore = this.composeRoomRows;
    const roomMsBefore = this.composeRoomMs;
    this.editorInput.refreshSize();
    if (next === 'under') {
      // Anti-flap (D15, S60): the bar lost soon after a room resize (Claude
      // slower to redraw than the settling's ceiling): no rows are given up
      // again until the draft's content changes.
      if ((reason === 'lost' || reason === 'aside-end') && roomRowsBefore > 0
        && Date.now() - roomMsBefore < COMPOSE_ROOM_HOLD_MS) {
        this.composeRoomHeld = true;
        this.composeRoomHeldLogged = false;
        this.composeRoomHeldDraft = this.editorInput.getValue();
      }
      this.clearComposeRoom(reason);
    }
    if ((from === 'under') !== (next === 'under')) {
      const now = Date.now();
      this.composeRefitMs = now;
      // Only a change a reading made counts toward the once-a-second rule: his
      // own moves (the hand-off, the setting, closing the box) break any chain.
      const byReading = reason === 'found' || reason === 'holds-text' || reason === 'lost' || reason === 'aside-end';
      this.composeSwitchMs = byReading ? now : -Infinity;
      this.refitTerminal('placement', gridBefore);
    }
    // D15: a placement change works k out again (into an overlay, after the
    // refit just made: D9's once-a-second rule holds it back a second).
    if (next !== 'under') this.syncComposeRoom('placement');
  }

  /** D15: k for the box as it stands, or null when the pane isn't laid out
   *  (a hidden tab: show() works it out again). Never called from a bar
   *  reading: only on content-height and placement changes. */
  private composeRoomWanted(): number | null {
    if (!this.composeFirstEngaged || this.composePlacement === 'under') return 0;
    const cellH = this.terminalCellHeight();
    const paneH = this.element.clientHeight;
    if (cellH <= 0 || paneH <= 0) return null;
    this.composeRoomPaneH = paneH;
    const term = this.terminalView.terminal;
    const barViewRow = this.barRow - term.buffer.active.viewportY;
    const cs = getComputedStyle(this.editorContainer);
    const px = (v: string) => parseFloat(v) || 0;
    const chrome = px(cs.paddingTop) + px(cs.paddingBottom) + px(cs.borderTopWidth) + px(cs.borderBottomWidth);
    return composeRoomRows({
      placement: this.composePlacement,
      oneLine: this.editorInput.isOneLine(),
      neededPx: this.editorInput.naturalHeight() + chrome,
      cellH,
      paneH,
      rowsBelowBar: term.rows - 1 - (barViewRow + 1),
    });
  }

  /** D15: k depends on the bar's row only in 'over' with a draft of more
   *  than one line (one line: 0; 'dock': from the terminal's bottom; under: 0). */
  private composeRoomNeedsBar(): boolean {
    return this.composeFirstEngaged && this.composePlacement === 'over' && !this.editorInput.isOneLine();
  }

  /** D15: bring the rows the terminal gives up in line with the box's
   *  contents. Asked by a non-reading trigger only (content, chip, placement,
   *  pane size, show, font, UI scale, an aside's end); `run` 2 is the one
   *  confirmation a room resize asks for (setComposeRoom). Not during an aside
   *  or while Claude asks (the terminal keeps its size, so the question is
   *  drawn once). While Claude has yet to redraw after Patton's own resize
   *  (settling) a k that needs the bar's row waits for the first fresh
   *  reading, then runs once (endComposeSettle). A change due within a second
   *  of Patton's last resize waits for that second (D9) and is decided again. */
  private syncComposeRoom(reason: string, run = 1): void {
    if (this.disposed || this.composePlacementFrozen) return;
    if (this.composeRoomHeld && this.editorInput.getValue() !== this.composeRoomHeldDraft) this.composeRoomHeld = false;
    if (this.composeSettle !== null && this.composeRoomNeedsBar()) {
      this.composeRoomPending = { reason, run };
      this.clearComposeRoomTimer();
      return;
    }
    let want = this.composeRoomWanted();
    if (want === null) return;
    if (this.composeRoomHeld && want > this.composeRoomRows) {
      if (!this.composeRoomHeldLogged) {
        this.composeRoomHeldLogged = true;
        rlog('info', '[COMPOSE] room held', { pane: this.id, reason });
      }
      want = this.composeRoomRows;
    }
    if (want === this.composeRoomRows) {
      this.clearComposeRoomTimer();
      return;
    }
    const wait = Math.max(this.composeRefitMs, this.composeRoomMs) + COMPOSE_SWITCH_MIN_MS - Date.now();
    if (wait > 0) {
      this.clearComposeRoomTimer();
      this.composeRoomTimer = setTimeout(() => {
        this.composeRoomTimer = null;
        this.syncComposeRoom(reason, run);
      }, wait);
      return;
    }
    this.setComposeRoom(want, reason, run);
  }

  /** D15 settling (S60): Patton resized the terminal itself (`resize`), or an
   *  aside ended, so `barRow` may be stale until Claude redraws. Ends at the
   *  first empty-bar reading (after a write, for a resize) or at
   *  COMPOSE_SETTLE_MAX_MS. A second one before the end restarts the clock. */
  private openComposeSettle(cause: string, resize: boolean): void {
    if (this.disposed || !this.composeFirstEngaged || !this.composeOverBarSetting) return;
    const prev = this.composeSettle;
    if (this.composeRoomKept !== null) { // a ceiling's kept ask: this settling takes it over
      if (this.composeRoomPending === null) this.composeRoomPending = this.composeRoomKept;
      this.composeRoomKept = null;
    }
    this.composeSettle = {
      sinceMs: Date.now(), cause, resize: resize || (prev?.resize ?? false), writeSeq: this.composeWriteSeq, foundEarly: false,
    };
    if (this.composeSettleTimer !== null) clearTimeout(this.composeSettleTimer);
    this.composeSettleTimer = setTimeout(() => {
      this.composeSettleTimer = null;
      this.endComposeSettle(false);
    }, COMPOSE_SETTLE_MAX_MS);
  }

  /** The settling ends: `found`, a fresh empty-bar reading (run the k that
   *  waited, once), or the ceiling (misses count again from here; the k that
   *  waited runs only if a reading found the bar meanwhile, else the lost
   *  wait decides and a later `over` asks again). Logs `[COMPOSE] settled`,
   *  at most once a second per pane (the rest counted in `skipped`). */
  private endComposeSettle(found: boolean): void {
    const s = this.composeSettle;
    if (s === null) return;
    this.composeSettle = null;
    if (this.composeSettleTimer !== null) {
      clearTimeout(this.composeSettleTimer);
      this.composeSettleTimer = null;
    }
    const now = Date.now();
    if (this.composeFirstEngaged) {
      if (now - this.composeSettledLogMs >= COMPOSE_SETTLED_LOG_MS) {
        const skipped = this.composeSettledSkipped;
        rlog('info', '[COMPOSE] settled', {
          pane: this.id, cause: s.cause, afterMs: now - s.sinceMs, found, ...(skipped > 0 ? { skipped } : {}),
        });
        this.composeSettledLogMs = now;
        this.composeSettledSkipped = 0;
      } else {
        this.composeSettledSkipped++;
      }
    }
    const pending = this.composeRoomPending;
    this.composeRoomPending = null;
    if (pending !== null && (found || s.foundEarly)) this.syncComposeRoom(pending.reason, pending.run);
    else if (pending !== null) this.composeRoomKept = pending; // the ceiling, no reading: the next one runs it
    if (!found) this.scheduleBarReading();
  }

  /** A found-empty reading after a ceiling that left a k decision waiting
   *  (composeRoomKept) runs that decision once, while the box is over or
   *  docked and no settling is open (an open one has taken it over). The
   *  reading starts nothing itself: the ask is the trigger's. */
  private runKeptComposeRoom(): void {
    const kept = this.composeRoomKept;
    if (kept === null || this.composeSettle !== null) return;
    this.composeRoomKept = null;
    if (this.composePlacement === 'under') return;
    this.syncComposeRoom(kept.reason, kept.run);
  }

  /** Give up k rows at the terminal's bottom (0: take them back), tell the
   *  PTY, lay the box out again. The refit opens a settling; the trigger's
   *  first run asks once more (run 2) for when Claude has redrawn, which by
   *  then finds the same k (the bar back at the bottom with its footer). */
  private setComposeRoom(rows: number, reason: string, run = 1): void {
    this.clearComposeRoomTimer();
    const from = this.composeRoomRows;
    if (rows === from) return;
    const before = this.terminalView.getDimensions();
    this.composeRoomRows = rows;
    const now = Date.now();
    this.composeRoomMs = now;
    this.composeRefitMs = now;
    this.composeRoomPending = null;
    this.composeRoomKept = null;
    this.terminalView.setRowsGivenUp(rows);
    this.refitTerminal('room', before);
    if (this.composeSettle !== null && run < 2) this.composeRoomPending = { reason, run: run + 1 };
    rlog('info', '[COMPOSE] room', { pane: this.id, rows, from, placement: this.composePlacement, reason });
    this.layoutComposeOverlay();
  }

  /** k back to 0 as the box goes under or closes: in the caller's own refit. */
  private clearComposeRoom(reason: string): void {
    this.clearComposeRoomTimer();
    this.composeRoomPending = null;
    this.composeRoomKept = null;
    if (this.composeRoomRows === 0) return;
    const from = this.composeRoomRows;
    this.composeRoomRows = 0;
    this.composeRoomMs = Date.now();
    this.terminalView.setRowsGivenUp(0);
    rlog('info', '[COMPOSE] room', { pane: this.id, rows: 0, from, placement: this.composePlacement, reason });
  }

  private clearComposeRoomTimer(): void {
    if (this.composeRoomTimer !== null) {
      clearTimeout(this.composeRoomTimer);
      this.composeRoomTimer = null;
    }
  }

  /** xterm's cell height in CSS px: the render service sets `.xterm-screen`'s
   *  CSS height to rows × the cell height (dimensions.css.canvas.height), for
   *  the DOM and WebGL renderers alike. 0 while the pane isn't laid out. */
  private terminalCellHeight(): number {
    const screen = this.terminalScreen();
    const rows = this.terminalView.terminal.rows;
    if (!screen || !rows) return 0;
    return screen.getBoundingClientRect().height / rows;
  }

  private terminalScreen(): HTMLElement | null {
    const root = this.terminalView.terminal.element;
    const screen = root instanceof HTMLElement ? root.querySelector('.xterm-screen') : null;
    return screen instanceof HTMLElement ? screen : null;
  }

  /** Lay the overlay on xterm's grid: left and right on the grid's edges,
   *  its top on the top of row R-1 ('over') or of the third row up from the
   *  terminal's bottom ('dock'), three rows tall at least, growing DOWN (D15):
   *  over the rows below Claude's bar, then the rows the terminal gave up,
   *  capped at a third of the pane and at the pane's bottom. `force` false (a
   *  bar reading that found the bar empty again): nothing is measured when the
   *  bar's row, the viewport, the rows, the pane's size, the font and k are
   *  the same as at the last layout. Never changes k (syncComposeRoom). */
  private layoutComposeOverlay(force = true): void {
    if (this.composePlacement === 'under') return;
    const screen = this.terminalScreen();
    const rows = this.terminalView.terminal.rows;
    if (!screen || !rows) return;
    const term = this.terminalView.terminal;
    const key = [
      this.composePlacement, this.barRow, term.buffer.active.viewportY, rows, this.composeRoomRows,
      this.element.clientWidth, this.element.clientHeight, term.options.fontSize, term.options.fontFamily,
      term.options.lineHeight,
    ].join('|');
    if (!force && key === this.overlayLayoutKey) return;
    const sr = screen.getBoundingClientRect();
    const pr = this.element.getBoundingClientRect();
    const cellH = sr.height / rows;
    if (cellH <= 0 || pr.height <= 0) return; // hidden tab: show() lays it out again
    this.overlayLayoutKey = key;
    const viewportY = this.terminalView.terminal.buffer.active.viewportY;
    const topRow = this.composePlacement === 'over' ? this.barRow - 1 - viewportY : rows - 3;
    const topEdge = sr.top - pr.top + topRow * cellH;
    const st = this.editorContainer.style;
    st.left = `${sr.left - pr.left}px`;
    st.width = `${sr.width}px`;
    st.top = `${topEdge}px`;
    st.bottom = '';
    const third = Math.floor(pr.height * COMPOSE_OVERLAY_MAX_FRACTION);
    const toPaneBottom = Math.floor(pr.height - topEdge);
    const maxPx = Math.max(3 * cellH, Math.min(third, toPaneBottom));
    // With rows given up (D15) the box reaches the pane's bottom, cap or not:
    // k is whole rows from the capped need, so the cap alone would stop the
    // box up to a row and a half short and show Claude's footer in the gap.
    // The box then passes a third of the pane by under a row; the textarea's
    // own cap (overlayMaxPx) stays a third, so the text still scrolls inside.
    const fillPx = this.composeRoomRows > 0 ? Math.max(maxPx, toPaneBottom) : 0;
    st.minHeight = `${fillPx > 0 ? fillPx : 3 * cellH}px`;
    st.maxHeight = `${Math.max(maxPx, fillPx)}px`;
    this.applyOverlayColor();
    this.placePasteStrip();
    // The textarea's own cap follows the room below the box's top (its text
    // scrolls inside past it); its natural height, which k is worked out
    // from, does not change with the cap.
    if (maxPx !== this.overlayMaxPx) {
      this.overlayMaxPx = maxPx;
      this.editorInput.refreshSize();
    }
  }

  /** Opaque in the terminal's own background: terminal-view.ts sets --term-bg
   *  on the terminal's container (not on the pane), so the overlay takes a
   *  copy, laid out again whenever the theme or the OS light/dark mode moves it. */
  private applyOverlayColor(): void {
    if (this.composePlacement === 'under') return;
    const st = this.editorContainer.style;
    const termBg = this.terminalContainer.style.getPropertyValue('--term-bg');
    if (termBg) st.setProperty('--term-bg', termBg);
    else st.removeProperty('--term-bg');
  }

  /** In the overlays the paste strip sits on the box's top edge (D12). */
  private placePasteStrip(): void {
    const st = this.pasteStrip.style;
    if (this.composePlacement === 'under') {
      st.left = st.width = st.bottom = '';
      return;
    }
    const box = this.editorContainer.style;
    st.left = box.left;
    st.width = box.width;
    st.bottom = `${this.element.getBoundingClientRect().height - (parseFloat(box.top) || 0)}px`;
  }

  private clearComposeOverlayStyle(): void {
    this.overlayLayoutKey = '';
    this.overlayMaxPx = 0;
    const st = this.editorContainer.style;
    st.left = st.width = st.top = st.bottom = st.minHeight = st.maxHeight = '';
    st.removeProperty('--term-bg');
    this.placePasteStrip();
  }

  /** D10: placement freezes from Claude's first `blocked` report (the live
   *  fact, before the 250 ms hold) and through any aside; when that ends the
   *  box is where it was and readings resume, `under` if the bar isn't found
   *  within 400 ms. Called after every aside sync and on disengage. */
  private syncComposeFreeze(): void {
    const frozen = this.composeFirstEngaged && (this.composeAside !== null || this.claudeAsksNow());
    if (frozen === this.composePlacementFrozen) return;
    this.composePlacementFrozen = frozen;
    if (frozen) {
      this.clearBarLostTimer();
      if (this.barReadFrame !== null) {
        cancelAnimationFrame(this.barReadFrame);
        this.barReadFrame = null;
      }
      return;
    }
    if (this.composeHandedOff) {
      this.setComposePlacement('under', 'handoff'); // handed off during the freeze (D10)
      return;
    }
    if (this.composePlacement !== 'under') {
      this.barLastMatchMs = Date.now();
      this.barMissSinceMs = null;
      this.barLostReason = 'aside-end';
    }
    // D15: the draft may have changed meanwhile, and output may have moved
    // Claude's bar with readings frozen: k waits for the first fresh reading.
    if (this.composePlacement !== 'under') this.openComposeSettle('aside-end', false);
    this.scheduleBarReading();
    this.syncComposeRoom('aside-end');
  }

  /** ⌘C in a box with nothing selected: this pane's terminal selection. */
  private terminalCopyFallback(): string {
    const sel = this.terminalView.terminal.getSelection();
    if (sel) rlog('info', '[COMPOSE] copy terminal selection', { pane: this.id, chars: sel.length });
    return sel;
  }

  private engageComposeFirst(reason: string): void {
    this.composeFirstEngaged = true;
    this.composeSwitchMs = -Infinity; // his own move: the first reading never waits
    this.syncPasteChipViews(false); // D14: the thumbnails too
    this.composeHandedOff = false;
    this.editorContainer.classList.add('compose-first');
    this.editorContainer.classList.remove('collapsed');
    this.editorInput.setPlaceholder(Pane.COMPOSE_FIRST_PLACEHOLDER);
    this.editorInput.setSpellcheck(true); // messages to Claude are prose
    this.editorInput.refreshSize();
    rlog('info', '[COMPOSE] engage', { pane: this.id, reason });
    this.scheduleBarReading();
    // Opened during a question or menu: aside from the start (D2, D3), and
    // the keyboard is not the box's to take.
    this.syncComposeAside(reason);
    if (this.composeAside !== null) return;
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
    this.composeRoomKept = null;
    this.syncPasteChipViews(false); // D14: the thumbnails back in the strip
    this.composeHandedOff = false;
    this.editorContainer.classList.remove('compose-first');
    this.editorContainer.classList.add('collapsed'); // the draft stays; ⌘E shows it
    this.editorInput.setPlaceholder(DEFAULT_COMPOSE_PLACEHOLDER);
    this.editorInput.setSpellcheck(false);
    this.editorInput.refreshSize();
    rlog('info', '[COMPOSE] disengage', { pane: this.id, reason });
    // Closed, the box starts again from `under` until a reading matches.
    this.setComposePlacement('under', 'disengage');
    this.barLastMatchMs = null;
    this.barMissSinceMs = null;
    this.composeSwitchMs = -Infinity; // his own move: the next reading never waits
    this.clearBarLostTimer();
    if (hadFocus) this.terminalView.focus();
  }

  /** Give the keyboard to the terminal (Claude's own prompt), keeping the draft. */
  private handOffCompose(key: 'Escape' | 'click'): void {
    if (!this.composeHandedOff) {
      this.composeHandedOff = true;
      rlog('info', '[COMPOSE] handoff', { pane: this.id, key, route: 'focus' });
    }
    this.composeSwitchMs = -Infinity; // his own move: the return never waits
    // D9: handed off, the box goes under so he sees Claude's bar too; the
    // focusin of its return reads the bar again. D10: not while placement is
    // frozen (an aside, or Claude asking): the box stays where it is, hidden,
    // and the freeze's end works placement out (under if still handed off).
    if (this.composePlacementFrozen) {
      rlog('info', '[COMPOSE] handoff placement deferred', { pane: this.id });
    } else {
      this.setComposePlacement('under', 'handoff');
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
    // D2: while Claude asks, nothing goes from the box to Claude (an Enter
    // would pick the default option, Esc cancel the question): he answers in
    // the terminal, and the keys stay in the box. A `menu` aside forwards.
    if (this.claudeAsksNow()) return false;
    if (e.metaKey || e.ctrlKey || e.altKey) return false;
    const seq = this.composeKeySequence(e);
    if (seq === null) return false;
    window.patton.pty.write(this.ptyId, seq);
    if (seq === '\r') this.noteEnterSent();
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
    if (this.composePlacement !== 'under') {
      // The overlay grows down to a third of the pane, or to the pane's
      // bottom if that is nearer (D15); the textarea leaves room for the
      // overlay's own padding and rules.
      const cap = this.overlayMaxPx > 0 ? this.overlayMaxPx
        : Math.floor(this.element.clientHeight * COMPOSE_OVERLAY_MAX_FRACTION);
      return Math.max(1, cap - Pane.COMPOSE_OVERLAY_CHROME_PX);
    }
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
      if (this.composeAside === null) this.editorInput.focus();
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
      // Like a click in the box, ⌘E ends a menu aside (D3).
      if (this.composeAside === 'menu') {
        this.composeMenuPending = false;
        this.syncComposeAside('toggle-key');
      }
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
    if (this.isComposeExpanded() && !this.composeHandedOff && this.composeAside === null && !Pane.isOverlayFocused()) {
      this.editorInput.focus();
    } else {
      this.terminalView.focus();
    }
  }

  show(): void {
    this.element.style.display = 'flex';
    // D15: the rows given up are given up again, measured, before the fit
    // (a font change or resize while hidden couldn't measure them).
    const before = this.terminalView.getDimensions();
    if (this.composeRoomRows > 0) this.terminalView.setRowsGivenUp(this.composeRoomRows);
    else this.terminalView.fit();
    const dims = this.terminalView.getDimensions();
    // A new size (a split, a pane closed, zoom, swap): Claude redraws after the
    // resize observer tells the PTY, so k waits for that (settling, S60).
    if (dims.rows !== before.rows || dims.cols !== before.cols) this.openComposeSettle('show', true);
    // Always: a resize skipped while the tab was hidden (display:none) is redone here.
    this.editorInput.refreshSize();
    this.layoutComposeOverlay();
    this.syncComposeRoom('show'); // k for the font and pane size as they are now
    this.scheduleBarReading();
  }

  hide(): void {
    this.element.style.display = 'none';
  }

  setFontSize(size: number): void {
    const before = this.terminalView.getDimensions();
    this.terminalView.setFontSize(size);
    this.editorInput.setFontSize(size);
    this.afterFontChange(before);
  }

  setFontFamily(family: string): void {
    const before = this.terminalView.getDimensions();
    this.terminalView.setFontFamily(family);
    this.editorInput.setFontFamily(family);
    this.afterFontChange(before);
  }

  /** A new font changes the grid without changing the container, so the
   *  resize observer doesn't fire: tell the PTY here (until S60 a Font Size
   *  change never reached it). D15: the cell height the rows given up are
   *  measured in and the draft's height change too: keep k rows given up,
   *  then work k out again once Claude has redrawn (settling). */
  private afterFontChange(before: { cols: number; rows: number }): void {
    if (this.composeRoomRows > 0) this.terminalView.setRowsGivenUp(this.composeRoomRows);
    this.refitTerminal('font', before);
    this.editorInput.refreshSize();
    this.syncComposeRoom('font');
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
    // The renderer owns the cell metrics the overlay is laid on: lay it out
    // again now and once the new renderer has drawn (D9).
    this.layoutComposeOverlay();
    if (this.composePlacement !== 'under') {
      requestAnimationFrame(() => { if (!this.disposed) this.layoutComposeOverlay(); });
    }
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
    if (this.feedPtyId !== null) this.stopSessionFeed();
    this.disposed = true;
    if (this.resizeTimer) clearTimeout(this.resizeTimer);
    if (this.barRowsTimer !== null) clearTimeout(this.barRowsTimer);
    this.clearComposeBlockedTimer();
    this.clearComposeKeyboardTimer();
    this.clearBarLostTimer();
    this.clearComposeRoomTimer();
    if (this.composeSettleTimer !== null) clearTimeout(this.composeSettleTimer);
    if (this.barReadFrame !== null) cancelAnimationFrame(this.barReadFrame);
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
