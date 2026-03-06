export class PasteDialog {
  private overlay: HTMLElement;
  private resolve: ((paste: boolean) => void) | null = null;

  constructor(container: HTMLElement) {
    this.overlay = document.createElement('div');
    this.overlay.className = 'paste-dialog-overlay';
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

    this.overlay.querySelector('.paste-dialog-cancel')!.addEventListener('click', () => this.finish(false));
    this.overlay.querySelector('.paste-dialog-confirm')!.addEventListener('click', () => this.finish(true));
    this.overlay.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.finish(false);
      if (e.key === 'Enter') this.finish(true);
    });
  }

  async confirm(text: string, lineCount: number): Promise<boolean> {
    const msg = this.overlay.querySelector('.paste-dialog-message')!;
    const preview = this.overlay.querySelector('.paste-dialog-preview')!;
    msg.textContent = `Paste ${lineCount} lines into terminal?`;
    // Show first 6 lines as preview
    const lines = text.split('\n');
    const shown = lines.slice(0, 6).join('\n');
    preview.textContent = shown + (lines.length > 6 ? '\n...' : '');
    this.overlay.classList.add('visible');
    (this.overlay.querySelector('.paste-dialog-confirm') as HTMLElement).focus();

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
    this.overlay.remove();
  }
}
