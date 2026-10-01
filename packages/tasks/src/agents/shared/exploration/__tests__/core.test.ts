/**
 * The in-process exploration on a fixture repository: GitHub is a stub served
 * from `quiz/__fixtures__/repos/`, the Anthropic client is a stub, and
 * `@trigger.dev/sdk/v3` is mocked. Nothing reaches the network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { githubStub, SECONDARY_RATE_LIMIT_BODY } from '../../../quiz/__fixtures__/githubStub.ts';

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
  isGithubRateLimited,
  providerStatus,
  RATE_LIMIT_BACKOFF_MS,
  rateLimitWaitMs,
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

  it('hands over the content of each file read, and none for a failed read', async () => {
    const gh = githubStub('landing-page', { failPaths: ['index.html'] });
    vi.stubGlobal('fetch', gh.fetchImpl);
    const { client } = stubClient([PICK, POINT]);
    const onFileContent = vi.fn();

    await exploreRepository(input({ client, onFileContent }));

    expect(onFileContent.mock.calls.map(([path]) => path)).toEqual(['css/style.css']);
    expect(onFileContent.mock.calls[0][1]).toMatch(/^\.hero \{\n {2}display: flex;/);
  });

  it('keeps exploring when keeping a copy of a file fails', async () => {
    vi.stubGlobal('fetch', githubStub('landing-page').fetchImpl);
    const { client } = stubClient([PICK, POINT]);
    const result = await exploreRepository(
      input({
        client,
        onFileContent: () => {
          throw new Error('cache full');
        },
      })
    );
    expect(result.excerpts).toHaveLength(2);
  });

  it('gives the model every excerpt line with its line number in the file', async () => {
    vi.stubGlobal('fetch', githubStub('landing-page').fetchImpl);
    const { client } = stubClient([PICK, POINT]);
    const result = await exploreRepository(input({ client }));
    const said = formatExcerptResult(result, FOCUS);

    // The excerpt body reaches the model byte for byte, numbered by file line.
    expect(said.endsWith(result.excerptText)).toBe(true);
    expect(said).toContain(
      [
        '11| .features {',
        '12|   display: grid;',
        '13|   grid-template-columns: repeat(2, 1fr);',
        '14|   gap: 1rem;',
        '15| }',
      ].join('\n')
    );
    expect(said).toMatch(/each line starts with its line number in the file \("N\| "\)/);
    expect(said).toMatch(/Cite code by these line numbers\./);
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

describe('exploreRepository under a GitHub rate limit', () => {
  const fast = [
    [1, 1],
    [1, 1],
  ] as const;
  const count = (gh: { requested: string[] }, part: string) =>
    gh.requested.filter(url => url.includes(part)).length;

  it('reads the tree again after a rate limit and carries on', async () => {
    const gh = githubStub('landing-page', { limited: { tree: 2 } });
    vi.stubGlobal('fetch', gh.fetchImpl);
    const { client } = stubClient([PICK, POINT]);

    const result = await exploreRepository(input({ client, rateLimitBackoffMs: fast }));

    expect(count(gh, '/git/trees/')).toBe(3);
    expect(result.excerpts.map(e => e.path)).toEqual(['css/style.css', 'index.html']);
  });

  it('gives up on the tree after two retries, with the status for the diagnostic', async () => {
    const gh = githubStub('landing-page', { limited: { tree: 5 } });
    vi.stubGlobal('fetch', gh.fetchImpl);
    const { client, create } = stubClient([PICK, POINT]);

    const error = await exploreRepository(input({ client, rateLimitBackoffMs: fast })).catch(
      e => e
    );
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(ExplorationStoppedError);
    expect(providerStatus(error)).toBe(403);
    expect(count(gh, '/git/trees/')).toBe(3);
    expect(create).not.toHaveBeenCalled();
  });

  it('does not retry a 403 that is not a rate limit', async () => {
    const gh = githubStub('landing-page', {
      limited: { tree: 1 },
      limitBody: '{"message":"Resource not accessible by integration"}',
    });
    vi.stubGlobal('fetch', gh.fetchImpl);
    const { client } = stubClient([PICK, POINT]);

    const error = await exploreRepository(input({ client, rateLimitBackoffMs: fast })).catch(
      e => e
    );
    expect(providerStatus(error)).toBe(403);
    expect(count(gh, '/git/trees/')).toBe(1);
  });

  it('reads again only the files that hit a rate limit, reporting each file once', async () => {
    const gh = githubStub('landing-page', { limited: { paths: { 'index.html': 2 } } });
    vi.stubGlobal('fetch', gh.fetchImpl);
    const { client } = stubClient([PICK, POINT]);
    const onFileRead = vi.fn();

    const result = await exploreRepository(input({ client, onFileRead, rateLimitBackoffMs: fast }));

    expect(onFileRead.mock.calls).toEqual([['index.html'], ['css/style.css']]);
    expect(count(gh, '/contents/index.html')).toBe(3);
    expect(count(gh, '/contents/css/style.css')).toBe(1);
    expect(result.filesRead).toEqual(['index.html', 'css/style.css']);
    expect(result.excerpts.map(e => e.path)).toContain('index.html');
  });

  it('keeps the error on a file still limited after the retries', async () => {
    const gh = githubStub('landing-page', { limited: { paths: { 'css/style.css': 9 } } });
    vi.stubGlobal('fetch', gh.fetchImpl);
    const { client } = stubClient([PICK, POINT]);
    const onFileRead = vi.fn();

    await exploreRepository(input({ client, onFileRead, rateLimitBackoffMs: fast }));

    expect(onFileRead.mock.calls).toEqual([['index.html'], ['css/style.css', { error: true }]]);
    expect(count(gh, '/contents/css/style.css')).toBe(3);
    expect(count(gh, '/contents/index.html')).toBe(1);
  });

  it('stops during the pause when the turn ends, and reads nothing more', async () => {
    const gh = githubStub('landing-page', { limited: { tree: 1 } });
    vi.stubGlobal('fetch', gh.fetchImpl);
    const { client, create } = stubClient([PICK, POINT]);
    const controller = new AbortController();

    const run = exploreRepository(
      input({ client, signal: controller.signal, rateLimitBackoffMs: [[60_000, 60_000]] })
    );
    await vi.waitFor(() => expect(count(gh, '/git/trees/')).toBe(1));
    controller.abort();

    await expect(run).rejects.toBeInstanceOf(ExplorationStoppedError);
    await new Promise(r => setTimeout(r, 20));
    expect(gh.requested).toHaveLength(1);
    expect(create).not.toHaveBeenCalled();
  });

  it('logs each retry with ids and counts only', async () => {
    const gh = githubStub('landing-page', {
      limited: { tree: 1, paths: { 'index.html': 1, 'css/style.css': 1 } },
    });
    vi.stubGlobal('fetch', gh.fetchImpl);
    const { client } = stubClient([PICK, POINT]);
    const log = vi.fn();

    await exploreRepository(
      input({
        client,
        rateLimitBackoffMs: fast,
        callLog: { log, attemptId: 'attempt-1', runId: 'run_1', keySource: 'platform' },
      })
    );

    const limited = log.mock.calls.filter(c => c[0] === '[quiz-agent] exploration rate limited');
    expect(limited.map(c => c[1])).toEqual([
      {
        attemptId: 'attempt-1',
        runId: 'run_1',
        retry: 1,
        of: 2,
        what: 'tree',
        count: 1,
        waitMs: 1,
      },
      {
        attemptId: 'attempt-1',
        runId: 'run_1',
        retry: 1,
        of: 2,
        what: 'files',
        count: 2,
        waitMs: 1,
      },
    ]);
    const logged = JSON.stringify(log.mock.calls);
    expect(logged).not.toMatch(/index\.html|style\.css|landing-page|sample-org|token-value/);
    expect(logged).not.toContain(FOCUS);
  });

  it('waits 1-3 s before the first retry and 3-6 s before the second', () => {
    expect(RATE_LIMIT_BACKOFF_MS).toEqual([
      [1_000, 3_000],
      [3_000, 6_000],
    ]);
    expect(rateLimitWaitMs(RATE_LIMIT_BACKOFF_MS[0], () => 0)).toBe(1_000);
    expect(rateLimitWaitMs(RATE_LIMIT_BACKOFF_MS[0], () => 0.999_999)).toBe(3_000);
    expect(rateLimitWaitMs(RATE_LIMIT_BACKOFF_MS[1], () => 0.5)).toBe(4_500);
  });

  it('recognises a rate limit only from a 429 or a 403 that names one', () => {
    const failed = (status: number, body: string) =>
      new Error(`GitHub contents (src/a.js) failed (${status}): ${body}`);
    expect(isGithubRateLimited(failed(403, SECONDARY_RATE_LIMIT_BODY))).toBe(true);
    expect(
      isGithubRateLimited(
        failed(403, '{"message":"API rate limit exceeded for installation ID 1."}')
      )
    ).toBe(true);
    // A 429 is a rate limit whatever its body (githubFetch has already waited
    // on it three times itself, so a stubbed 429 would take seconds here).
    expect(isGithubRateLimited(failed(429, '{}'))).toBe(true);
    expect(isGithubRateLimited(`GitHub contents (a) failed (429): {}`)).toBe(true);
    expect(
      isGithubRateLimited(failed(403, '{"message":"Resource not accessible by integration"}'))
    ).toBe(false);
    expect(isGithubRateLimited(failed(404, '{"message":"rate limit"}'))).toBe(false);
    expect(isGithubRateLimited(new Error('socket hang up'))).toBe(false);
    expect(isGithubRateLimited(undefined)).toBe(false);
  });
});

describe('exploreRepository usage lines', () => {
  it('logs one line per model call: ids, model, key source and token counts, no content', async () => {
    vi.stubGlobal('fetch', githubStub('landing-page').fetchImpl);
    const answers = [PICK, POINT];
    const create = vi.fn(async () => ({
      ...text(answers.shift() ?? ''),
      usage: {
        input_tokens: 100,
        cache_read_input_tokens: 50,
        cache_creation_input_tokens: 10,
        output_tokens: 20,
      },
    }));
    const client = { messages: { create } } as unknown as Anthropic;
    const log = vi.fn();

    await exploreRepository(
      input({
        client,
        callLog: { log, attemptId: 'attempt-1', runId: 'run_1', keySource: 'classroom' },
      })
    );

    const lines = log.mock.calls.filter(c => c[0] === '[quiz-agent] exploration call');
    expect(lines.map(c => c[1])).toEqual(
      [1, 2].map(call => ({
        attemptId: 'attempt-1',
        runId: 'run_1',
        call,
        model: 'claude-sonnet-5',
        keySource: 'classroom',
        finish: 'end_turn',
        inputTokens: 160,
        noCacheTokens: 100,
        cacheReadTokens: 50,
        cacheWriteTokens: 10,
        outputTokens: 20,
        ms: expect.any(Number),
      }))
    );
    const logged = JSON.stringify(log.mock.calls);
    expect(logged).not.toContain(FOCUS);
    expect(logged).not.toContain(QUESTION);
    expect(logged).not.toMatch(/index\.html|grid layout|token-value/);
  });

  it('logs zeros for an answer without usage, and the requested model', async () => {
    vi.stubGlobal('fetch', githubStub('landing-page').fetchImpl);
    const answers = [PICK, POINT];
    const create = vi.fn(async () => ({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: answers.shift() }],
    }));
    const log = vi.fn();

    await exploreRepository(
      input({
        client: { messages: { create } } as unknown as Anthropic,
        model: 'claude-haiku-5',
        callLog: { log, attemptId: 'attempt-1', runId: 'run_1', keySource: 'platform' },
      })
    );

    const first = log.mock.calls.find(c => c[0] === '[quiz-agent] exploration call')?.[1];
    expect(first).toMatchObject({ model: 'claude-haiku-5', inputTokens: 0, outputTokens: 0 });
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
    const said = formatExcerptResult(empty, 'forms');
    expect(said).toMatch(/found no code to show \(files read: a\.js\)/);
    // It says to carry on, never to explore somewhere else.
    expect(said).toContain('Continue with the code you have already seen');
    expect(said).not.toMatch(/explore a different|explore again|another focus/i);
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
