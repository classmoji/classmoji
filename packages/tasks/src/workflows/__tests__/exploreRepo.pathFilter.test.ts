/**
 * Which repository paths the explore-repo task shows, picks and fetches.
 *
 * It applies the same rule as the ai-agent's secure file tools: a path with a
 * dot-prefixed component is left out, except `.gitignore` and the root
 * `.github/workflows/`. The tree the picker sees is filtered by it, and the
 * picker's answer is held to that filtered tree before anything is fetched.
 * `@trigger.dev/sdk/v3` and the Anthropic SDK are mocked and `fetch` is
 * stubbed, so nothing reaches a network.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ create: vi.fn() }));

vi.mock('@trigger.dev/sdk/v3', () => ({
  task: (config: unknown) => config,
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
  metadata: { set: vi.fn(), append: vi.fn(), flush: vi.fn() },
}));

vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create: mocks.create };
  },
}));

vi.spyOn(console, 'log').mockImplementation(() => {});

const { isVisiblePath, readablePickedPaths, exploreRepoTask } = await import('../exploreRepo.ts');

describe('isVisiblePath', () => {
  it.each([
    ['src/App.jsx', true],
    ['./src/App.jsx', true],
    ['README.md', true],
    ['.gitignore', true],
    ['server/.gitignore', true],
    ['.github/workflows/ci.yml', true],
    ['.env', false],
    ['config/.env.local', false],
    ['.git/config', false],
    ['.npmrc', false],
    ['.ssh/id_rsa', false],
    ['.github/CODEOWNERS', false],
    ['.github', false],
    ['app/.github/workflows/ci.yml', false],
    ['.github/workflows/.secrets', false],
    ['.gitignore/inner', false],
  ])('%s → %s', (path, expected) => {
    expect(isVisiblePath(path)).toBe(expected);
  });
});

describe('readablePickedPaths', () => {
  it('keeps only picked paths that are files in the tree and visible', () => {
    const tree = [{ path: 'src/App.jsx' }, { path: '.gitignore' }];
    expect(readablePickedPaths(['src/App.jsx', '.env', 'made/up.js', '.gitignore'], tree)).toEqual([
      'src/App.jsx',
      '.gitignore',
    ]);
  });
});

describe('explore-repo task run', () => {
  const REPO_FILES: Record<string, string> = {
    'src/App.jsx': 'export default function App() {\n  return null;\n}\n',
    '.env': 'SECRET=value\n',
    '.github/workflows/ci.yml': 'on: push\n',
  };
  const fetched: string[] = [];

  beforeEach(() => {
    fetched.length = 0;
    mocks.create.mockReset();
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/git/trees/')) {
          const tree = Object.keys(REPO_FILES).map(path => ({ path, type: 'blob', size: 10 }));
          return new Response(JSON.stringify({ tree }), { status: 200 });
        }
        const path = decodeURIComponent(url.split('/contents/')[1]);
        fetched.push(path);
        const content = REPO_FILES[path];
        return content === undefined
          ? new Response('not found', { status: 404 })
          : new Response(
              JSON.stringify({
                encoding: 'base64',
                content: Buffer.from(content).toString('base64'),
              }),
              { status: 200 }
            );
      })
    );
    const text = (t: string) => ({
      content: [{ type: 'text', text: t }],
      stop_reason: 'end_turn',
      model: 'claude-sonnet-5',
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    mocks.create
      // The picker names a dotfile and a path that is not in the repository.
      .mockResolvedValueOnce(text('[".env", "src/App.jsx", "src/Missing.jsx"]'))
      .mockResolvedValueOnce(text('{"excerpts": []}'));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const run = () =>
    (
      exploreRepoTask as unknown as {
        run: (payload: Record<string, unknown>) => Promise<Record<string, unknown>>;
      }
    ).run({ owner: 'org', repo: 'repo', accessToken: 'ghs_x', focusArea: 'initial' });

  it('lists no hidden path to the picker and fetches only picked paths from that list', async () => {
    await run();

    const pickerPrompt = JSON.stringify(mocks.create.mock.calls[0][0]);
    expect(pickerPrompt).toContain('src/App.jsx');
    expect(pickerPrompt).toContain('.github/workflows/ci.yml');
    expect(pickerPrompt).not.toContain('.env');

    expect(fetched).toEqual(['src/App.jsx']);
  });
});
