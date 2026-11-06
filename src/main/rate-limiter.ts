// Security: sliding-window rate limiter (ring buffer, O(1) operations).
// Shared by the IPC handlers in ipc-handlers.ts and clipboard-image.ts.
export class RateLimiter {
  private readonly ring: number[];
  private head = 0;
  private count = 0;
  private readonly maxCalls: number;
  private readonly windowMs: number;

  constructor(maxCallsPerSecond: number) {
    this.maxCalls = maxCallsPerSecond;
    this.windowMs = 1000;
    this.ring = new Array(maxCallsPerSecond);
  }

  allow(): boolean {
    const now = Date.now();
    const cutoff = now - this.windowMs;
    // Evict expired timestamps from the front of the ring
    while (this.count > 0 && this.ring[this.head] <= cutoff) {
      this.head = (this.head + 1) % this.maxCalls;
      this.count--;
    }
    if (this.count >= this.maxCalls) {
      return false;
    }
    const tail = (this.head + this.count) % this.maxCalls;
    this.ring[tail] = now;
    this.count++;
    return true;
  }
}
