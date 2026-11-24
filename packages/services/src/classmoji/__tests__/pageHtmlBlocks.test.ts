import { describe, it, expect } from 'vitest';
import { storeCommittedAssetPaths } from '../pageHtmlBlocks.ts';

// The conversion (`htmlToPageBlocks`) moved to the `page-import-convert`
// Trigger task; its suite (packages/tasks) pins it, concurrency included.

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
