/**
 * The "Okay?" button (Michael, 18 Nov 2026; the decision and words are in
 * services/okay-ask.ts) and the slim row under a pane's terminal that holds it
 * when the compose box isn't open. While the box is engaged the same button
 * (one state) sits inside the box at its left and the row hides
 * (docs/compose-box.md D11; Michael 20 Nov: "the OK button is now in the
 * wrong place"). Offered only while Claude Code runs in the pane. A click asks the pane through
 * `onAsk`, which resolves to what the button should say (and the announcer
 * read) or null when nothing came of it. The button shows that for
 * OKAY_RESULT_MS, then goes back; clicks during the ask or the result do
 * nothing, so a double-click never sends twice.
 */
import { OKAY_ERROR_WORDS, OKAY_LABEL, OKAY_PROMPT, OKAY_RESULT_MS } from '../services/okay-ask';

export class OkayRow {
  readonly element: HTMLElement;
  readonly button: HTMLButtonElement;
  private busy = false;
  private available = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  /** Bumped by every reset, so an ask that began before it can tell. */
  private generation = 0;

  constructor(private readonly onAsk: () => Promise<string | null>) {
    this.element = document.createElement('div');
    this.element.className = 'okay-row';
    this.element.hidden = true;
    // Never take focus from the terminal when the button is pressed.
    this.element.addEventListener('mousedown', (e) => e.preventDefault());

    this.button = document.createElement('button');
    this.button.type = 'button';
    this.button.className = 'okay-button';
    this.button.textContent = OKAY_LABEL;
    const label = `Ask Claude: ${OKAY_PROMPT}`;
    this.button.setAttribute('aria-label', label);
    this.button.title = label;
    this.button.addEventListener('click', () => { void this.ask(); });
    // In the compose box too: a press never takes the keyboard (the box keeps it).
    this.button.addEventListener('mousedown', (e) => e.preventDefault());
    this.element.appendChild(this.button);
  }

  get hidden(): boolean {
    return this.element.hidden;
  }

  /** Show or hide the row with the button in it. Returns true when that
   *  changed the row (the terminal's height moved). */
  setVisible(visible: boolean): boolean {
    return this.place(visible, null);
  }

  /**
   * Offer the button (`available`: Claude runs here) and put it in `box`
   * (the compose box's field: first, so at its left) or, when that is null,
   * in the row. The row shows only when the button is offered and not in the
   * box. Moving keeps the button's state (an ask or a result in flight);
   * withdrawing it resets that. Returns true when the row's visibility changed.
   */
  place(available: boolean, box: HTMLElement | null): boolean {
    if (!available && this.available) this.reset();
    this.available = available;
    const host = box ?? this.element;
    if (this.button.parentElement !== host) host.prepend(this.button);
    this.button.hidden = !available;
    const rowVisible = available && box === null;
    if (this.element.hidden === !rowVisible) return false;
    this.element.hidden = !rowVisible;
    return true;
  }

  private async ask(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    const generation = this.generation;
    let text: string | null = null;
    try {
      text = await this.onAsk();
    } catch {
      // askOkay answers its own failures; this keeps a rejection from going unhandled.
      text = OKAY_ERROR_WORDS;
    }
    // The row was hidden (reset) while the ask was in flight: its result is
    // stale, and busy was already cleared for the next one.
    if (generation !== this.generation) return;
    if (this.disposed || text === null) {
      this.busy = false;
    } else {
      this.button.textContent = text;
      this.timer = setTimeout(() => this.reset(), OKAY_RESULT_MS);
    }
  }

  private reset(): void {
    this.generation++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.busy = false;
    this.button.textContent = OKAY_LABEL;
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
