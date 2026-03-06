export class HistoryManager {
  private entries: string[] = [];
  private cursor = -1;
  private draft = '';

  async load(): Promise<void> {
    const history = await window.patton.history.get();
    this.entries = history.map(h => h.command);
    this.resetCursor();
  }

  async add(command: string): Promise<void> {
    if (!command.trim()) return;
    await window.patton.history.add(command);
    // Update local
    const idx = this.entries.indexOf(command);
    if (idx !== -1) {
      this.entries.splice(idx, 1);
    }
    this.entries.push(command);
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

  getEntries(): string[] {
    return this.entries;
  }

  async clear(): Promise<void> {
    await window.patton.history.clear();
    this.entries = [];
    this.resetCursor();
  }
}
