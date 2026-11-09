/**
 * The markdown importer's HTML as the page create stores it: importer ->
 * `convertPageHtml` (the shared legacy-page converter) -> the asset-path
 * rewrite. Synthetic markdown only.
 */
import { describe, expect, it } from 'vitest';

import { convertMarkdownToHtml, processMarkdownImport } from '../markdownImporter.ts';
import { convertPageHtml, storeCommittedAssetPaths } from '../../classmoji/pageHtmlBlocks.ts';

interface Block {
  type: string;
  props?: Record<string, unknown>;
  content?: Array<{ type: string; text?: string; content?: Array<{ text?: string }> }>;
  children?: Block[];
}

const textOf = (block: Block | undefined) =>
  (block?.content ?? [])
    .map(c => c.text ?? (c.content ?? []).map(x => x.text ?? '').join(''))
    .join('');

/** Top-level blocks without empty spacer paragraphs. */
const solid = (blocks: Block[]) =>
  blocks.filter(b => !(b.type === 'paragraph' && !textOf(b) && !b.children?.length));

describe('markdown import: shell fences', () => {
  const markdown = 'Install it:\n\n```bash\nnpm install\n```\n\n```sh\nls -la\n```\n';

  it('a bash/sh fence is wrapped once, as a terminal, never also as a code block', () => {
    const html = convertMarkdownToHtml(markdown);
    expect(html.match(/class="terminal-block"/g)).toHaveLength(2);
    expect(html).not.toContain('class="code-block"');
  });

  it('converts to terminals with no stray "Terminal" paragraph above them', async () => {
    const blocks = (await convertPageHtml(convertMarkdownToHtml(markdown))) as Block[];
    expect(solid(blocks).map(b => [b.type, b.props?.title ?? textOf(b), b.props?.code])).toEqual([
      ['paragraph', 'Install it:', undefined],
      ['terminal', 'Terminal', 'npm install'],
      ['terminal', 'Terminal', 'ls -la'],
    ]);
  });

  it('other languages still get the code-block widget', () => {
    const html = convertMarkdownToHtml('```python\nx = 1\n```\n');
    expect(html).toContain('class="code-block"');
    expect(html).toContain('class="language-python"');
  });
});

describe('markdown import: Notion toggles', () => {
  it('a toggle keeps its body (stored base64 in data-encoded) as the toggle’s children', async () => {
    const markdown =
      '- ❓ What is a closure?\n\n    A function with its scope.\n\n    More detail.\n';
    const html = convertMarkdownToHtml(markdown);
    expect(html).toContain('data-encoded="');

    const blocks = (await convertPageHtml(html)) as Block[];
    const toggle = blocks.find(b => b.type === 'heading');
    expect(toggle?.props).toMatchObject({ isToggleable: true });
    expect(textOf(toggle)).toBe('❓ What is a closure?');
    expect(toggle?.children?.map(b => [b.type, textOf(b)])).toEqual([
      ['paragraph', 'A function with its scope.'],
      ['paragraph', 'More detail.'],
    ]);
  });
});

describe('markdown import: Gitlab images', () => {
  const SLIDES = 'https://slides.example.test';

  it('the absolute content-proxy URL of a committed image is stored as its bare repo path', async () => {
    const previous = process.env.SLIDES_URL;
    process.env.SLIDES_URL = `${SLIDES}/`;
    try {
      const { html, imageMap } = await processMarkdownImport(
        '# Lab\n\n![diagram](images/diagram.png)\n\n![remote](https://cdn.example.test/x.png)\n',
        [{ name: 'diagram.png' }],
        {
          org: 'test-group',
          repo: 'content-cs101',
          contentPath: 'pages/lab-1',
          assetsFolder: 'pages/lab-1/assets',
          provider: 'GITLAB',
        }
      );
      const committed = [...imageMap.values()].map(info => info.newPath as string);
      expect(committed).toHaveLength(1);
      expect(html).toContain(`src="${SLIDES}/content/test-group/content-cs101/${committed[0]}"`);

      const blocks = storeCommittedAssetPaths(await convertPageHtml(html, { title: 'Lab' }), {
        login: 'test-group',
        repo: 'content-cs101',
        committedPaths: new Set(committed),
        storeRepoPaths: true,
      }) as Block[];
      expect(blocks.filter(b => b.type === 'image').map(b => b.props?.url)).toEqual([
        committed[0],
        'https://cdn.example.test/x.png',
      ]);
    } finally {
      if (previous === undefined) delete process.env.SLIDES_URL;
      else process.env.SLIDES_URL = previous;
    }
  });

  it('another origin’s /content/ URL, or another repo’s, is left as it is', () => {
    const image = (url: string) => ({ type: 'image', props: { url } });
    const blocks = [
      image(`${SLIDES}/content/test-group/content-cs101/pages/lab-1/assets/a.png`),
      image(
        'https://elsewhere.example.test/content/test-group/content-cs101/pages/lab-1/assets/a.png'
      ),
      image(`${SLIDES}/content/other-group/content-cs101/pages/lab-1/assets/a.png`),
    ];
    const out = storeCommittedAssetPaths(blocks, {
      login: 'test-group',
      repo: 'content-cs101',
      committedPaths: new Set(['pages/lab-1/assets/a.png']),
      storeRepoPaths: true,
      slidesOrigin: SLIDES,
    });
    expect(out.map(b => b.props.url)).toEqual([
      'pages/lab-1/assets/a.png',
      blocks[1].props.url,
      blocks[2].props.url,
    ]);
  });
});

describe('markdown import: emoji callouts', () => {
  const TEXT = 'remember to save your work before you close the editor window';
  const callout = (emoji: string, text = TEXT) =>
    `<div class="callout" style="align-items: flex-start;"><span class="callout-emoji">${emoji}</span><span>${text}</span></div>`;
  const importHtml = async (markdown: string) =>
    (
      await processMarkdownImport(markdown, [], {
        org: 'o',
        repo: 'r',
        contentPath: 'pages/p',
        assetsFolder: 'pages/p/assets',
      })
    ).html;
  const calloutCount = (html: string) => (html.match(/class="callout"/g) ?? []).length;

  it('a paragraph, a blank line, then a callout', async () => {
    const html = await importHtml(`Intro paragraph.\n\n💡: ${TEXT}`);
    expect(html).toContain('<p>Intro paragraph.</p>');
    expect(html).toContain(callout('💡'));
    expect(calloutCount(html)).toBe(1);
  });

  it('a callout after three or more blank lines (the empty-paragraph spacer)', async () => {
    const html = await importHtml(`Intro text\n\n\n\n💡: ${TEXT}`);
    expect(html).toContain('<p></p>');
    expect(html).toContain(callout('💡'));
    expect(html).not.toContain('<p>💡');
  });

  it('a callout after a Notion toggle and a blank line', async () => {
    const html = await importHtml(`- ❓ Q?\n\n    Answer body\n\n⚠️: ${TEXT}`);
    expect(html).toContain('<details><summary>❓ Q?</summary>');
    expect(html).toContain(callout('⚠️'));
    expect(html).not.toContain('<p>⚠️');
  });

  it('a callout after a raw <pre> block keeps the block untouched', async () => {
    const html = await importHtml(`<pre>\n  keep   spacing\n</pre>\n\n💡: ${TEXT}`);
    expect(html).toContain('<pre>\n  keep   spacing\n</pre>');
    expect(html).toContain(callout('💡'));
  });

  it('an HTML block that ends a quote or the page gets no extra line', () => {
    expect(convertMarkdownToHtml('> <div>x</div>')).toBe(
      '<blockquote>\n<div>x</div></blockquote>\n'
    );
    expect(convertMarkdownToHtml('text\n\n<div>x</div>')).toBe('<p>text</p>\n<div>x</div>');
  });

  it('every callout emoji', async () => {
    const emojis = [
      '💻',
      '🚀',
      '❓',
      '💡',
      '⚠️',
      '📝',
      '✅',
      '❌',
      '🔥',
      '📌',
      '👉',
      '🎯',
      '📚',
      '🛠️',
      '🔔',
      '⭐',
    ];
    const html = await importHtml(emojis.map(e => `${e}: ${TEXT}`).join('\n\n'));
    expect(calloutCount(html)).toBe(emojis.length);
    for (const e of emojis) expect(html).toContain(callout(e));
  });

  it('a short legend line stays a paragraph', async () => {
    const html = await importHtml('💻 : run in Terminal');
    expect(calloutCount(html)).toBe(0);
    expect(html).toContain('<p>💻 : run in Terminal</p>');
  });

  it('an emoji in the middle of a paragraph stays a paragraph', async () => {
    const html = await importHtml(`Text with 💡: in the middle ${TEXT}`);
    expect(calloutCount(html)).toBe(0);
    expect(html).toContain(`<p>Text with 💡: in the middle ${TEXT}</p>`);
  });
});
