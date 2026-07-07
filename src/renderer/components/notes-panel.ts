import { DEFAULTS } from '../../shared/constants';
import { announce } from '../services/announcer';

const WIDTH_STORAGE_KEY = 'patton.notes.width';
const SAVE_DEBOUNCE_MS = 400;

/**
 * A plain-text scratchpad docked to the right of the terminal, toggled by
 * Ctrl+Cmd+N. Deliberately NOT a terminal pane: no PTY, no shell, no compose
 * bar — just a persistent textarea for jotting notes while you work. Content is
 * stored (encrypted) in electron-store as a single per-window document; the
 * panel width is a renderer-only preference kept in localStorage.
 */
export class NotesPanel {
  private panel: HTMLElement;
  private textarea: HTMLTextAreaElement;
  private disposables: (() => void)[] = [];
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private loaded = false;
  /** Called when the panel closes so focus can return to the terminal. */
  private onClose: (() => void) | null;

  constructor(container: HTMLElement, options?: { onClose?: () => void }) {
    this.onClose = options?.onClose ?? null;

    this.panel = document.createElement('div');
    this.panel.id = 'notes-panel';
    this.panel.className = 'collapsed';
    this.panel.setAttribute('role', 'complementary');
    this.panel.setAttribute('aria-label', 'Notes');
    this.panel.innerHTML = `
      <div class="notes-resizer" aria-hidden="true"></div>
      <div class="notes-header">
        <span>Notes</span>
        <span class="notes-hint">⌃⌘N to hide</span>
      </div>
      <textarea class="notes-textarea" spellcheck="false"
        placeholder="Jot notes here — saved automatically."
        aria-label="Notes scratchpad"></textarea>
    `;
    container.appendChild(this.panel);

    this.textarea = this.panel.querySelector('.notes-textarea') as HTMLTextAreaElement;

    // Restore a previously-chosen width (renderer-local preference).
    const savedWidth = Number(localStorage.getItem(WIDTH_STORAGE_KEY));
    if (Number.isFinite(savedWidth) && savedWidth >= 200) {
      this.panel.style.width = `${savedWidth}px`;
    }

    const onInput = () => this.scheduleSave();
    this.textarea.addEventListener('input', onInput);
    this.disposables.push(() => this.textarea.removeEventListener('input', onInput));

    // Escape inside the notes closes the panel (mirrors other overlays).
    const onKeydown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        this.hide();
      }
    };
    this.textarea.addEventListener('keydown', onKeydown);
    this.disposables.push(() => this.textarea.removeEventListener('keydown', onKeydown));

    this.setupResizer();
  }

  get isOpen(): boolean {
    return !this.panel.classList.contains('collapsed');
  }

  async toggle(): Promise<void> {
    if (this.isOpen) {
      this.hide();
    } else {
      await this.show();
    }
  }

  private async show(): Promise<void> {
    // Lazy-load persisted content the first time the panel is opened.
    if (!this.loaded) {
      this.loaded = true;
      try {
        this.textarea.value = await window.patton.notes.get();
      } catch (err) {
        console.error('Failed to load notes:', err);
      }
    }
    this.panel.classList.remove('collapsed');
    announce('Notes panel opened', 'polite');
    // Defer focus until the panel is laid out.
    requestAnimationFrame(() => {
      this.textarea.focus();
      // Put the caret at the end so appending is immediate.
      const len = this.textarea.value.length;
      this.textarea.setSelectionRange(len, len);
    });
  }

  private hide(): void {
    if (!this.isOpen) return;
    // Flush any pending save synchronously-ish before hiding.
    this.flushSave();
    this.panel.classList.add('collapsed');
    announce('Notes panel closed', 'polite');
    this.onClose?.();
  }

  private scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.flushSave(), SAVE_DEBOUNCE_MS);
  }

  private flushSave(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    // Cap client-side too so we never ship an oversized IPC payload; the store
    // re-caps as the trust boundary.
    const value = this.textarea.value.slice(0, DEFAULTS.NOTES_MAX_CHARS);
    window.patton.notes.set(value).catch((err) => console.error('Failed to save notes:', err));
  }

  private setupResizer(): void {
    const resizer = this.panel.querySelector('.notes-resizer') as HTMLElement;
    let startX = 0;
    let startWidth = 0;
    let dragging = false;

    const onMove = (e: MouseEvent) => {
      if (!dragging) return;
      // Panel is docked right, so dragging the left edge leftward widens it.
      const delta = startX - e.clientX;
      const next = Math.max(200, Math.min(window.innerWidth * 0.8, startWidth + delta));
      this.panel.style.width = `${next}px`;
    };
    const onUp = () => {
      if (!dragging) return;
      dragging = false;
      resizer.classList.remove('dragging');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      localStorage.setItem(WIDTH_STORAGE_KEY, String(parseInt(this.panel.style.width, 10) || DEFAULTS.NOTES_PANEL_WIDTH));
    };
    const onDown = (e: MouseEvent) => {
      e.preventDefault();
      dragging = true;
      startX = e.clientX;
      startWidth = this.panel.getBoundingClientRect().width;
      resizer.classList.add('dragging');
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    };

    resizer.addEventListener('mousedown', onDown);
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    this.disposables.push(
      () => resizer.removeEventListener('mousedown', onDown),
      () => document.removeEventListener('mousemove', onMove),
      () => document.removeEventListener('mouseup', onUp),
    );
  }

  dispose(): void {
    this.flushSave();
    for (const d of this.disposables) d();
    this.panel.remove();
  }
}
