export class HistoryManager {
  private entries: string[] = [];
  private entrySet: Set<string> = new Set();
  private cursor = -1;
  private draft = '';
  private static readonly MAX_LOCAL_ENTRIES = 10000;

  async load(): Promise<void> {
    const history = await window.patton.history.get();
    this.entries = history.map(h => h.command);
    this.entrySet = new Set(this.entries);
    this.resetCursor();
  }

  async add(command: string): Promise<void> {
    if (!command.trim()) return;
    await window.patton.history.add(command);
    // Update local — O(1) dedup via Set
    if (this.entrySet.has(command)) {
      const idx = this.entries.indexOf(command);
      if (idx !== -1) this.entries.splice(idx, 1);
    }
    this.entries.push(command);
    this.entrySet.add(command);
    // Cap local entries
    if (this.entries.length > HistoryManager.MAX_LOCAL_ENTRIES) {
      const removed = this.entries.shift();
      if (removed) this.entrySet.delete(removed);
    }
    this.resetCursor();
  }

  up(currentInput: string): string | null {
    if (this.entries.length === 0) return null;

    if (this.cursor === -1) {
      this.draft = currentInput;
      this.cursor = this.entries.length - 1;
    } else if (this.cursor > 0) {
      this.cursor--;
    } else {
      return null; // Already at oldest
    }

    return this.entries[this.cursor];
  }

  down(): string | null {
    if (this.cursor === -1) return null;

    if (this.cursor < this.entries.length - 1) {
      this.cursor++;
      return this.entries[this.cursor];
    } else {
      this.cursor = -1;
      return this.draft;
    }
  }

  resetCursor(): void {
    this.cursor = -1;
    this.draft = '';
  }

  getEntries(): readonly string[] {
    return this.entries;
  }

  async clear(): Promise<void> {
    await window.patton.history.clear();
    this.entries = [];
    this.entrySet.clear();
    this.resetCursor();
  }
}
