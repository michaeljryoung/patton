/**
 * The token worker: a worker thread that keeps one TokenScanner (main/token-scan.ts)
 * across scans, so each scan reads only new bytes, and answers each request with
 * every window's credited tokens. Built by Forge as its own file
 * (`.vite/build/token-scan-worker.cjs`, forge.config.ts) and started by
 * main/token-scan-host.ts. Imports only Node built-ins and pure modules.
 */
import { parentPort } from 'node:worker_threads';
import { creditTokens } from '../shared/token-credit';
import { TokenScanner } from './token-scan';
import type { TokenScanReply, TokenScanRequest } from './token-scan-protocol';

const scanner = new TokenScanner();
/** One scan at a time, in arrival order (the host sends one at a time anyway). */
let queue: Promise<void> = Promise.resolve();

async function answer(req: TokenScanRequest): Promise<TokenScanReply> {
  const started = performance.now();
  try {
    const stats = await scanner.scan(req.root, req.floor);
    const totals = creditTokens(scanner.requests(), req.switches, req.windows);
    return { id: req.id, ok: true, totals: [...totals], ...stats, ms: Math.round(performance.now() - started) };
  } catch (err) {
    const e = err as { code?: unknown; name?: unknown } | null;
    const error = typeof e?.code === 'string' ? e.code : typeof e?.name === 'string' ? e.name : 'unknown';
    return { id: req.id, ok: false, error };
  }
}

parentPort?.on('message', (req: TokenScanRequest) => {
  queue = queue.then(async () => {
    parentPort?.postMessage(await answer(req));
  });
});
