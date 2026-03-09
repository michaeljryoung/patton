export class PasteDialog {
  private overlay: HTMLElement;
  private resolve: ((paste: boolean) => void) | null = null;
  private disposables: (() => void)[] = [];

  constructor(container: HTMLElement) {
    this.overlay = document.createElement('div');
    this.overlay.className = 'paste-dialog-overlay';
    this.overlay.setAttribute('role', 'dialog');
    this.overlay.setAttribute('aria-modal', 'true');
    this.overlay.setAttribute('aria-label', 'Paste confirmation');
    this.overlay.innerHTML = `
      <div class="paste-dialog">
        <div class="paste-dialog-header">Paste Warning</div>
        <div class="paste-dialog-body">
          <div class="paste-dialog-message"></div>
          <pre class="paste-dialog-preview"></pre>
        </div>
        <div class="paste-dialog-footer">
          <button class="paste-dialog-cancel">Cancel</button>
          <button class="paste-dialog-confirm">Paste</button>
        </div>
      </div>
    `;
    container.appendChild(this.overlay);

    const cancelBtn = this.overlay.querySelector('.paste-dialog-cancel') as HTMLElement;
    const confirmBtn = this.overlay.querySelector('.paste-dialog-confirm') as HTMLElement;
    const cancelHandler = () => this.finish(false);
    const confirmHandler = () => this.finish(true);
    cancelBtn.addEventListener('click', cancelHandler);
    confirmBtn.addEventListener('click', confirmHandler);
    this.disposables.push(
      () => cancelBtn.removeEventListener('click', cancelHandler),
      () => confirmBtn.removeEventListener('click', confirmHandler),
    );

    const keydownHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') this.finish(false);
      // Only confirm on Enter if the Cancel button is NOT focused
      if (e.key === 'Enter' && !(e.target as HTMLElement)?.classList?.contains('paste-dialog-cancel')) {
        this.finish(true);
      }
    };
    this.overlay.addEventListener('keydown', keydownHandler);
    this.disposables.push(() => this.overlay.removeEventListener('keydown', keydownHandler));
  }

  async confirm(text: string, lineCount: number): Promise<boolean> {
    // If already showing, resolve the prior promise as cancelled
    this.resolve?.(false);

    const msg = this.overlay.querySelector('.paste-dialog-message')!;
    const preview = this.overlay.querySelector('.paste-dialog-preview')!;
    msg.textContent = `Paste ${lineCount} lines into terminal?`;
    // Show first 6 lines as preview
    const lines = text.split('\n');
    const shown = lines.slice(0, 6).join('\n');
    preview.textContent = shown + (lines.length > 6 ? '\n...' : '');
    this.overlay.classList.add('visible');
    (this.overlay.querySelector('.paste-dialog-cancel') as HTMLElement).focus();

    return new Promise<boolean>((resolve) => {
      this.resolve = resolve;
    });
  }

  private finish(result: boolean): void {
    this.overlay.classList.remove('visible');
    this.resolve?.(result);
    this.resolve = null;
  }

  dispose(): void {
    for (const d of this.disposables) d();
    this.overlay.remove();
  }
}
