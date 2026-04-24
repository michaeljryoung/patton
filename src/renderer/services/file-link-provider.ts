import type { IBufferRange, ILinkProvider, ILink, Terminal } from '@xterm/xterm';

/**
 * Markdown inline link: [title](target). Target can be a URL or a local path.
 * Only non-http(s) targets surface here — URLs are left to WebLinksAddon.
 */
const MD_LINK_RE = /\[([^\]\n]+)\]\(([^)\s]+)\)/g;

/**
 * Plain file paths with optional :line:col or (line,col) suffix.
 * Examples: /abs/path.ts:42:9, ./rel/path.ts:42, src/path.ts, path.ts(42,9).
 * Requires a file extension to avoid matching bare words.
 */
const FILE_PATH_RE = /(?:(?:\.{0,2}\/)?(?:[\w@.-]+\/)*[\w@.-]+\.\w{1,10})(?::(\d+)(?::(\d+))?|\((\d+),(\d+)\))?/g;

export class FileLinkProvider implements ILinkProvider {
  private getCwd: () => string;
  private terminal: Terminal;

  constructor(terminal: Terminal, getCwd: () => string) {
    this.terminal = terminal;
    this.getCwd = getCwd;
  }

  provideLinks(bufferLineNumber: number, callback: (links: ILink[] | undefined) => void): void {
    const line = this.terminal.buffer.active.getLine(bufferLineNumber - 1);
    if (!line) { callback(undefined); return; }

    const text = line.translateToString(true);
    const links: ILink[] = [];
    // Track spans already claimed by markdown links so the bare-path pass
    // doesn't double-register the path inside `[text](path)`.
    const occupied: Array<[number, number]> = [];

    // Pass 1: markdown [text](path) — whole span is clickable.
    MD_LINK_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = MD_LINK_RE.exec(text)) !== null) {
      const fullMatch = match[0];
      const target = match[2];
      const startCol = match.index;
      const endCol = startCol + fullMatch.length;

      // Leave http(s) to WebLinksAddon.
      if (/^https?:\/\//i.test(target)) continue;

      // Split :line:col off the target path if present.
      const lineColMatch = target.match(/^(.+?)(?::(\d+)(?::(\d+))?)?$/);
      const filePath = lineColMatch?.[1] ?? target;
      const lineNum = lineColMatch?.[2] ?? '';
      const colNum = lineColMatch?.[3] ?? '';

      const range: IBufferRange = {
        start: { x: startCol + 1, y: bufferLineNumber },
        end: { x: endCol + 1, y: bufferLineNumber },
      };

      this.pushLink(links, range, filePath, lineNum, colNum, fullMatch);
      occupied.push([startCol, endCol]);
    }

    // Pass 2: bare file paths — skip any span inside a markdown link.
    FILE_PATH_RE.lastIndex = 0;
    while ((match = FILE_PATH_RE.exec(text)) !== null) {
      const fullMatch = match[0];
      const startCol = match.index;
      const endCol = startCol + fullMatch.length;

      if (occupied.some(([s, e]) => startCol < e && endCol > s)) continue;

      const lineNum = match[1] || match[3] || '';
      const colNum = match[2] || match[4] || '';
      const filePath = fullMatch.replace(/(?::\d+(?::\d+)?|\(\d+,\d+\))$/, '');

      const range: IBufferRange = {
        start: { x: startCol + 1, y: bufferLineNumber },
        end: { x: endCol + 1, y: bufferLineNumber },
      };

      this.pushLink(links, range, filePath, lineNum, colNum, fullMatch);
    }

    callback(links.length > 0 ? links : undefined);
  }

  private pushLink(
    links: ILink[],
    range: IBufferRange,
    filePath: string,
    lineNum: string,
    colNum: string,
    displayText: string,
  ): void {
    links.push({
      range,
      text: displayText,
      activate: (event: MouseEvent) => {
        // Double-click gate: let xterm handle single-click selection so users
        // can drag-select text that happens to contain a path.
        if (event.detail !== 2) return;

        // Security: reject directory traversal at input.
        if (/(?:^|\/)\.\.(?:\/|$)/.test(filePath)) return;

        const cwd = this.getCwd();
        let target = filePath;
        if (!target.startsWith('/') && cwd) {
          target = `${cwd}/${target}`;
        }
        // Security: reject traversal that survives resolution.
        if (/(?:^|\/)\.\.(?:\/|$)/.test(target)) return;

        let gotoPath = target;
        if (lineNum) {
          gotoPath += `:${lineNum}`;
          if (colNum) gotoPath += `:${colNum}`;
        }

        window.patton.editor.openFile(gotoPath).catch(console.error);
      },
    });
  }
}
