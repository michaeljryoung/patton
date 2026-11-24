/** Patton's own OSC 777 messages from its Claude Code Stop hook (parsed here, pure, so scripts/probe-stop-hook.sh can run it). */
import type { HookCron, HookTask } from '../../shared/session-feed';
import { hookListsFrom } from './hook-lists';

/** The Stop hook's context reading (`ctx=…;since=…[;cpt=…][;cpd=…][;own=…]`): tokens
 *  of the session's latest request, tokens added since the end of its current
 *  /checkpoint's turn, when that checkpoint was asked for (Unix seconds, null
 *  without one), and the same time again once it has finished (`cpd`: sent
 *  only at a Stop with no background task of its own in flight; null before
 *  then, and for a checkpoint that was interrupted). */
export interface ContextReading {
  ctxTokens: number;
  sinceTokens: number;
  checkpointAt: number | null;
  checkpointDoneAt: number | null;
  /** How many of the running tasks are the checkpoint's own (`own`), when the
   *  hook dated them: set only at a checkpoint's Stop with tasks running, so
   *  a `cpd` sent over older work shows in main.log. */
  ownTasks?: number;
}

/** Patton's own OSC 777 messages from its Claude Code Stop hook:
 *  - `stop`: the verdict, i.e. how many background tasks are still in flight
 *    and how many timers are scheduled when the turn ended (both zero means it
 *    really stopped), plus the context reading when the hook could take one;
 *  - `ctx`: the context reading alone, sent when Claude Code gave the hook no
 *    task fields, so it never counts as a verdict. */
export type PattonState =
  | {
      kind: 'stop'; tasks: number; crons: number; context: ContextReading | null;
      /** The running tasks the hook listed (`tl`), when it sent a readable list: shorter than
       *  `tasks` when the hook cut the list to fit Claude Code's length limit. */
      taskList?: HookTask[];
      /** `session_crons` as the hook listed them (`cl`). */
      cronList?: HookCron[];
      /** The session's transcript path (`tp`), shape-checked only; main validates it before use. */
      transcriptPath?: string;
    }
  | { kind: 'ctx'; context: ContextReading };

// Both messages may end in `;key=value` fields: ctx=C;since=S[;cpt=T][;cpd=T][;own=O] (and, on
// a stop, tl, cl and tp: services/hook-lists.ts). They
// are read one by one, so an unknown or malformed field (a future version's)
// costs only itself, never the stop verdict. Token counts are capped at nine
// digits, the timestamp at twelve, the own-task count at four.
const STOP_RE = /^patton;stop;tasks=(\d{1,4});crons=(\d{1,4})(;.*)?$/;
const CTX_RE = /^patton;ctx(;.*)?$/;

function contextFrom(tail: string | undefined): ContextReading | null {
  let ctx: string | undefined;
  let since: string | undefined;
  let cpt: string | undefined;
  let cpd: string | undefined;
  let own: string | undefined;
  for (const field of (tail ?? '').split(';')) {
    const o = /^own=(\d{1,4})$/.exec(field);
    if (o) { own = o[1]; continue; }
    const m = /^(ctx|since|cpt|cpd)=(\d{1,12})$/.exec(field);
    if (!m) continue;
    if (m[1] === 'ctx') ctx = m[2];
    else if (m[1] === 'since') since = m[2];
    else if (m[1] === 'cpt') cpt = m[2];
    else cpd = m[2];
  }
  if (ctx === undefined || since === undefined || ctx.length > 9 || since.length > 9) return null;
  return {
    ctxTokens: Number(ctx),
    sinceTokens: Number(since),
    checkpointAt: cpt === undefined ? null : Number(cpt),
    checkpointDoneAt: cpd === undefined ? null : Number(cpd),
    ...(own === undefined ? {} : { ownTasks: Number(own) }),
  };
}

/** Parse the data of an `OSC 777;patton;…` message (the part after `777;`), or null when it is
 *  neither a stop nor a ctx message. */
export function parsePattonOsc(data: string): PattonState | null {
  const stop = STOP_RE.exec(data);
  if (stop) {
    return {
      kind: 'stop', tasks: Number(stop[1]), crons: Number(stop[2]), context: contextFrom(stop[3]),
      ...hookListsFrom(stop[3]),
    };
  }
  const ctx = CTX_RE.exec(data);
  if (ctx) {
    const context = contextFrom(ctx[1]);
    if (context) return { kind: 'ctx', context };
  }
  return null;
}
