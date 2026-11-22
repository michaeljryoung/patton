/** The review tab's contract between main and the renderer (docs/review-tab.md). */

export const REVIEW_IPC = {
  /** main → renderer: open a review tab for this document. */
  OPEN: 'review:open',
  /** main → renderer: the file changed on disk; lay it out again. */
  CHANGED: 'review:changed',
  LAYOUT: 'review:layout',
  COMMENTS: 'review:comments',
  ADD_COMMENT: 'review:add-comment',
  OPEN_IN_WORD: 'review:open-in-word',
  DRIVE: 'review:drive',
  /** Main's full Lindus check (path, properties, text), asked before Send to Drive. */
  LINDUS: 'review:lindus',
  CLOSE: 'review:close',
} as const;

export interface ReviewDocInfo {
  /** Opaque id main keeps the real path under; the renderer never holds the path for actions. */
  docId: string;
  /** The file's name, for the tab. */
  name: string;
  /** Where it is, `~/…` inside home, for the tooltip and the Claude message. */
  shownPath: string;
}

/** Main's Lindus check of the file as it is now (`lindusSignal`): `why` in
 *  his words when Send to Drive should ask first, else null. */
export interface ReviewLindusReply {
  why: string | null;
}

export type ReviewLayoutReply =
  | { ok: true; pdf: Uint8Array; version: string; ms: number; cached: boolean }
  | { ok: false; why: string; message: string };

export interface ReviewComment {
  id: string;
  author: string;
  date: string;
  text: string;
  quote: string;
  /** Which match of the quote's key (0-based) in the body it is anchored on. */
  occurrence: number;
}

export interface ReviewNewComment {
  quote: string;
  occurrence: number;
  text: string;
  /** The layout's `version` the selection was made on; main refuses the
   *  comment when the file has other text now (`why: 'changed'`). */
  version?: string;
}

export type ReviewAddReply =
  | { ok: true; id: string; matched: 'exact' | 'last' }
  | { ok: false; why: string; message: string };

export type ReviewDriveReply =
  | { ok: true; link: string; name: string; account: string; dryRun: false }
  | { ok: true; dryRun: true; account: string; summary: string }
  | { ok: false; why: 'confirm-lindus' | string; message: string };

export interface ReviewApi {
  onOpen(callback: (info: ReviewDocInfo) => void): () => void;
  onChanged(callback: (docId: string) => void): () => void;
  layout(docId: string): Promise<ReviewLayoutReply>;
  comments(docId: string): Promise<ReviewComment[]>;
  addComment(docId: string, comment: ReviewNewComment): Promise<ReviewAddReply>;
  openInWord(docId: string): Promise<boolean>;
  lindus(docId: string): Promise<ReviewLindusReply>;
  sendToDrive(docId: string, opts: { confirmLindus: boolean }): Promise<ReviewDriveReply>;
  close(docId: string): Promise<void>;
}

/** Longest comment text kept (a comment, not a document). */
export const REVIEW_COMMENT_MAX = 4000;
/** Longest quote matched. */
export const REVIEW_QUOTE_MAX = 2000;
