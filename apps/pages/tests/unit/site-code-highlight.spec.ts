/**
 * Unit tests for the class site's syntax colouring (codeHighlight.server.ts).
 *
 * What they exist to hold:
 *  - Code blocks come out as the app's editor decorates them: one
 *    `<span class="shiki">` per token with `--shiki-light`/`--shiki-dark`,
 *    for a stored id or alias, and the schema default when there is none.
 *  - A language the app leaves plain (unknown, wrong case, plain text, empty)
 *    renders exactly the markup the site rendered before colouring existed.
 *  - Code text is escaped: the markup's text is the code, byte for byte, and
 *    nothing in it becomes an element. Neither can a document name a slot.
 *  - A highlighter that throws or never loads leaves the code plain and the
 *    page rendered.
 *  - Terminals are coloured as TerminalBlock.tsx colours them.
 *  - The cost is bounded: oversized blocks are never tokenized, a render
 *    stops tokenizing at its time budget, and the markup cache is capped.
 */

import { test, expect } from '@playwright/test';
// @ts-expect-error -- jsdom ships no type declarations and `@types/jsdom` is
// not a dependency; the cast below pins the shape this file uses.
import { JSDOM as UntypedJSDOM } from 'jsdom';

import { renderSitePage } from '~/site/render.server.ts';
import { SITE_STYLES } from '~/site/styles.ts';
import {
  codeInDocument,
  prepareSiteCodeHighlighter,
  siteCodeHighlighter,
  type HighlightLimits,
  type ShikiLike,
  type SiteShikiSources,
} from '~/site/codeHighlight.server.ts';

const JSDOM = UntypedJSDOM as new (html?: string) => { window: { document: Document } };
const parse = (html: string): Document => new JSDOM(`<body>${html}</body>`).window.document;

const resolveLink = () => null;

const codeBlock = (code: string, language?: unknown) => ({
  type: 'codeBlock',
  props: language === undefined ? {} : { language },
  content: [{ type: 'text', text: code, styles: {} }],
});

const terminal = (code: string) => ({ type: 'terminal', props: { code, title: 'Terminal' } });

/** A Shiki with no languages: every block stays plain. */
const NO_LANGUAGES: ShikiLike = {
  loadLanguage: async () => undefined,
  getLoadedLanguages: () => [],
  codeToTokens: () => ({ tokens: [] }),
  codeToHtml: () => '',
};
const PLAIN_SOURCES: SiteShikiSources = {
  codeBlocks: async () => NO_LANGUAGES,
  terminals: async () => NO_LANGUAGES,
};

/** The same document rendered with nothing coloured: the site before colouring. */
const renderPlain = (blocks: unknown[]) =>
  renderSitePage({ blocks, resolveLink, codeHighlighters: PLAIN_SOURCES });

/**
 * A Shiki that knows `javascript` and `bash` and makes one span per code,
 * counting its calls and advancing `clock` by `costMs` for each.
 */
function countingShiki(costMs = 0, clock = { ms: 0 }) {
  const calls = { tokens: 0, html: 0 };
  const shiki: ShikiLike = {
    loadLanguage: async () => undefined,
    getLoadedLanguages: () => ['javascript', 'bash'],
    codeToTokens: code => {
      calls.tokens++;
      clock.ms += costMs;
      return { tokens: [[{ content: code, offset: 0, htmlStyle: { color: '#123456' } }]] };
    },
    codeToHtml: code => {
      calls.html++;
      clock.ms += costMs;
      return `<pre>${code}</pre>`;
    },
  };
  return { shiki, calls, clock };
}

const limits = (overrides: Partial<HighlightLimits> = {}): HighlightLimits => ({
  blockChars: 50_000,
  budgetMs: 300,
  cacheChars: 8_000_000,
  entryChars: 1_000_000,
  now: () => 0,
  ...overrides,
});

const codeOf = (html: string) =>
  parse(html).querySelector('[data-content-type="codeBlock"] pre code')!;

test.describe('code blocks', () => {
  test('a known language is coloured with both theme colours, as the app does', async () => {
    const { html } = await renderSitePage({
      blocks: [codeBlock('const a = 1;', 'javascript')],
      resolveLink,
    });
    const code = codeOf(html);
    const spans = code.querySelectorAll('span.shiki');
    expect(spans.length).toBeGreaterThan(3);
    for (const span of spans) {
      expect(span.getAttribute('style')).toMatch(
        /^--shiki-light:#[0-9A-Fa-f]{6};--shiki-dark:#[0-9A-Fa-f]{6}/
      );
    }
    expect(code.textContent).toBe('const a = 1;');
    // Still the block's own code element, with the language label beside it.
    expect(code.className).toBe('bn-inline-content');
    expect(html).toContain('<span class="bn-code-language">JavaScript</span>');
  });

  test('aliases colour (bash, ts, js), and a block with no language is javascript', async () => {
    for (const language of ['bash', 'ts', 'js', undefined]) {
      const { html } = await renderSitePage({
        blocks: [codeBlock('const x = "y"; echo $HOME', language)],
        resolveLink,
      });
      expect(codeOf(html).querySelectorAll('span.shiki').length, String(language)).toBeGreaterThan(
        0
      );
    }
  });

  // A language that is not a string (null, a number, an array) is plain in the
  // app too: BlockNote keeps it on the node and hands it to Shiki, which
  // loads nothing for it. `['ts']` would read as "ts" if stringified, and
  // then be coloured or not depending on what the process had loaded.
  test('a language the app leaves plain renders exactly as before', async () => {
    for (const language of [
      'brainfuck',
      'TypeScript',
      'text',
      'txt',
      'plaintext',
      'none',
      '',
      'constructor',
      null,
      5,
      ['ts'],
    ]) {
      const blocks = [codeBlock('let a = 1 < 2 && 3 > 2;', language)];
      const { html } = await renderSitePage({ blocks, resolveLink });
      expect(html, String(language)).not.toContain('shiki');
      expect(html, String(language)).toBe((await renderPlain(blocks)).html);
    }
  });

  test('code text is escaped, and the markup reads back as the code', async () => {
    const code =
      '<script>alert(1)</script>\r\n' +
      '</code></pre><img src=x onerror=alert(1)>\n' +
      '\tconst s = "&amp; & \'q\'";\n' +
      '\n' +
      '// trailing newline next\n';
    for (const language of ['typescript', 'html', 'bash']) {
      const { html } = await renderSitePage({ blocks: [codeBlock(code, language)], resolveLink });
      const doc = parse(html);
      expect(doc.querySelector('script'), language).toBeNull();
      expect(doc.querySelector('img'), language).toBeNull();
      expect(html, language).not.toContain('<script');
      expect(html, language).not.toContain('<img');
      const element = doc.querySelector('[data-content-type="codeBlock"] pre code')!;
      expect(element.querySelectorAll('span.shiki').length, language).toBeGreaterThan(0);
      // The code byte for byte, but for the CR: an HTML parser folds CRLF into
      // LF in any text, as it always has in the plain render.
      expect(element.textContent, language).toBe(code.replace(/\r\n/g, '\n'));
      expect(element.textContent, language).toBe(
        codeOf((await renderPlain([codeBlock(code, language)])).html).textContent
      );
      // Every & in the code's markup starts an entity.
      const inner = html.slice(
        html.indexOf('<code class="bn-inline-content">'),
        html.indexOf('</code></pre>')
      );
      expect(inner.match(/&(?!amp;|lt;|gt;|quot;|#39;)/g), language).toBeNull();
    }
  });

  test('a document cannot name a slot', async () => {
    const { shiki } = countingShiki();
    const a = siteCodeHighlighter(shiki, null, limits());
    const b = siteCodeHighlighter(shiki, null, limits());
    const slotA = a.codeBlock('const a = 1;', 'javascript')!;
    const slotB = b.codeBlock('const b = 2;', 'javascript')!;
    expect(slotA).toMatch(/^\uE000[0-9a-f-]{36}:0\uE001$/);
    expect(slotB).not.toBe(slotA);
    // One render's fill leaves another's slots alone: a slot in a document is
    // only ever its own text.
    const page = `<code>${slotA}</code><code>${slotB}</code>`;
    const filled = a.fill(page);
    expect(filled).toContain('const a = 1;</span>');
    expect(filled).toContain(`<code>${slotB}</code>`);
    expect(b.fill(filled)).not.toContain('\uE000');

    // Through a whole render: B's slot written into the code, coloured and not.
    const blocks = [codeBlock(`x ${slotB}`, 'javascript'), codeBlock(slotB, 'brainfuck')];
    const { html } = await renderSitePage({ blocks, resolveLink });
    const codes = parse(html).querySelectorAll('[data-content-type="codeBlock"] pre code');
    expect(codes[0].textContent).toBe(`x ${slotB}`);
    expect(codes[1].textContent).toBe(slotB);
    expect(codes[1].querySelector('span')).toBeNull();
  });
});

test.describe('cost', () => {
  test('a repeat is served from the cache, not tokenized again', () => {
    const { shiki, calls } = countingShiki();
    const first = siteCodeHighlighter(shiki, shiki, limits());
    const markup = first.fill(first.codeBlock('const a = 1;', 'javascript')!);
    first.terminal('ls');
    const second = siteCodeHighlighter(shiki, shiki, limits());
    expect(second.fill(second.codeBlock('const a = 1;', 'javascript')!)).toBe(markup);
    second.terminal('ls');
    expect(calls).toEqual({ tokens: 1, html: 1 });
    // The language is part of the key.
    second.codeBlock('const a = 1;', 'bash');
    expect(calls.tokens).toBe(2);
  });

  test('an entry over the entry cap is made but not kept', () => {
    const { shiki, calls } = countingShiki();
    const tight = limits({ entryChars: 100 });
    const code = 'x'.repeat(60); // key + markup is over 100 characters
    siteCodeHighlighter(shiki, null, tight).codeBlock(code, 'javascript');
    expect(siteCodeHighlighter(shiki, null, tight).codeBlock(code, 'javascript')).not.toBeNull();
    expect(calls.tokens).toBe(2);
  });

  test('the cache evicts the least recently used entry', () => {
    const { shiki, calls } = countingShiki();
    // Each entry: key "javascript\0" + 1 char (12) + markup (55) = 67 characters.
    const small = limits({ cacheChars: 3 * 67 });
    const colour = (code: string) =>
      siteCodeHighlighter(shiki, null, small).codeBlock(code, 'javascript');
    colour('a');
    colour('b');
    colour('c');
    colour('a'); // a is now the most recent; b the least
    expect(calls.tokens).toBe(3);
    colour('d'); // evicts b
    expect(calls.tokens).toBe(4);
    colour('a');
    colour('c');
    expect(calls.tokens).toBe(4);
    colour('b');
    expect(calls.tokens).toBe(5);
  });

  test('a block over the size cap is never tokenized and renders exactly as before', async () => {
    const { shiki, calls } = countingShiki();
    const highlighter = siteCodeHighlighter(shiki, shiki, limits({ blockChars: 10 }));
    expect(highlighter.codeBlock('x'.repeat(11), 'javascript')).toBeNull();
    expect(highlighter.terminal('x'.repeat(11))).toBeNull();
    expect(highlighter.codeBlock('x'.repeat(10), 'javascript')).not.toBeNull();
    expect(calls).toEqual({ tokens: 1, html: 0 });

    // The real limit, through a whole render with the real highlighters.
    const big = `const a = 1;\n`.repeat(4_000); // 52,000 characters
    const blocks = [codeBlock(big, 'javascript'), terminal(big)];
    const { html } = await renderSitePage({ blocks, resolveLink });
    expect(html).toBe((await renderPlain(blocks)).html);
  });

  test('a render stops tokenizing at its budget; the next one picks up from the cache', () => {
    const { shiki, calls, clock } = countingShiki(200, { ms: 0 });
    const budgeted = limits({ budgetMs: 300, now: () => clock.ms });
    const codes = ['a', 'b', 'c', 'd'];

    const first = siteCodeHighlighter(shiki, shiki, budgeted);
    // 200 ms, then 400 ms spent: the third block and the terminal are plain.
    expect(codes.slice(0, 3).map(code => first.codeBlock(code, 'javascript') !== null)).toEqual([
      true,
      true,
      false,
    ]);
    expect(first.terminal('ls')).toBeNull();
    expect(calls.tokens).toBe(2);

    // The next render gets the first two from the cache, at no cost, and has
    // its own budget for the rest.
    const second = siteCodeHighlighter(shiki, shiki, budgeted);
    expect(codes.map(code => second.codeBlock(code, 'javascript') !== null)).toEqual([
      true,
      true,
      true,
      true,
    ]);
    expect(calls.tokens).toBe(4);
  });
});

test.describe('terminals', () => {
  test('are coloured as TerminalBlock.tsx colours them, without Shiki’s background', async () => {
    const { html } = await renderSitePage({
      blocks: [terminal('# Mac\nnpm run dev\n\n# Windows (WSL)\necho "background-color:red;"')],
      resolveLink,
    });
    const doc = parse(html);
    const pre = doc.querySelector('.terminal-content pre.shiki.one-dark-pro')!;
    expect(pre).not.toBeNull();
    expect(pre.getAttribute('style')).not.toContain('background');
    expect(pre.getAttribute('style')).toMatch(/color:#/i);
    // The comment after the blank line is a comment (one-dark-pro: grey, italic).
    const line = [...pre.querySelectorAll('span.line')].find(
      l => l.textContent === '# Windows (WSL)'
    )!;
    for (const span of line.querySelectorAll('span')) {
      expect(span.getAttribute('style')).toMatch(/font-style:italic/);
    }
    // Only the <pre>'s background goes, never the code's text.
    expect(pre.textContent).toBe(
      '# Mac\nnpm run dev\n\n# Windows (WSL)\necho "background-color:red;"'
    );
  });

  test('escape their code', async () => {
    const code =
      '<h1 a>b</h1><img src=x onerror=alert(1)>\n</pre></div><script>x()</script> & done';
    const { html } = await renderSitePage({ blocks: [terminal(code)], resolveLink });
    const doc = parse(html);
    expect(doc.querySelector('img')).toBeNull();
    expect(doc.querySelector('script')).toBeNull();
    expect(doc.querySelector('.terminal-content pre')!.textContent).toBe(code);
  });

  test('an empty terminal renders as before', async () => {
    const blocks = [terminal('')];
    expect((await renderSitePage({ blocks, resolveLink })).html).toBe(
      (await renderPlain(blocks)).html
    );
  });
});

test.describe('failures leave the code plain', () => {
  /** A highlighter whose every highlighting call throws. */
  const throwing: ShikiLike = {
    loadLanguage: async () => undefined,
    getLoadedLanguages: () => ['javascript', 'bash'],
    codeToTokens: () => {
      throw new Error('tokenizer broke');
    },
    codeToHtml: () => {
      throw new Error('tokenizer broke');
    },
  };
  const blocks = [codeBlock('const a = 1;', 'javascript'), terminal('npm run dev')];

  test('a highlighter that throws', async () => {
    const { html } = await renderSitePage({
      blocks,
      resolveLink,
      codeHighlighters: { codeBlocks: async () => throwing, terminals: async () => throwing },
    });
    expect(html).toBe((await renderPlain(blocks)).html);
    expect(html).toContain('const a = 1;');
    expect(html).toContain('<code class="language-bash">npm run dev</code>');
  });

  test('a highlighter that cannot be created, or a grammar that cannot load (logged once)', async () => {
    const noGrammar: ShikiLike = {
      ...throwing,
      loadLanguage: () => Promise.reject(new Error('no grammar')),
      getLoadedLanguages: () => [],
    };
    const sources: SiteShikiSources = {
      codeBlocks: async () => noGrammar,
      terminals: () => Promise.reject(new Error('no shiki')),
    };
    const warnings: unknown[][] = [];
    const warn = console.warn;
    console.warn = (...args: unknown[]) => void warnings.push(args);
    try {
      for (let i = 0; i < 3; i++) {
        const { html } = await renderSitePage({ blocks, resolveLink, codeHighlighters: sources });
        expect(html).toBe((await renderPlain(blocks)).html);
      }
    } finally {
      console.warn = warn;
    }
    // The grammar's failure once, not once per render.
    expect(warnings.map(([message]) => message)).toEqual([
      '[site] grammar "javascript" did not load; its code renders plain',
    ]);
  });
});

test.describe('what a document needs', () => {
  test('languages at any depth, the default for a missing one, none for a non-string', () => {
    const found = codeInDocument([
      codeBlock('a', 'ts'),
      { type: 'paragraph', children: [codeBlock('b'), codeBlock('c', 'brainfuck')] },
      { type: 'columnList', children: [{ type: 'column', children: [terminal('ls')] }] },
      codeBlock('d', 'text'),
      codeBlock('e', null),
      codeBlock('f', ['css']),
    ]);
    expect([...found.languages].sort()).toEqual(['javascript', 'ts']);
    expect(found.terminals).toBe(true);
  });

  test('a page without code loads nothing', async () => {
    let asked = false;
    const never = async (): Promise<ShikiLike> => {
      asked = true;
      throw new Error('should not be asked');
    };
    const prepared = await prepareSiteCodeHighlighter(
      [{ type: 'paragraph', content: [] }, terminal('')],
      { codeBlocks: never, terminals: never }
    );
    expect(prepared).toBeNull();
    expect(asked).toBe(false);
  });
});

test.describe('site stylesheet', () => {
  test('restates the app editor’s ligature and terminal-wrapping rules', () => {
    expect(SITE_STYLES).toMatch(
      /\.site-article \.ProseMirror \{\s*-webkit-font-variant-ligatures: none;\s*font-variant-ligatures: none;\s*font-feature-settings: "liga" 0;\s*\}/
    );
    // Tiptap's specificity, so BlockNote's no-wrap rule for code blocks still wins.
    expect(SITE_STYLES).toMatch(
      /:where\(\.site-article\) \.ProseMirror pre \{\s*white-space: pre-wrap;\s*\}/
    );
  });
});
