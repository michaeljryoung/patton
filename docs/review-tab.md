# Patton — The review tab (designed S60, not built)

Michael, 22 Nov 2026: "Capability to open docs in new tab within patton like its a word doc but without having to go into the Word downloads folder and then open Word", then, on the four-option page (https://claude.ai/code/artifact/14acb684-5b55-4851-a978-e6c7db7251d3, `docs/mocks/document-tab.html`): "all your options look the same. Let's just think about the functionality", with four needs:

- "I want the formatting to be preserved."
- "I want it to be printable, like our Word docs are right now."
- "I want it to be able to go straight onto G Drive if some of these things are going to G Drive as a Google Doc."
- "Ideally, I want to be able to add comments in the pane and for the original thing, to be able to see them." On who sees them, he chose both the Word file and Claude ("1 ok", 16:29).

He has not said to build it (he answered only that question, 22 Nov 16:29).

## Design

- **R1. Layout.** A Word file opens in a Patton tab laid out by LibreOffice (`/opt/homebrew/bin/soffice --headless --convert-to pdf`, private profile, comments in the margin via `ExportNotesInMargin`), shown in Electron's built-in PDF viewer. About 1–2 s for a one-page file. Re-laid out when the file changes.
- **R2. Print.** A Print button prints the PDF as shown.
- **R3. Send to Drive.** A "Send to Drive" button uploads the .docx converted to a Google Doc (Drive API with `gcloud auth print-access-token --account michaeljryoung@gmail.com`, or `rclone copy --drive-import-formats docx` to `gdrive:`), shows the Doc's link, and adds it to the session bar's Links. Personal Drive; a Lindus document asks first (his rule on Lindus accounts). Word comments carry into the Google Doc.
- **R4. Comments.** Select text in the tab and add a comment in a side panel. Patton writes it into the .docx as a real Word comment, anchored by the quoted text, so Word, the Google Doc and Claude all see it. A "Send comments to Claude" button types them into the tab's Claude session for a revision.
- **Dropped:** a live claude.ai page in Patton (would hold his claude.ai login; Google sign-in may refuse embedded browsers), docx-preview's web view (no page breaks in 383 of his last 503 Word files), Quick Look, mammoth (drops deleted text).
- **Open questions for the build:** printing from Electron's PDF viewer inside a tab (verify); anchoring a comment selected in the PDF back to the .docx text (quote match, first occurrence after the page's start); which Drive folder.
