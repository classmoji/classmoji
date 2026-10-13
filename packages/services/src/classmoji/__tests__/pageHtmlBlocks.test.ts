import { describe, it, expect } from 'vitest';
import { convertPageHtml, storeCommittedAssetPaths } from '../pageHtmlBlocks.ts';

/** Every text run in a block tree, in order. */
function textOf(blocks: unknown): string {
  const out: string[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== 'object') return;
    const record = node as { text?: unknown; content?: unknown; children?: unknown };
    if (typeof record.text === 'string') out.push(record.text);
    walk(record.content);
    walk(record.children);
  };
  walk(blocks);
  return out.join('');
}

describe('convertPageHtml', () => {
  it('converts with the shared legacy-page converter', async () => {
    const blocks = (await convertPageHtml('<p>Hello <em>there</em></p>')) as Array<{
      type: string;
    }>;
    expect(blocks.map(b => b.type)).toEqual(['paragraph']);
    expect(textOf(blocks)).toBe('Hello there');
  });

  // Fired at once (a batch import beside an MCP create), each comes back with
  // its own document and nothing else's. That the queue really runs them one
  // at a time is pinned in pageHtmlBlocks.queue.test.ts.
  it('keeps concurrent conversions apart', async () => {
    const inputs = Array.from(
      { length: 6 },
      (_, i) => `<h2>Doc ${i}</h2><p>Body of document ${i}</p><ul><li>item ${i}</li></ul>`
    );
    const results = await Promise.all(inputs.map(html => convertPageHtml(html)));
    results.forEach((blocks, i) => {
      const text = textOf(blocks);
      expect(text).toContain(`Body of document ${i}`);
      expect(text).toContain(`item ${i}`);
      for (let j = 0; j < inputs.length; j++) {
        if (j !== i) expect(text).not.toContain(`document ${j}`);
      }
    });
  });
});

describe('storeCommittedAssetPaths', () => {
  const login = 'test-org';
  const repo = 'content-cs101';
  const raw = (path: string, branch = 'main') =>
    `https://raw.githubusercontent.com/${login}/${repo}/${branch}/${path}`;
  const image = (url: string) => ({ type: 'image', props: { url, caption: '' } });

  const blocks = [
    image(raw('pages/lab/assets/a.png')),
    image(raw('pages/lab/assets/a.png', 'refs/heads/main')),
    image(raw('pages/other/assets/b.png')),
    image(`https://raw.githubusercontent.com/someone-else/${repo}/main/pages/lab/assets/a.png`),
    image('https://example.com/a.png'),
    {
      type: 'columnList',
      children: [{ type: 'column', children: [image(raw('pages/lab/x.pdf'))] }],
    },
  ];
  const committedPaths = new Set(['pages/lab/assets/a.png', 'pages/lab/x.pdf']);

  it('rewrites only this repo’s URLs for committed files, nested blocks included', () => {
    const out = storeCommittedAssetPaths(blocks, {
      login,
      repo,
      committedPaths,
      storeRepoPaths: true,
    }) as typeof blocks;

    expect(out.slice(0, 5).map(b => (b as ReturnType<typeof image>).props.url)).toEqual([
      'pages/lab/assets/a.png',
      'pages/lab/assets/a.png',
      raw('pages/other/assets/b.png'),
      `https://raw.githubusercontent.com/someone-else/${repo}/main/pages/lab/assets/a.png`,
      'https://example.com/a.png',
    ]);
    const nested = out[5] as { children: Array<{ children: Array<ReturnType<typeof image>> }> };
    expect(nested.children[0].children[0].props.url).toBe('pages/lab/x.pdf');
    // A clone: the input is untouched.
    expect((blocks[0] as ReturnType<typeof image>).props.url).toBe(raw('pages/lab/assets/a.png'));
  });

  it('leaves everything as written when the classroom is not served signed', () => {
    expect(
      storeCommittedAssetPaths(blocks, { login, repo, committedPaths, storeRepoPaths: false })
    ).toBe(blocks);
  });
});
