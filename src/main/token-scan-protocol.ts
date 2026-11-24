/**
 * The messages between main (main/token-scan-host.ts) and the token worker
 * (main/token-scan-worker.ts). Plain data only: they cross a worker boundary.
 */
import type { LoginSwitch } from '../shared/plan-usage';
import type { TokenWindow } from '../shared/token-credit';

export interface TokenScanRequest {
  id: number;
  /** The transcripts' root (`~/.claude/projects`). */
  root: string;
  /** Epoch seconds: nothing before it is read or kept (shared/token-credit.ts scanFloor). */
  floor: number;
  switches: LoginSwitch[];
  windows: TokenWindow[];
}

export type TokenScanReply =
  | {
      id: number;
      ok: true;
      /** [login id, tokens] for every window asked about. */
      totals: [string, number][];
      files: number;
      filesRead: number;
      bytes: number;
      requests: number;
      skipped: number;
      /** How long the scan and the crediting took, in the worker. */
      ms: number;
    }
  | { id: number; ok: false; error: string };
