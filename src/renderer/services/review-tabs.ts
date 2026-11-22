/**
 * Review tabs in this window (docs/review-tab.md R9): main sends `review:open`
 * when a .docx link is opened (the terminal, the session bar's Links); this
 * opens a normal Patton tab (a shell in the origin pane's folder) and lays the
 * review view over it as its cover, titled with the file's name. The origin is
 * the pane focused when the link opened: "Send comments to Claude" types into
 * it, and a Google Doc made by Send to Drive joins its session bar's Links.
 * Not restored after a relaunch (the tab comes back as its shell).
 */
import type { ReviewDocInfo } from '../../shared/review';
import type { ConfirmOptions } from '../components/confirm-dialog';
import type { Pane } from '../components/pane';
import { ReviewView } from '../components/review-view';
import type { Tab } from '../components/tab';
import { rlog } from './renderer-logger';

export interface ReviewTabsHost {
  /** The pane focused now (the link's origin). */
  focusedPane(): Pane | null;
  createTab(cwd?: string): Promise<Tab>;
  onTabClosed(listener: (tab: Tab) => void): () => void;
  /** The pane is still in one of this window's tabs. */
  paneAlive(pane: Pane): boolean;
  /** Bring the pane's tab to the front and focus it. */
  showPane(pane: Pane): void;
  confirm(opts: ConfirmOptions): Promise<boolean>;
}

/** A Google Doc link main may hand back (drive-upload.ts checks the same). */
function isDocLink(url: string): boolean {
  return /^https:\/\/docs\.google\.com\/[\w\-./?=&%#]*$/.test(url) && url.length <= 2048;
}

export class ReviewTabs {
  private readonly host: ReviewTabsHost;
  private readonly views = new Map<Tab, ReviewView>();
  private readonly disposables: (() => void)[] = [];

  constructor(host: ReviewTabsHost) {
    this.host = host;
    const off = window.patton.review?.onOpen((info) => { void this.open(info); });
    if (typeof off === 'function') this.disposables.push(off);
    this.disposables.push(host.onTabClosed((tab) => {
      const view = this.views.get(tab);
      if (!view) return;
      this.views.delete(tab);
      view.dispose();
    }));
  }

  /** The review view in this tab, if it is a review tab. */
  viewOf(tab: Tab): ReviewView | null {
    return this.views.get(tab) ?? null;
  }

  async open(info: ReviewDocInfo): Promise<Tab | null> {
    if (!info || typeof info.docId !== 'string' || typeof info.name !== 'string') return null;
    const origin = this.host.focusedPane();
    const cwd = origin?.getCwd() || undefined;
    let tab: Tab;
    try {
      tab = await this.host.createTab(cwd);
    } catch (err) {
      rlog('error', '[REVIEW] tab failed', { error: String(err) });
      void window.patton.review.close(info.docId);
      return null;
    }
    const view = new ReviewView({
      info,
      api: window.patton.review,
      confirm: (opts) => this.host.confirm(opts),
      sendToClaude: (message) => this.sendToClaude(origin, message),
      onDriveLink: (link, name) => this.addDriveLink(origin, link, name),
      openLink: (url) => {
        if (isDocLink(url)) void window.patton.openExternal(url);
      },
    });
    this.views.set(tab, view);
    tab.setCover({ element: view.element, focus: () => view.focus(), title: info.name });
    rlog('info', '[REVIEW] tab opened', { tabId: tab.id, origin: origin?.id ?? null, lindus: info.lindus });
    return tab;
  }

  private async sendToClaude(origin: Pane | null, message: string): Promise<string | null> {
    if (!origin || !this.host.paneAlive(origin)) {
      return 'The Claude session this document opened from is closed.';
    }
    const why = await origin.pasteReviewComments(message);
    if (why) return why;
    this.host.showPane(origin);
    return null;
  }

  private addDriveLink(origin: Pane | null, link: string, name: string): void {
    if (!isDocLink(link)) {
      rlog('warn', '[REVIEW] drive link refused');
      return;
    }
    if (!origin || !this.host.paneAlive(origin)) return;
    const now = Date.now();
    origin.sessionBarModel.applyFeed({ type: 'link', url: link, label: `Google Doc: ${name}`, at: now }, now);
  }

  dispose(): void {
    for (const d of this.disposables) d();
    for (const view of this.views.values()) view.dispose();
    this.views.clear();
  }
}
