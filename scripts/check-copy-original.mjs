// Check of copying Claude's original text out of a Claude tab
// (src/main/copy-original.ts, copy-match.ts, markdown-doc.ts, transcript-texts.ts).
// The drawn screens are real: scripts/fixtures/copy-original-screens.json holds
// two replies as Claude Code drew them at 64 columns (a pty capture replayed
// through xterm.js), with the Markdown Claude wrote. Every expectation is about
// what lands on the clipboard, so today's copy (the drawn text) fails them.
// Also: code blocks (edge symbols, indentation), tool output and prompt rows,
// overlapping copies, and the parser on pathological 100 KB replies. The real
// clipboard write (text/plain and text/html) is check-copy-clipboard-electron.cjs.
// Run: node scripts/check-copy-original.mjs   (no extra dependencies)
//   CO_SRC_ROOT=<folder holding src/>  check another source tree; where the
//   modules don't exist (the base), today's copy stands in for them.
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const srcRoot = process.env.CO_SRC_ROOT || repo;
let failed = 0;
let passed = 0;
const check = (name, ok, detail) => {
  if (ok) { passed++; console.log('ok  ', name); }
  else { failed++; console.log('FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 500)); }
};

const fx = JSON.parse(readFileSync(join(repo, 'scripts/fixtures/copy-original-screens.json'), 'utf8'));
const [email, mixed] = fx.replies;
const rows = (reply, from, to) => reply.drawn.slice(from, to).join('\n');
const findRow = (reply, needle) => reply.drawn.findIndex((l) => l.includes(needle));

const work = mkdtempSync(join(tmpdir(), 'copy-original-'));
let CopyOriginal = null;
let TranscriptTexts = null;
try {
  const out = join(work, 'copy.cjs');
  try {
    await build({
      stdin: {
        contents: "export { CopyOriginal } from './src/main/copy-original'; export { TranscriptTexts } from './src/main/transcript-texts';",
        resolveDir: srcRoot, loader: 'ts',
      },
      bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'silent',
    });
    ({ CopyOriginal, TranscriptTexts } = createRequire(import.meta.url)(out));
  } catch {
    console.log('note: the modules are missing in', srcRoot, '- today\'s copy (the drawn text) stands in');
  }
  let parseMarkdown = null;
  try {
    const out2 = join(work, 'md.cjs');
    await build({
      stdin: { contents: "export { parseMarkdown } from './src/main/markdown-doc';", resolveDir: srcRoot, loader: 'ts' },
      bundle: true, platform: 'node', format: 'cjs', outfile: out2, logLevel: 'silent',
    });
    ({ parseMarkdown } = createRequire(import.meta.url)(out2));
  } catch { /* checked below */ }
  let selectionInReply = null;
  try {
    const out3 = join(work, 'rows.cjs');
    await build({
      stdin: { contents: "export { selectionInReply } from './src/renderer/services/claude-reply-rows';", resolveDir: srcRoot, loader: 'ts' },
      bundle: true, platform: 'node', format: 'cjs', outfile: out3, logLevel: 'silent',
    });
    ({ selectionInReply } = createRequire(import.meta.url)(out3));
  } catch { /* checked below */ }

  // A fake clipboard; `copyVia` copies `selection` as a Claude tab would and
  // returns what the clipboard then holds.
  const makeClipboard = () => {
    const clip = { text: '', html: null, writes: 0 };
    clip.api = {
      writeText: async (t) => { clip.text = t; clip.html = null; clip.writes++; },
      write: async ({ text, html }) => { clip.text = text; clip.html = html; clip.writes++; },
      readText: async () => clip.text,
    };
    return clip;
  };
  const logs = [];
  const makeCopier = (messages, opts = {}) => {
    const clip = makeClipboard();
    if (!CopyOriginal) {
      // Today: the drawn selection goes on the clipboard as it is.
      return { clip, copy: async (_p, sel) => { await clip.api.writeText(sel); return 'fallback'; } };
    }
    const copier = new CopyOriginal({
      transcriptFor: () => (messages === null ? null : '/fake/transcript.jsonl'),
      recentTexts: async () => {
        if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
        return messages;
      },
      clipboard: clip.api,
      log: (msg, data) => logs.push({ msg, data }),
      ...opts.deps,
    });
    return { clip, copy: (p, sel, mode = 'copy') => copier.copy(p, sel, mode), copier };
  };
  const copyVia = async (selection, messages, opts) => {
    const c = makeCopier(messages, opts);
    const outcome = await c.copy(7, selection, opts?.mode);
    return { ...c.clip, outcome, c };
  };
  const others = ['Nothing in this one matches anything.', 'A second **unrelated** reply.'];

  // 1. The email: quote bars and wraps become whole paragraphs, no `>`.
  {
    const from = findRow(email, 'Hi Sarah');
    const sel = rows(email, from, findRow(email, 'Best, Michael') + 1);
    const r = await copyVia(sel, [...others, email.original]);
    const want = 'Hi Sarah, thanks for the call this morning. I have gone through the numbers again and I think we can close the gap before the end of the month if we move the second payment forward.\n\nBest, Michael';
    check('email: the quoted paragraphs arrive whole, without ▎ or >', r.text === want, r.text);
    check('email: HTML keeps the quote and the bold', typeof r.html === 'string' && r.html.includes('<blockquote>') && r.html.includes('<strong>close the gap</strong>'), r.html);
  }
  // The whole reply, selected from its ⏺ line to its end.
  {
    const r = await copyVia(email.drawn.join('\n'), [...others, email.original]);
    check('whole reply: starts with the heading, no # or **', r.text.startsWith('Draft email\n\nHere is the draft for Sarah Thompson about the quarterly review,'), r.text.slice(0, 120));
    check('whole reply: a link keeps its label and address in plain text', r.text.includes('a link to the deck (https://example.com/deck) included'), r.text);
    check('whole reply: HTML has the heading, the link and the code', typeof r.html === 'string' && r.html.includes('<h2>Draft email</h2>')
      && r.html.includes('<a href="https://example.com/deck">link to the deck</a>') && r.html.includes('<code>budget.xlsx</code>'), r.html);
    check('whole reply: log says original, with counts and no text', logs.some((l) => l.msg === '[COPY] original' && l.data.msgsSearched === 3 && typeof l.data.chars === 'number' && typeof l.data.ms === 'number'), logs.slice(-1));
  }

  // 2. A partial selection mid-paragraph, starting and ending mid-word.
  {
    const a = findRow(email, 'Hi Sarah');
    const sel = rows(email, a, a + 2).replace(/^.*?Hi Sarah, th/, '').replace(/ the gap$/, ' the ga');
    check('partial: the probe really starts and ends mid-word', sel.startsWith('anks for') && sel.endsWith('the ga'), sel);
    const r = await copyVia(sel, [email.original]);
    check('partial: widened to whole words, one line', r.text === 'thanks for the call this morning. I have gone through the numbers again and I think we can close the gap', r.text);
    check('partial: HTML bold kept inside the span', typeof r.html === 'string' && r.html.includes('<strong>close the gap</strong>') && !r.html.includes('Hi Sarah'), r.html);
  }
  // Ending on punctuation takes it.
  {
    const a = findRow(email, 'before the end');
    const sel = rows(email, a, a + 2).replace(/^\s*▎ /, '');
    const r = await copyVia(sel, [email.original]);
    check('partial: a selection ending on "forward." keeps the full stop', r.text === 'before the end of the month if we move the second payment forward.', r.text);
  }

  // 3. A list, nested; and a numbered list Claude Code renumbered.
  {
    const a = findRow(email, 'first item');
    const sel = rows(email, a, findRow(email, 'nested item') + 1);
    const r = await copyVia(sel, [email.original]);
    check('list: items whole, as "- ", nesting kept', r.text === '- first item with a long tail of words that will certainly wrap at sixty four columns wide\n- second item has bold text\n  - nested item', r.text);
    check('list: HTML lists', typeof r.html === 'string' && r.html.includes('<ul><li>first item') && r.html.includes('<ul><li>nested item</li></ul>'), r.html);
    const b = findRow(mixed, '1. first');
    const r2 = await copyVia(rows(mixed, b, b + 3), [mixed.original]);
    check('numbered list written 1. 1. 1., drawn 1. 2. 3.: copied 1. 2. 3.', r2.text === '1. first\n2. second\n3. third', r2.text);
    check('numbered list: HTML <ol>', typeof r2.html === 'string' && r2.html.includes('<ol><li>first</li><li>second</li><li>third</li></ol>'), r2.html);
  }

  // 4. Bold: no ** in the text, <strong> in the HTML.
  {
    const a = findRow(email, 'second item has bold');
    const r = await copyVia(rows(email, a, a + 1), [email.original]);
    check('bold: plain text has no **', r.text === '- second item has bold text', r.text);
    check('bold: HTML <strong>', typeof r.html === 'string' && r.html.includes('<strong>bold</strong>'), r.html);
    const msg = 'We should **ship it today** and __tell the team__ after.';
    const r2 = await copyVia('  We should ship it today and tell the team after.', [msg]);
    check('bold: ** and __ both dropped', r2.text === 'We should ship it today and tell the team after.', r2.text);
  }

  // A table, drawn in box drawing.
  {
    const a = findRow(mixed, '┌');
    const r = await copyVia(rows(mixed, a, findRow(mixed, '└') + 1), [mixed.original]);
    check('table: rows of tab-separated cells', r.text === 'Name\tValue\nalpha\t10\nbeta\t20', r.text);
    check('table: HTML table', typeof r.html === 'string' && r.html.includes('<th>Name</th>') && r.html.includes('<td>beta</td><td>20</td>'), r.html);
  }

  // 5. Across two replies: fallback, the drawn text as copied.
  {
    const sel = `${email.drawn.slice(-2).join('\n')}\n\n${mixed.drawn.slice(0, 2).join('\n')}`;
    logs.length = 0;
    const r = await copyVia(sel, [email.original, mixed.original]);
    check('two replies: the drawn text, no HTML', r.text === sel && r.html === null, { text: r.text, html: r.html });
    check('two replies: logged fallback "not found"', logs.some((l) => l.msg === '[COPY] fallback' && l.data.reason === 'not found'), logs);
  }

  // 6. No transcript: fallback.
  {
    logs.length = 0;
    const sel = rows(email, 2, 4);
    const r = await copyVia(sel, null);
    check('no transcript: the drawn text', r.text === sel && r.html === null, r);
    check('no transcript: logged fallback "no transcript"', logs.some((l) => l.msg === '[COPY] fallback' && l.data.reason === 'no transcript'), logs);
  }

  // 7. HTML escaping: Claude's own <script>, and a javascript: link.
  {
    const a = findRow(mixed, '<script>');
    const r = await copyVia(rows(mixed, a, a + 1), [mixed.original]);
    check('escaping: plain text keeps <script> as written', r.text === 'Ends with <script>alert(1)</script> and snake_case_name.', r.text);
    check('escaping: HTML has &lt;script&gt; and no <script', typeof r.html === 'string' && r.html.includes('&lt;script&gt;alert(1)&lt;/script&gt;') && !/<script/i.test(r.html), r.html);
    const msg = 'Open [this page](javascript:alert(document.cookie)) or [that one](https://ok.example/"onmouseover="x) now please.';
    const r2 = await copyVia('  Open this page or that one now please.', [msg]);
    check('escaping: a javascript: link loses its href', typeof r2.html === 'string' && !r2.html.includes('javascript:') && r2.html.includes('this page'), r2.html);
    check('escaping: an href with a quote is never written raw', typeof r2.html === 'string' && !r2.html.includes('"onmouseover'), r2.html);
  }

  // Ambiguity and short selections.
  {
    const r = await copyVia('the plan is ready to go', ['So: the **plan** is ready to go.', 'Then: the plan is ready to go.']);
    check('ambiguous: two different originals fall back', r.html === null && r.text === 'the plan is ready to go', r);
    const same = 'The **plan** is ready to go.';
    const r2 = await copyVia('The plan is ready to go.', [same, 'other words entirely', same]);
    check('the same reply twice is no ambiguity', r2.text === 'The plan is ready to go.' && typeof r2.html === 'string' && r2.html.includes('<strong>plan</strong>'), r2);
    logs.length = 0;
    const r3 = await copyVia('word', ['a **word** here']);
    check('one word: today\'s copy', r3.text === 'word' && r3.html === null, r3);
  }

  // 8. Timing: never slower than ~100 ms; a late original replaces only its own text.
  {
    const a = findRow(email, 'second item has bold');
    const sel = rows(email, a, a + 1);
    const t0 = Date.now();
    const r = await copyVia(sel, [email.original], { delayMs: 300 });
    const tookMs = Date.now() - t0;
    check('slow lookup: the drawn text at once (under 200 ms)', tookMs < 200 && r.text === sel && r.outcome === 'late', { tookMs, outcome: r.outcome, text: r.text });
    await new Promise((res) => setTimeout(res, 400));
    check('slow lookup: the original replaces it when it lands', r.c.clip.text === '- second item has bold text' && typeof r.c.clip.html === 'string', r.c.clip);

    const r2 = await copyVia(sel, [email.original], { delayMs: 300 });
    await r2.c.clip.api.writeText('something he copied elsewhere');
    await new Promise((res) => setTimeout(res, 400));
    check('slow lookup: a clipboard changed meanwhile is left alone', r2.c.clip.text === 'something he copied elsewhere', r2.c.clip.text);

    logs.length = 0;
    const r3 = await copyVia(sel, [email.original], { delayMs: 1200 });
    await new Promise((res) => setTimeout(res, 1300));
    check('too slow (over 1 s): the drawn text stays', r3.c.clip.text === sel && r3.c.clip.html === null, r3.c.clip);
    check('too slow: logged fallback "too slow"', logs.some((l) => l.msg === '[COPY] fallback' && l.data.reason === 'too slow'), logs);

    // Copy-on-select: upgrade replaces the drawn text already on the clipboard.
    const c = makeCopier([email.original]);
    await c.clip.api.writeText(sel);
    await c.copy(7, sel, 'upgrade');
    check('copy-on-select upgrade: drawn text replaced by the original', c.clip.text === '- second item has bold text' && typeof c.clip.html === 'string', c.clip);
    const c2 = makeCopier([email.original]);
    await c2.clip.api.writeText('other');
    await c2.copy(7, sel, 'upgrade');
    check('copy-on-select upgrade: a clipboard holding something else is left alone', c2.clip.text === 'other', c2.clip.text);
  }


  // 9. Code: Claude Code draws a fenced block two spaces in, the code as written.
  //    The copy carries every symbol he selected and the first line's own indent.
  {
    const drawCode = (lines) => lines.map((l) => `  ${l}`).join('\n');
    const js = 'Use this:\n\n```js\nfunction f(x) {\n  const o = {\n    a: 1,\n  };\n  return o.a + x;\n}\n```\n\nThat works.';
    const py = 'Like so:\n\n```python\nclass A:\n    def f(self):\n        if x:\n            return 1\n        return 2\n```';
    const cases = [
      ['a shell comment keeps its #', ['# install deps', 'npm install'], 'Steps:\n\n```bash\n# install deps\nnpm install\n```'],
      ['one commented line keeps its # (never a live command)', ['# sudo reboot now'], 'Not yet:\n\n```bash\n# sudo reboot now\necho done\n```'],
      ['an SQL comment keeps its --', ['-- vacuum db;', 'select 1;'], 'Then:\n\n```sql\n-- vacuum db;\nselect 1;\n```'],
      ['a closing } is kept', ['function f(x) {', '  const o = {', '    a: 1,', '  };', '  return o.a + x;', '}'], js],
      ['a closing }; is kept', ['  const o = {', '    a: 1,', '  };'], js],
      ['a line ending " {" keeps it', ['function f(x) {'], js],
      ['// comments keep their //', ['// first comment', '// second comment'], 'Code:\n\n```js\n// first comment\n// second comment\nlet a = 1;\n```'],
      ['Python: the first line keeps its indent', ['        if x:', '            return 1', '        return 2'], py],
      ['Python: a deeper first line keeps its indent', ['            return 1', '        return 2'], py],
      ['a "- " list line in a fence keeps its -', ['- first: one', '- second: two'], 'YAML:\n\n```yaml\n- first: one\n- second: two\n```'],
      ['a "$ " prompt in a fence keeps its $', ['$ npm run build', '$ npm test'], 'Run:\n\n```\n$ npm run build\n$ npm test\n```'],
    ];
    for (const [name, lines, msg] of cases) {
      const r = await copyVia(drawCode(lines), [msg]);
      check(`code: ${name}`, r.text === lines.join('\n'), { got: r.text, want: lines.join('\n') });
    }
    const r = await copyVia(drawCode(['  const o = {', '    a: 1,', '  };']), [js]);
    check('code: HTML is a <pre> block with the symbols', typeof r.html === 'string' && r.html.includes('<pre><code>  const o = {') && r.html.includes('};</code></pre>'), r.html);
  }
  // Prose: a symbol at the edge (em dash, emoji) is kept.
  {
    const msg = 'He waited — and then we left, quietly. 🎉 Shipped it today.';
    const r = await copyVia('  — and then we left', [msg]);
    check('prose: a leading em dash is kept', r.text === '— and then we left', r.text);
    const r2 = await copyVia('  He waited —', [msg]);
    check('prose: a trailing em dash is kept', r2.text === 'He waited —', r2.text);
    const r3 = await copyVia('  🎉 Shipped it today.', [msg]);
    check('prose: a leading emoji is kept', r3.text === '🎉 Shipped it today.', r3.text);
  }
  // Never less than he selected: a symbol the reply lacks means today's copy.
  {
    logs.length = 0;
    const sel = '  # npm install now';
    const r = await copyVia(sel, ['Then run npm install now and wait.']);
    check('inexact: a selected # the reply lacks falls back to the drawn text', r.text === sel && r.html === null, r);
    check('inexact: logged fallback "inexact"', logs.some((l) => l.msg === '[COPY] fallback' && l.data.reason === 'inexact'), logs);
  }

  // 10. Tool output and his prompt: never replaced by Claude's wording.
  {
    const quoted = ['All tests pass now, and the build is green.'];
    logs.length = 0;
    const tool = '  ⎿  all tests pass now';
    const r = await copyVia(tool, quoted);
    check('tool output (⎿) quoted by Claude: the drawn text', r.text === tool && r.html === null, r);
    check('tool output: logged fallback "not reply"', logs.some((l) => l.msg === '[COPY] fallback' && l.data.reason === 'not reply'), logs);
    const prompt = '❯ all tests pass now please';
    const r2 = await copyVia(prompt, ['Yes: all tests pass now please.']);
    check('his prompt (❯) quoted by Claude: the drawn text', r2.text === prompt && r2.html === null, r2);
    // On screen: the renderer asks main only for rows inside a reply.
    if (!selectionInReply) {
      check('screen rows: reply rows tell from tool output and prompts', false, 'no module');
    } else {
      const screen = [
        '❯ run the tests please', '  and the build', '',
        '⏺ Bash(npm test)', '  ⎿  all tests pass now', '     and the build is green', '',
        ...email.drawn, '', '✻ Thinking…',
      ];
      const rowAt = (y) => (screen[y] === undefined ? null : { text: screen[y], wrapped: false });
      const top = 7;
      const bottom = top + email.drawn.length - 1;
      check('screen rows: the whole reply is a reply', selectionInReply(rowAt, top, bottom) === true);
      check('screen rows: a reply\'s inner rows are a reply', selectionInReply(rowAt, top + 5, top + 8) === true);
      check('screen rows: tool output is not', selectionInReply(rowAt, 4, 4) === false);
      check('screen rows: a tool output continuation row is not', selectionInReply(rowAt, 5, 5) === false);
      check('screen rows: his prompt and its second row are not', selectionInReply(rowAt, 0, 0) === false && selectionInReply(rowAt, 1, 1) === false);
      check('screen rows: tool output into a reply is not', selectionInReply(rowAt, 4, top + 2) === false);
      check('screen rows: a reply into the status line is not', selectionInReply(rowAt, top, bottom + 2) === false);
      // A reply row soft-wrapped by xterm: its tail is no item start, even one beginning with a symbol.
      check('screen rows: a soft-wrapped row is never an item start', selectionInReply((y) => (y === 0 ? { text: '⏺ A reply', wrapped: false } : { text: '>tail of it', wrapped: true }), 1, 1) === true);
    }
  }

  // 11. Sequence: an earlier copy's lookup landing late never overwrites a later copy.
  {
    const clip = makeClipboard();
    let call = 0;
    const msgs = ['First words to copy here.', 'Second words to copy here.'];
    const copier = CopyOriginal ? new CopyOriginal({
      transcriptFor: () => '/fake/transcript.jsonl',
      // The first copy's lookup takes 60 ms, the second's none: both inside the quick 100 ms.
      recentTexts: async () => { const mine = call++; if (mine === 0) await new Promise((r) => setTimeout(r, 60)); return msgs; },
      clipboard: clip.api,
      log: (msg, data) => logs.push({ msg, data }),
    }) : null;
    const copy = copier ? (sel) => copier.copy(7, sel, 'copy') : async (sel) => { await new Promise((r) => setTimeout(r, sel.startsWith('First') ? 60 : 0)); await clip.api.writeText(sel); return 'fallback'; };
    const first = copy('First words to copy');
    await new Promise((r) => setTimeout(r, 10));
    const second = copy('Second words to copy');
    await Promise.all([first, second]);
    await new Promise((r) => setTimeout(r, 50));
    check('sequence: the later copy stays on the clipboard', clip.text === 'Second words to copy', clip.text);
    // The earlier copy's lookup is late (past the quick 100 ms) while the later
    // one's original is already on: the earlier one's drawn text must not go on.
    const clip2 = makeClipboard();
    let call2 = 0;
    const copier2 = CopyOriginal ? new CopyOriginal({
      transcriptFor: () => '/fake/transcript.jsonl',
      recentTexts: async () => { const mine = call2++; if (mine === 0) await new Promise((r) => setTimeout(r, 300)); return msgs; },
      clipboard: clip2.api,
      log: () => {},
    }) : null;
    if (copier2) {
      const f = copier2.copy(7, 'First words to copy', 'copy');
      await new Promise((r) => setTimeout(r, 40));
      const s2 = copier2.copy(7, 'Second words to copy', 'copy');
      await Promise.all([f, s2]);
      await new Promise((r) => setTimeout(r, 400));
    }
    check('sequence: an earlier copy gone late leaves the later copy\'s original', clip2.text === 'Second words to copy' && typeof clip2.html === 'string' && clip2.html.includes('Second'), clip2);
  }

  // 12. The parser stays fast on pathological 100 KB replies and never throws.
  {
    if (!parseMarkdown) {
      check('parser: pathological replies parse fast', false, 'no module');
    } else {
      const K = 100 * 1024;
      const cases = {
        'unmatched *': '*a '.repeat(K / 3), 'unmatched _': '_a '.repeat(K / 3), 'unmatched **': '**a '.repeat(K / 4),
        'unmatched [': '[a '.repeat(K / 3), 'unclosed link href': '[a](b '.repeat(K / 6),
        'a heading with 100k inner spaces': `# a${' '.repeat(K)}#x`, 'deep > nesting': `${'> '.repeat(K / 2)}a`,
        'mixed openers': '*a _b [c `d '.repeat(K / 12),
      };
      for (const [name, text] of Object.entries(cases)) {
        const t0 = Date.now();
        let err = null;
        try { parseMarkdown(text); } catch (e) { err = e.name; }
        const ms = Date.now() - t0;
        check(`parser: ${name} (${text.length} chars) parses under 250 ms`, err === null && ms < 250, { ms, err });
      }
      const r = await copyVia('  The plan is ready to go now.', [`${'> '.repeat(K / 2)}a`, 'The **plan** is ready to go now.']);
      check('parser: an unparseable reply in the window does not stop another matching', typeof r.html === 'string' && r.html.includes('<strong>plan</strong>'), r);
    }
  }

  // Logs never carry the copied text.
  {
    const leaked = logs.concat().some((l) => JSON.stringify(l.data).includes('bold text') || JSON.stringify(l.data).includes('Sarah'));
    check('logs carry no copied text', CopyOriginal !== null && !leaked, CopyOriginal ? logs : 'no module');
  }

  // Bounded transcript reads: assistant text blocks only, appended lines picked up once.
  {
    if (!TranscriptTexts) {
      check('transcript: assistant text blocks read from the file', false, 'no module');
    } else {
      const file = join(work, 't.jsonl');
      const line = (o) => `${JSON.stringify(o)}\n`;
      writeFileSync(file, [
        line({ type: 'user', message: { role: 'user', content: 'Hi **there**' } }),
        line({ type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'First **reply**.' }] } }),
        line({ type: 'assistant', message: { id: 'm1', content: [{ type: 'tool_use', name: 'Bash', input: {} }] } }),
        line({ type: 'assistant', isSidechain: true, message: { content: [{ type: 'text', text: 'Subagent text' }] } }),
        line({ type: 'assistant', message: { id: 'm2', content: [{ type: 'text', text: 'Second reply.' }, { type: 'text', text: 'Third block.' }] } }),
      ].join(''));
      const tt = new TranscriptTexts(1024 * 1024, 3);
      let got = await tt.recent(file);
      check('transcript: assistant text blocks only, subagents skipped', JSON.stringify(got) === JSON.stringify(['First **reply**.', 'Second reply.', 'Third block.']), got);
      const next = line({ type: 'assistant', message: { content: [{ type: 'text', text: 'Fourth — new.' }] } });
      const bytes = Buffer.from(next);
      const cut = bytes.indexOf(Buffer.from('—')) + 1; // mid-character
      appendFileSync(file, bytes.subarray(0, cut));
      got = await tt.recent(file);
      check('transcript: an unfinished line waits', got.length === 3 && !got.includes('Fourth — new.'), got);
      appendFileSync(file, bytes.subarray(cut));
      got = await tt.recent(file);
      check('transcript: completed, read once, cut to the newest 3', JSON.stringify(got) === JSON.stringify(['Second reply.', 'Third block.', 'Fourth — new.']), got);
      const small = new TranscriptTexts(200, 200);
      got = await small.recent(file);
      check('transcript: a bounded read takes only the file\'s tail', got.length >= 1 && got.length < 4 && got[got.length - 1] === 'Fourth — new.', got);
    }
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

console.log(`\n${passed} ok, ${failed} failed`);
process.exit(failed ? 1 : 0);
