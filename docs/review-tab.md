# Patton — The review tab (designed S60, building S61)

<!-- MAP:BEGIN -->
## 🗺 THE MAP — S61: Word files open in a Patton review tab

**Goal:** (S61) A .docx Claude links to opens in a Patton tab laid out as LibreOffice prints it, printable, sendable to his Drive as a Google Doc, with comments he adds on selected text saved into the file as real Word comments and sent to Claude in one message; Open in Word one click away.
**Done when:** a .docx opened from a file link (terminal or the session bar's Links) shows the same page count as `soffice --headless --convert-to pdf` of it; Print opens the print dialog with exactly those pages; Send to Drive uploads it as a Google Doc and shows the Doc's link (proven against a dry run until his yes); a comment added on selected text lands in `word/comments.xml` and shows in the side panel with its highlight on the page, the pages staying at 100% (no margin notes, as Word prints by default); "Send comments to Claude" types the ones not yet sent into the tab's Claude session as one message; Open in Word is one click.
**Last verified:** 2026-11-22 (Session 61: main and renderer halves built; the full verifier, the packaged-worker check, the Drive stub check and the Settings fields are done; fresh reviews next)

```mermaid
flowchart TD
  subgraph D["Design"]
    rt_spike[spikes R5-R9]:::live
  end
  subgraph B["Build"]
    rt_open[a docx link opens a review tab]:::live
    rt_layout[soffice layout, cache, re-layout]:::live
    rt_print[print exactly the laid-out pages]:::live
    rt_drive[send to Drive as a Google Doc]:::live
    rt_comments[comments panel writes Word comments]:::live
    rt_claude[send comments to Claude]:::live
  end
  subgraph V["Verify and ship"]
    rt_check[suite, package, screenshots]:::live
    rt_review[fresh reviews, no open major]:::live
    rt_release[merge, push, CI release]:::todo
    rt_ship[install on his word, live Drive test on his yes]:::todo
  end
  rt_spike --> rt_open
  rt_open --> rt_layout
  rt_layout --> rt_print
  rt_layout --> rt_comments
  rt_open --> rt_drive
  rt_comments --> rt_claude
  rt_print --> rt_check
  rt_drive --> rt_check
  rt_claude --> rt_check
  rt_check --> rt_review
  rt_review --> rt_release
  rt_release --> rt_ship
  classDef done fill:#1a7f37,color:#fff
  classDef live fill:#0969da,color:#fff
  classDef todo fill:#8c959f,color:#fff
  classDef blocked fill:#cf222e,color:#fff
  classDef dropped fill:#eaeef2,color:#57606a
  classDef superseded fill:#eaeef2,color:#57606a
```

| ID | Task | Status | Depends on | Evidence |
|----|------|--------|------------|----------|
| `rt_spike` | Answer the open questions (R5-R9) by probe | live | — | R5-R10 below; spikes (a), (c), (d) proven by probe; (b) print designed (R6), not yet probed |
| `rt_open` | A .docx file link (terminal, session bar) opens the review tab; .docm refused; other Office files unchanged | live | `rt_spike` | renderer half built (`services/review-tabs.ts`, `components/review-view.ts`); `node scripts/check-review-tab.cjs` (hidden Electron, real main half and LibreOffice) 42 ok, 44 with `REVIEW_ASAR`: review:open makes a tab titled with the file name; `check-link-open-policy.mjs` 146 ok (a .docx goes to the review tab, or to Word with `reviewTab` off; macro-enabled files revealed); not yet seen in the installed app |
| `rt_layout` | soffice to PDF in a private profile, timeout, cached by mtime, re-laid out on change; pdf.js pages; missing soffice message | live | `rt_open` | main half as before; pdf.js pages + text layer drawn (`services/review-pdf.ts`), worker mode logged; the worker is started by Patton (the packaged CSP refuses pdf.js's own blob: wrapper) from a URL `index.ts` hands in through `setPdfWorkerUrl`; check: 2 pages = soffice's 2, pdf.js in its Web Worker; against the built asar (21:06 on 22 Nov, `REVIEW_ASAR`) the packaged worker asset starts as a real Web Worker under the app's CSP and opens the PDF (2 pages); the status line shows the page count (and again after Print); the comment's highlight is snapped to the page's ink (`services/review-ink.ts`): the check reads the canvas itself and finds ink at both edges and a gap just outside |
| `rt_print` | Print opens the dialog with exactly the laid-out pages | live | `rt_layout` | pages at 200 dpi in a print-only container, @page per size, `window.print()`; check: printToPDF of the window 2 pages = soffice's 2, afterprint cleans up; the real print dialog not yet seen (nothing in these checks opens it) |
| `rt_drive` | Send to Drive as a Google Doc, link shown and added to Links; Lindus files ask first | live | `rt_open` | UI built: Lindus files ask in Patton's confirm, link shown and added to the origin pane's session bar Links (check, fake upload); main's Lindus gate checked for real; `check-drive-upload.mjs` 35 ok (gcloud and fetch stubbed, nothing reaches Google); Settings "Word documents" fields (reviewTab, Drive folder, account) with `check-drive-settings.mjs` 15 ok; no real upload has been made: the first waits for his yes |
| `rt_comments` | Comment on selected text, saved as a real Word comment | live | `rt_layout` | panel built; check: text selected on page 2 -> comment in `word/comments.xml`, anchored in page 2's paragraph, listed in the panel, LibreOffice still 2 pages; the check's file now has a table and a picture (both seen on page 1); `check-review-comments.mjs` 21 ok |
| `rt_claude` | Send comments to Claude as one message | live | `rt_comments` | `Pane.pasteReviewComments`: one bracketed paste then Enter, refused while 7501 blocked (re-checked at write); check: pasted message holds the comment, origin tab shown, blocked -> visible note and no pty write |
| `rt_check` | Lint, types, `npm run check`, package (asar mtime), light and dark screenshots | live | `rt_print`, `rt_drive`, `rt_claude` | 22 Nov: lint and tsc clean; `npm run check` 51 passed, 0 failed, 0 skipped (it found five jsdom checks broken by the worker's `?url` import and one stale .docx expectation, both fixed); `PATTON_NO_INSTALL=1 npm run package` built `app.asar` at 21:06:20; `check-review-tab.cjs` against it 44 ok; light and dark screenshots re-taken from the built check and looked at (status line shows, highlight on its words, nothing clipped); /Applications untouched |
| `rt_review` | Fresh reviews with probes, every finding fixed | live | `rt_check` | first UI review (22 Nov): 1 major (canvases never freed), 5 minors, 2 nits, all fixed; probes of tab switch, file renamed/deleted while open, close, session and Settings found three more (rename back unseen by the watcher, review tabs saved as bare shells, Reopen Closed Tab bringing an empty terminal), fixed; `check-review-tab.cjs` 60 ok, 14 of its new assertions fail on `2ab134e`; further reviews next |
| `rt_release` | Merge to main, push, CI release | todo | `rt_review` | — |
| `rt_ship` | Install on his word; the first real Drive upload on his yes | todo | `rt_release` | — |
<!-- MAP:END -->

Michael, 22 Nov 2026: "Capability to open docs in new tab within patton like its a word doc but without having to go into the Word downloads folder and then open Word", then, on the four-option page (https://claude.ai/code/artifact/14acb684-5b55-4851-a978-e6c7db7251d3, `docs/mocks/document-tab.html`): "all your options look the same. Let's just think about the functionality", with four needs:

- "I want the formatting to be preserved."
- "I want it to be printable, like our Word docs are right now."
- "I want it to be able to go straight onto G Drive if some of these things are going to G Drive as a Google Doc."
- "Ideally, I want to be able to add comments in the pane and for the original thing, to be able to see them." On who sees them, he chose both the Word file and Claude ("1 ok", 16:29).

He approved the design for building on 22 Nov 2026 ("ok").

## Design

- **R1. Layout.** A Word file opens in a Patton tab laid out by LibreOffice (`/opt/homebrew/bin/soffice --headless --convert-to pdf`, private profile), drawn by pdf.js (R5). About 1–2 s for a one-page file. Re-laid out when the file changes. **Without margin notes** (S61 review): `ExportNotesInMargin` made LibreOffice shrink every page to 75% once a file had one comment, on screen and in print; the pages now show and print at 100%, as Word prints by default, and comments live in the side panel with their highlights on the page (`ExportNotes` off too, so none ride along as PDF annotations). The filter is part of the layout cache's key. Only pages within a screen of the view keep a canvas (a 100-page file at DPR 2 held ~1.3 GB of canvases; now 2–3 pages, ~40 MB, measured); a hidden tab keeps what it drew.
- **R2. Print.** A Print button prints the PDF as shown.
- **R3. Send to Drive.** A "Send to Drive" button uploads the .docx converted to a Google Doc (Drive API with `gcloud auth print-access-token --account michaeljryoung@gmail.com`, or `rclone copy --drive-import-formats docx` to `gdrive:`), shows the Doc's link, and adds it to the session bar's Links. Personal Drive; a Lindus document asks first (his rule on Lindus accounts). Word comments carry into the Google Doc.
- **R4. Comments.** Select text in the tab and add a comment in a side panel. Patton writes it into the .docx as a real Word comment, anchored by the quoted text, so Word, the Google Doc and Claude all see it. A "Send comments to Claude" button types them into the tab's Claude session for a revision: the comments not yet sent (every author's, each with its author and the text it is on), counted on the button ("Send 3 comments to Claude") and marked sent in the panel once Claude has them (remembered per file for the run of Patton). The paste and its Enter are each gated on the live 7501 `blocked` fact: if Claude starts asking in between, no Enter goes, the note says the comments sit unsent in Claude's input, and they stay unsent.
- **Dropped:** a live claude.ai page in Patton (would hold his claude.ai login; Google sign-in may refuse embedded browsers), docx-preview's web view (no page breaks in 383 of his last 503 Word files), Quick Look, mammoth (drops deleted text).
- **Open questions for the build:** printing from Electron's PDF viewer inside a tab (verify); anchoring a comment selected in the PDF back to the .docx text (quote match, first occurrence after the page's start); which Drive folder.

## Decisions from the spikes (S61)

- **R5. pdf.js, not Electron's PDF viewer.** A hidden Electron 44.9.3 window with `plugins: true` showing the PDF exposes no guest webContents (`getAllWebContents()` lists only the window), and after `selectAll()` the page's `getSelection()` is empty: the viewer's text is out of Patton's reach. Patton's window also runs sandboxed with `object-src 'none'`. So pages are drawn by `pdfjs-dist` 6.5.438 (devDependency: Vite bundles it into the renderer; no install scripts; its optional `@napi-rs/canvas` is unused in the renderer) on canvases with pdf.js's text layer, so selection, print and highlights are Patton's own. (`isEvalSupported` no longer exists in 6.5: pdf.js has no eval to turn off, read S61); its worker is a bundled `?url` asset under `script-src 'self'` (to prove in the packaged build).
- **R6. Print (designed, not yet probed).** Render each page to an image at print resolution into a print-only container, `@page { size: <page size>; margin: 0 }`, one page per sheet, everything else hidden under `@media print`, then `window.print()`. Proof: `webContents.printToPDF` of the tab gives the same page count as `soffice --convert-to pdf`.
- **R7. Comments.** Anchored by quote: both sides stripped of whitespace, NFKC-normalised, soft hyphens and zero-width marks dropped; the occurrence is the count of the same key in the PDF text before the selection; a count past the body's last match takes the last (headers, footers and margin comments are in the PDF, not the body). Written as real OOXML (`commentRangeStart/End`, a `commentReference` run, `word/comments.xml`, its relationship and content type), splitting runs with their own properties; other parts copied byte for byte. Proven: a python-docx file with two comments re-opens in LibreOffice 26.8 with both in the margin, page count unchanged (2). The file is replaced atomically; refused while Word holds it (`~$` owner file).
- **R8. Drive: the Drive API with his personal gcloud login, not rclone.** This Mac's `gdrive:` remote is the Lindus Drive (its folders are Lindus trial material) with scope `drive.readonly`, so it could neither take an upload nor reach his personal Drive. `gcloud auth print-access-token --account <personal>` already carries the `drive` scope (tokeninfo, 22 Nov), so no new access is asked for. Multipart upload with `mimeType: application/vnd.google-apps.document` converts it; the folder (setting `driveFolder`, default "Patton") is found or made at the top of My Drive; the reply's `webViewLink` is the Doc's link. The account is the setting `driveAccount`, else the one @gmail.com account gcloud holds. Each send makes a new Doc (not yet checked live).
- **R9. Where a review tab lives.** A normal Patton tab (a shell in the origin pane's folder) carrying the review view as its cover (`Tab.setCover`, as the project board does), titled with the file name, so close, groups and the strip need no new tab kind. "Send comments to Claude" types into the pane that was focused when the link opened. Not restored after a relaunch, and not saved in the session at all (S61 review: it came back as the bare shell it lies over); Reopen Closed Tab does not bring it back as an empty terminal either. A file moved, renamed or deleted while open keeps its last pages with a note, and shows again if it comes back where it was.
- **R10. Threat model.** soffice runs by execFile on a copy named `document.docx` in a fresh private temp folder, in Patton's own profile seeded with `DisableMacrosExecution`, `MacroSecurityLevel` 3, `BlockUntrustedRefererLinks` and links not updated (kept by LibreOffice after its first run, probe); a file with `vbaProject.bin` is refused and `.docm` is revealed by the link policy; 50 MB cap, zip64/encrypted/odd compression refused, inflate bounded. Main holds the real path under an opaque id per window and re-checks it (regular, not executable, `.docx`) on every action. The token never leaves main or reaches a log. Document text reaches the DOM only through pdf.js's text layer (textContent) and the comment list (textContent, never innerHTML). Residual: LibreOffice may still fetch remote images a file links to.
