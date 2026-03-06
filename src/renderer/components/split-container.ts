import type { SplitDirection } from './split-tree';

const MIN_RATIO = 0.1;
const MAX_RATIO = 0.9;

export class SplitContainer {
  readonly element: HTMLElement;
  private divider: HTMLElement;
  private firstChild: HTMLElement;
  private secondChild: HTMLElement;
  private direction: SplitDirection;
  private ratio: number;
  private dragging = false;
  private onRatioChange: (ratio: number) => void;
  private disposables: (() => void)[] = [];

  constructor(
    direction: SplitDirection,
    ratio: number,
    first: HTMLElement,
    second: HTMLElement,
    onRatioChange: (ratio: number) => void,
  ) {
    this.direction = direction;
    this.ratio = ratio;
    this.firstChild = first;
    this.secondChild = second;
    this.onRatioChange = onRatioChange;

    // Create container
    this.element = document.createElement('div');
    this.element.className = `split-container ${direction}`;

    // Create divider
    this.divider = document.createElement('div');
    this.divider.className = `split-divider ${direction}`;

    // Assemble
    this.element.appendChild(this.firstChild);
    this.element.appendChild(this.divider);
    this.element.appendChild(this.secondChild);

    this.applyRatio();
    this.setupDrag();
  }

  private applyRatio(): void {
    const pct1 = `calc(${this.ratio * 100}% - 2px)`;
    const pct2 = `calc(${(1 - this.ratio) * 100}% - 2px)`;

    if (this.direction === 'vertical') {
      this.firstChild.style.width = pct1;
      this.firstChild.style.height = '100%';
      this.secondChild.style.width = pct2;
      this.secondChild.style.height = '100%';
    } else {
      this.firstChild.style.height = pct1;
      this.firstChild.style.width = '100%';
      this.secondChild.style.height = pct2;
      this.secondChild.style.width = '100%';
    }
  }

  private setupDrag(): void {
    const onMouseDown = (e: MouseEvent) => {
      e.preventDefault();
      this.dragging = true;
      document.body.style.cursor =
        this.direction === 'vertical' ? 'col-resize' : 'row-resize';
      // Prevent text selection during drag
      document.body.style.userSelect = 'none';
    };

    const onMouseMove = (e: MouseEvent) => {
      if (!this.dragging) return;

      const rect = this.element.getBoundingClientRect();
      let newRatio: number;

      if (this.direction === 'vertical') {
        newRatio = (e.clientX - rect.left) / rect.width;
      } else {
        newRatio = (e.clientY - rect.top) / rect.height;
      }

      newRatio = Math.max(MIN_RATIO, Math.min(MAX_RATIO, newRatio));
      this.ratio = newRatio;
      this.applyRatio();
      this.onRatioChange(newRatio);
    };

    const onMouseUp = () => {
      if (!this.dragging) return;
      this.dragging = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    this.divider.addEventListener('mousedown', onMouseDown);
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);

    this.disposables.push(
      () => this.divider.removeEventListener('mousedown', onMouseDown),
      () => document.removeEventListener('mousemove', onMouseMove),
      () => document.removeEventListener('mouseup', onMouseUp),
    );
  }

  dispose(): void {
    if (this.dragging) {
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      this.dragging = false;
    }
    for (const d of this.disposables) d();
    this.element.remove();
  }
}
