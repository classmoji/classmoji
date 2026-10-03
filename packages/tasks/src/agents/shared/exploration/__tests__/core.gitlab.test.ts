/**
 * Which repository the in-process exploration reads: the tree and file reads
 * (`workflows/exploreRepo.ts`) are spied on, so the test sees the owner and
 * host each read is given. A Gitlab exploration reads the project's namespace
 * on its instance; a Github one passes no host, as before.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';

const reads = vi.hoisted(() => ({
  tree: vi.fn(),
  files: vi.fn(),
}));

vi.mock('@trigger.dev/sdk/v3', () => ({
  task: (config: unknown) => config,
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), log: vi.fn() },
  metadata: { set: vi.fn(), append: vi.fn(), flush: vi.fn() },
}));

vi.mock('../../../../workflows/exploreRepo.ts', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../../workflows/exploreRepo.ts')>()),
  fetchRepoTree: reads.tree,
  fetchMultipleFiles: reads.files,
}));

const { exploreRepository } = await import('../core.ts');

const text = (t: string) => ({
  id: 'msg',
  type: 'message',
  role: 'assistant',
  model: 'claude-sonnet-5',
  stop_reason: 'end_turn',
  usage: { input_tokens: 1, output_tokens: 1 },
  content: [{ type: 'text', text: t }],
});

function stubClient(answers: string[]): Anthropic {
  const create = vi.fn(async () => {
    const answer = answers.shift();
    if (answer === undefined) throw new Error('no stubbed answer left');
    return text(answer);
  });
  return { messages: { create } } as unknown as Anthropic;
}

const STYLE = '.features {\n  display: grid;\n}\n';

function input(overrides: Partial<Parameters<typeof exploreRepository>[0]> = {}) {
  return {
    owner: 'sample-org',
    repo: 'landing-page',
    token: 'token-value',
    model: 'claude-sonnet-5',
    effort: 'medium',
    focusArea: 'layout',
    depth: 'focused' as const,
    specificQuestion: null,
    previousFindings: [],
    previouslyReadFiles: [],
    client: stubClient([
      JSON.stringify(['css/style.css']),
      JSON.stringify({
        excerpts: [{ path: 'css/style.css', start_line: 1, end_line: 3, why: 'grid' }],
      }),
    ]),
    signal: new AbortController().signal,
    onFileRead: vi.fn(),
    ...overrides,
  } as Parameters<typeof exploreRepository>[0];
}

beforeEach(() => {
  reads.tree.mockReset().mockResolvedValue([{ path: 'css/style.css', type: 'blob', size: 30 }]);
  reads.files
    .mockReset()
    .mockImplementation(async (_o: string, _r: string, paths: string[]) =>
      paths.map(path => ({ path, content: STYLE }))
    );
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('exploreRepository: where it reads', () => {
  it('reads a Gitlab project from its namespace on its instance', async () => {
    const result = await exploreRepository(
      input({
        owner: 'dept/cs10/projects',
        repo: 'landing-page-ada',
        token: 'project-token',
        gitHost: 'https://gitlab.example.edu',
      })
    );
    expect(result.filesRead).toEqual(['css/style.css']);
    expect(reads.tree).toHaveBeenCalledWith(
      'dept/cs10/projects',
      'landing-page-ada',
      'project-token',
      'https://gitlab.example.edu'
    );
    const [owner, repo, paths, token, , options] = reads.files.mock.calls[0];
    expect([owner, repo, paths, token]).toEqual([
      'dept/cs10/projects',
      'landing-page-ada',
      ['css/style.css'],
      'project-token',
    ]);
    expect(options).toMatchObject({ gitHost: 'https://gitlab.example.edu' });
  });

  it('reads a Github repository from the org with no host, as before', async () => {
    await exploreRepository(input());
    expect(reads.tree.mock.calls[0]).toEqual(['sample-org', 'landing-page', 'token-value']);
    const [owner, , , , , options] = reads.files.mock.calls[0];
    expect(owner).toBe('sample-org');
    expect(Object.keys(options as object)).toEqual(['isExcluded']);
  });
});
