/**
 * The in-process exploration on a fixture repository: GitHub is a stub served
 * from `quiz/__fixtures__/repos/`, the Anthropic client is a stub, and
 * `@trigger.dev/sdk/v3` is mocked. Nothing reaches the network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { githubStub } from '../../../quiz/__fixtures__/githubStub.ts';

const logs = vi.hoisted(() => ({ lines: [] as unknown[][] }));

vi.mock('@trigger.dev/sdk/v3', () => {
  const record = (...a: unknown[]) => {
    logs.lines.push(a);
  };
  return {
    task: (config: unknown) => config,
    logger: { info: record, warn: record, error: record, debug: record, log: record },
    metadata: { set: vi.fn(), append: vi.fn(), flush: vi.fn() },
  };
});

const {
  exploreRepository,
  ExplorationStoppedError,
  excerptSummaryLines,
  formatExcerptResult,
  EXPLORATION_FAILED_TEXT,
  providerStatus,
  untilAborted,
} = await import('../core.ts');

const FOCUS = 'focus-area-that-names-the-next-question';
const QUESTION = 'specific-question-text';

const text = (t: string) => ({
  id: 'msg',
  type: 'message',
  role: 'assistant',
  model: 'claude-sonnet-5',
  stop_reason: 'end_turn',
  usage: { input_tokens: 1, output_tokens: 1 },
  content: [{ type: 'text', text: t }],
});

function stubClient(answers: string[]) {
  const calls: Array<{
    body: { messages: Array<{ content: string }> };
    options: { signal?: AbortSignal };
  }> = [];
  const create = vi.fn(async (body: never, options: never) => {
    calls.push({ body, options });
    const answer = answers.shift();
    if (answer === undefined) throw new Error('no stubbed answer left');
    return text(answer);
  });
  return { client: { messages: { create } } as unknown as Anthropic, create, calls };
}

const PICK = JSON.stringify(['index.html', 'css/style.css', '.editorconfig', 'not/in/tree.js']);
const POINT = JSON.stringify({
  excerpts: [
    { path: 'css/style.css', start_line: 11, end_line: 15, why: 'grid layout for the features' },
    { path: 'index.html', start_line: 16, end_line: 21, why: 'features section markup' },
  ],
});

function input(overrides: Partial<Parameters<typeof exploreRepository>[0]> = {}) {
  return {
    owner: 'sample-org',
    repo: 'landing-page',
    token: 'token-value',
    model: 'claude-sonnet-5',
    effort: 'medium',
    focusArea: FOCUS,
    depth: 'focused' as const,
    specificQuestion: QUESTION,
    previousFindings: [],
    previouslyReadFiles: [],
    signal: new AbortController().signal,
    onFileRead: vi.fn(),
    ...overrides,
  } as Parameters<typeof exploreRepository>[0];
}

let consoleSpies: Array<ReturnType<typeof vi.spyOn>>;

beforeEach(() => {
  logs.lines = [];
  consoleSpies = (['log', 'info', 'warn', 'error', 'debug'] as const).map(level =>
    vi.spyOn(console, level).mockImplementation(() => {})
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('exploreRepository on a fixture repository', () => {
  it('returns numbered excerpts and reports each file read by path only', async () => {
    const gh = githubStub('landing-page');
    vi.stubGlobal('fetch', gh.fetchImpl);
    const { client } = stubClient([PICK, POINT]);
    const onFileRead = vi.fn();

    const result = await exploreRepository(input({ client, onFileRead }));

    expect(onFileRead.mock.calls).toEqual([['index.html'], ['css/style.css']]);
    expect(result.filesRead).toEqual(['index.html', 'css/style.css']);
    expect(result.excerpts.map(e => e.path)).toEqual(['css/style.css', 'index.html']);
    expect(result.excerptText).toContain('13|   grid-template-columns: repeat(2, 1fr);');
  });

  it('never lists, picks or fetches a dotted path, nor one the tree does not have', async () => {
    const gh = githubStub('landing-page');
    vi.stubGlobal('fetch', gh.fetchImpl);
    const { client, calls } = stubClient([PICK, POINT]);

    await exploreRepository(input({ client }));

    expect(gh.requested.some(url => url.includes('.editorconfig'))).toBe(false);
    expect(gh.requested.some(url => url.includes('not/in/tree.js'))).toBe(false);
    expect(calls[0].body.messages[0].content).not.toContain('.editorconfig');
  });

  it('marks a failed read as an error step, still with the path only', async () => {
    const gh = githubStub('landing-page', { failPaths: ['css/style.css'] });
    vi.stubGlobal('fetch', gh.fetchImpl);
    const { client } = stubClient([PICK, POINT]);
    const onFileRead = vi.fn();

    await exploreRepository(input({ client, onFileRead }));

    expect(onFileRead.mock.calls).toEqual([['index.html'], ['css/style.css', { error: true }]]);
  });

  it('never logs the focus area or the specific question', async () => {
    const gh = githubStub('landing-page');
    vi.stubGlobal('fetch', gh.fetchImpl);
    const { client } = stubClient([PICK, POINT]);

    await exploreRepository(input({ client }));

    const logged = JSON.stringify([...logs.lines, ...consoleSpies.flatMap(spy => spy.mock.calls)]);
    expect(logs.lines.length).toBeGreaterThan(0);
    expect(logged).not.toContain(FOCUS);
    expect(logged).not.toContain(QUESTION);
    expect(logged).not.toContain('token-value');
  });

  it('passes the turn signal to every model call', async () => {
    const gh = githubStub('landing-page');
    vi.stubGlobal('fetch', gh.fetchImpl);
    const { client, calls } = stubClient([PICK, POINT]);
    const signal = new AbortController().signal;

    await exploreRepository(input({ client, signal }));

    expect(calls).toHaveLength(2);
    for (const call of calls) expect(call.options.signal).toBe(signal);
  });

  it('does nothing once the signal has already aborted', async () => {
    const gh = githubStub('landing-page');
    vi.stubGlobal('fetch', gh.fetchImpl);
    const { client, create } = stubClient([PICK, POINT]);
    const controller = new AbortController();
    controller.abort();

    await expect(
      exploreRepository(input({ client, signal: controller.signal }))
    ).rejects.toBeInstanceOf(ExplorationStoppedError);
    expect(gh.requested).toEqual([]);
    expect(create).not.toHaveBeenCalled();
  });

  it('stops while the file picker is thinking, and reads no file', async () => {
    const gh = githubStub('landing-page');
    vi.stubGlobal('fetch', gh.fetchImpl);
    const controller = new AbortController();
    const create = vi.fn(
      () => new Promise(() => {}) // never answers; only the abort ends the wait
    );
    const client = { messages: { create } } as unknown as Anthropic;
    const onFileRead = vi.fn();

    const run = exploreRepository(input({ client, signal: controller.signal, onFileRead }));
    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    controller.abort();

    await expect(run).rejects.toBeInstanceOf(ExplorationStoppedError);
    expect(onFileRead).not.toHaveBeenCalled();
    expect(gh.requested.filter(url => url.includes('/contents/'))).toEqual([]);
  });

  it('surfaces a GitHub refusal as an error carrying its status for the diagnostic', async () => {
    vi.stubGlobal('fetch', githubStub('landing-page', { treeStatus: 401 }).fetchImpl);
    const { client } = stubClient([PICK, POINT]);

    const error = await exploreRepository(input({ client })).catch(e => e);
    expect(error).toBeInstanceOf(Error);
    expect(providerStatus(error)).toBe(401);
  });
});

describe('exploration helpers', () => {
  const excerpts = [
    { path: 'css/style.css', startLine: 11, endLine: 15, wholeFile: false, why: 'grid' },
    { path: 'css/style.css', startLine: 1, endLine: 5, wholeFile: false, why: '' },
    { path: 'index.html', startLine: 1, endLine: 23, wholeFile: true, why: 'markup' },
  ];

  it('summarizes excerpts one line per file', () => {
    expect(excerptSummaryLines(excerpts)).toEqual([
      'css/style.css: lines 11–15: grid; lines 1–5',
      'index.html: whole file: markup',
    ]);
  });

  it('tells the model when an exploration found no code', () => {
    const empty = {
      format: 'excerpts-v1' as const,
      excerptText: '',
      excerpts: [],
      overview: null,
      findings: '{}',
      filesRead: ['a.js'],
      focusArea: 'x',
      fileCount: 1,
    };
    expect(formatExcerptResult(empty, 'forms')).toMatch(
      /found no code to show \(files read: a\.js\)/
    );
  });

  it('tells the model a fixed line about a failed exploration: no provider wording, no status', () => {
    expect(EXPLORATION_FAILED_TEXT).toMatch(/^The student's code could not be read right now\./);
    expect(EXPLORATION_FAILED_TEXT).not.toMatch(
      /\d|github|token|access|error|status|installation/i
    );
    expect(EXPLORATION_FAILED_TEXT).toContain('at most once more');
  });

  it('reads a provider status from the error, never other message text', () => {
    expect(providerStatus(new Error('Failed to retrieve GitHub installation token (422)'))).toBe(
      422
    );
    expect(providerStatus(Object.assign(new Error('x'), { status: 503 }))).toBe(503);
    expect(providerStatus(new Error('socket hang up'))).toBeUndefined();
    expect(providerStatus('not an error')).toBeUndefined();
  });

  it('untilAborted rejects on abort and ignores the late result', async () => {
    const controller = new AbortController();
    let settle!: (v: string) => void;
    const pending = untilAborted(new Promise<string>(r => (settle = r)), controller.signal);
    controller.abort();
    settle('late');
    await expect(pending).rejects.toBeInstanceOf(ExplorationStoppedError);
  });
});
