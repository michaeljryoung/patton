/**
 * Main's side of the token worker: starts it on first use, sends one scan at a
 * time and resolves with its reply. The worker's script is read here and run
 * with `eval: true`, so the worker starts the same from the asar of a packaged
 * app and from a folder (main's fs reads the asar; a worker's loader may not).
 * A worker that errors or exits is dropped and started afresh on the next scan.
 * No Electron here, so the check runs it under plain Node.
 */
import { promises as fs } from 'node:fs';
import { Worker } from 'node:worker_threads';
import type { TokenScanReply, TokenScanRequest } from './token-scan-protocol';

/** A scan that has not answered in this long is given up on (the worker is ended and started again next time). */
const SCAN_TIMEOUT_MS = 10 * 60 * 1000;

interface Pending {
  resolve: (reply: TokenScanReply) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class TokenScanHost {
  private worker: Worker | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private stopped = false;

  constructor(private readonly scriptPath: string) {}

  async scan(req: Omit<TokenScanRequest, 'id'>): Promise<TokenScanReply> {
    if (this.stopped) throw Object.assign(new Error('stopped'), { code: 'STOPPED' });
    const worker = await this.ensure();
    const id = this.nextId++;
    return new Promise<TokenScanReply>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.fail(Object.assign(new Error('token scan timed out'), { code: 'TIMEOUT' }));
      }, SCAN_TIMEOUT_MS);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      worker.postMessage({ ...req, id } satisfies TokenScanRequest);
    });
  }

  private async ensure(): Promise<Worker> {
    if (this.worker) return this.worker;
    const code = await fs.readFile(this.scriptPath, 'utf8');
    if (this.stopped) throw Object.assign(new Error('stopped'), { code: 'STOPPED' });
    if (this.worker) return this.worker;
    const worker = new Worker(code, { eval: true });
    worker.on('message', (reply: TokenScanReply) => {
      const p = this.pending.get(reply?.id);
      if (!p) return;
      this.pending.delete(reply.id);
      clearTimeout(p.timer);
      p.resolve(reply);
    });
    worker.on('error', (err: unknown) => {
      if (this.worker === worker) this.fail(err instanceof Error ? err : new Error(String(err)));
    });
    worker.on('exit', (code) => {
      if (this.worker === worker) this.fail(Object.assign(new Error(`token worker exited ${code}`), { code: 'WORKER_EXIT' }));
    });
    this.worker = worker;
    return worker;
  }

  /** Reject every waiting scan and drop the worker. */
  private fail(err: Error): void {
    const worker = this.worker;
    this.worker = null;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
    worker?.terminate().catch(() => { /* already gone */ });
  }

  /** On quit: end the worker; waiting scans are rejected. */
  stop(): void {
    this.stopped = true;
    this.fail(Object.assign(new Error('stopped'), { code: 'STOPPED' }));
  }
}
