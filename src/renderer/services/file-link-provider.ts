import type { IBufferRange, ILinkProvider, ILink, Terminal } from '@xterm/xterm';

/**
 * Matches file paths with optional :line:col or (line,col) suffixes.
 * Examples: /abs/path.ts:42:9, ./rel/path.ts:42, src/path.ts, path.ts(42,9)
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

    FILE_PATH_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = FILE_PATH_RE.exec(text)) !== null) {
      const fullMatch = match[0];
      const startCol = match.index;
      const endCol = startCol + fullMatch.length;

      const lineNum = match[1] || match[3] || '';
      const colNum = match[2] || match[4] || '';

      const range: IBufferRange = {
        start: { x: startCol + 1, y: bufferLineNumber },
        end: { x: endCol + 1, y: bufferLineNumber },
      };

      // Extract just the file path (strip :line:col or (line,col))
      const filePath = fullMatch.replace(/[:(/][\d,):]+$/, '').replace(/[:(]$/, '');

      links.push({
        range,
        text: fullMatch,
        activate: () => {
          // Security: reject paths with directory traversal
          if (/(?:^|\/)\.\.(?:\/|$)/.test(filePath)) return;

          const cwd = this.getCwd();
          let target = filePath;

          // Resolve relative paths
          if (!target.startsWith('/') && cwd) {
            target = `${cwd}/${target}`;
          }

          // Security: after resolution, reject if traversal still present
          if (/(?:^|\/)\.\.(?:\/|$)/.test(target)) return;

          // Build VS Code goto target: path:line:col
          let gotoPath = target;
          if (lineNum) {
            gotoPath += `:${lineNum}`;
            if (colNum) gotoPath += `:${colNum}`;
          }

          window.patton.editor.openFile(gotoPath).catch(console.error);
        },
      });
    }

    callback(links.length > 0 ? links : undefined);
  }
}
