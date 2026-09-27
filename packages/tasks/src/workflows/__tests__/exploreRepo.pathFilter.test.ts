/**
 * Which repository paths the explore-repo task shows, picks and fetches.
 *
 * It applies the same rule as the ai-agent's secure file tools: a path with a
 * dot-prefixed component is left out, except `.gitignore` and the root
 * `.github/workflows/`, and symlinks are not explored. The tree the picker
 * sees is filtered by it, the picker's answer is held to that filtered tree
 * before anything is fetched, and a fetch whose answer is a symlink or names a
 * hidden path is refused.
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

const { isVisiblePath, isExplorableEntry, readablePickedPaths, fetchFileContent, exploreRepoTask } =
  await import('../exploreRepo.ts');

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

describe('isExplorableEntry', () => {
  it.each([
    [{ path: 'src/App.jsx', mode: '100644' }, true],
    [{ path: 'bin/run.sh', mode: '100755' }, true],
    [{ path: 'src/App.jsx' }, true],
    [{ path: 'docs/notes.md', mode: '120000' }, false],
    [{ path: '.env', mode: '100644' }, false],
  ])('%j → %s', (entry, expected) => {
    expect(isExplorableEntry(entry)).toBe(expected);
  });
});

describe('fetchFileContent', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const answer = (body: Record<string, unknown>) =>
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }))
    );
  const base64 = (text: string) => Buffer.from(text).toString('base64');

  it('returns the decoded text of a file', async () => {
    answer({ type: 'file', path: 'src/App.jsx', encoding: 'base64', content: base64('hi') });
    await expect(fetchFileContent('org', 'repo', 'src/App.jsx', 'ghs_x')).resolves.toBe('hi');
  });

  it('refuses an answer that is a symlink', async () => {
    answer({ type: 'symlink', path: 'docs/notes.md', target: 'README.md' });
    await expect(fetchFileContent('org', 'repo', 'docs/notes.md', 'ghs_x')).rejects.toThrow(
      'not explored'
    );
  });

  it('refuses an answer whose path is hidden, whatever path was asked for', async () => {
    answer({ type: 'file', path: '.env', encoding: 'base64', content: base64('SECRET=1') });
    await expect(fetchFileContent('org', 'repo', 'docs/notes.md', 'ghs_x')).rejects.toThrow(
      'not explored'
    );
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
    'docs/notes.md': 'README.md',
  };
  /** Listed by the Git Trees API with mode 120000. */
  const SYMLINKS = new Set(['docs/notes.md']);
  const text = (t: string) => ({
    content: [{ type: 'text', text: t }],
    stop_reason: 'end_turn',
    model: 'claude-sonnet-5',
    usage: { input_tokens: 1, output_tokens: 1 },
  });
  const fetched: string[] = [];

  beforeEach(() => {
    fetched.length = 0;
    mocks.create.mockReset();
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/git/trees/')) {
          const tree = Object.keys(REPO_FILES).map(path => ({
            path,
            type: 'blob',
            mode: SYMLINKS.has(path) ? '120000' : '100644',
            size: 10,
          }));
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

  it('lists no symlink to the picker and never fetches one it names', async () => {
    mocks.create.mockReset();
    mocks.create
      // The picker names the symlink, which it was never shown.
      .mockResolvedValueOnce(text('["docs/notes.md", "src/App.jsx"]'))
      .mockResolvedValueOnce(text('{"excerpts": []}'));

    await run();

    const pickerPrompt = JSON.stringify(mocks.create.mock.calls[0][0]);
    expect(pickerPrompt).toContain('src/App.jsx');
    expect(pickerPrompt).not.toContain('docs/notes.md');
    expect(fetched).toEqual(['src/App.jsx']);
  });
});
