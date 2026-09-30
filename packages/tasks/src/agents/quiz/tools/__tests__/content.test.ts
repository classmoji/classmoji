/**
 * content_get and content_search against a stubbed Classmoji MCP server.
 *
 * Most tests inject the MCP client (`connectMcp`) and the bearer mint; one
 * group runs the real `@ai-sdk/mcp` client over a stubbed `fetch` that speaks
 * the server's stateless Streamable HTTP, so the wire request (bearer header,
 * JSON-RPC `tools/call` and its arguments) is checked too. Nothing touches
 * the database or the network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolSet } from 'ai';
import { projectMessage, quizVisibility, type QuizUIMessage } from '@classmoji/utils/quiz-agent';
import { createToolQueue } from '../../../shared/toolQueue.ts';
import type { AttemptContext, ContentScope } from '../../context.ts';

vi.mock('@trigger.dev/sdk/v3', () => ({
  task: (config: unknown) => config,
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), log: vi.fn() },
  metadata: { set: vi.fn(), append: vi.fn(), flush: vi.fn() },
}));

const { quizTools } = await import('../index.ts');
const {
  CONTENT_FAILED_TEXT,
  CONTENT_GET_MAX_CHARS,
  CONTENT_LIMIT_TEXT,
  CONTENT_NOT_FOUND_TEXT,
  CONTENT_NOT_LINKED_TEXT,
  CONTENT_STEP_FALLBACK_TITLE,
  LINKED_SEARCH_LIMIT,
  MAX_LOOKUPS_PER_TURN,
  SEARCH_RESULT_LIMIT,
  SEARCH_UNAVAILABLE_TEXT,
  UNLISTED_DOC_ID,
  connectMcp,
  readMcpResult,
} = await import('../content.ts');
const { buildMaterialPrompt } = await import('../../prompt/material.ts');
const { contentScopeFor } = await import('../../context.ts');

const TOKEN = 'mcp-bearer-for-this-user';
const REF = 'sample-org/sample-class';
const QUERY = 'what does the nav element mark up';

const LINKED = [
  { kind: 'page', id: 'page-linked', title: 'Semantic HTML' },
  { kind: 'slide', id: 'deck-linked', title: 'Flexbox deck' },
];

function scope(over: Partial<ContentScope> = {}): ContentScope {
  return {
    mcpUrl: 'https://mcp.example.test/mcp',
    classroomRef: REF,
    courseSearchEnabled: false,
    docs: LINKED,
    ...over,
  };
}

function context(content: ContentScope | null = scope()): AttemptContext {
  return {
    attemptId: 'attempt-1',
    userId: 'user-student-1',
    classroomId: 'class-1',
    quizId: 'quiz-1',
    questionCount: 5,
    isCodeAware: false,
    fence: 'fence-1',
    inputMessageId: 'msg-1',
    runId: 'run_1',
    model: 'claude-sonnet-5',
    questionEffort: 'medium',
    gradingEffort: 'medium',
    apiKey: 'key',
    keySource: 'platform',
    exploration: null,
    prompt: { staticPrompt: 's', dynamicPrompt: 'd' },
    progress: {
      questionCount: 5,
      presented: 0,
      finalized: [],
      completed: false,
      hasEvaluation: false,
    },
    content,
  } as AttemptContext;
}

/** An MCP tool result as the server writes one: a JSON text block, or an error. */
const ok = (payload: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(payload) }] });
const refused = (kind: string, message = 'Content not found in this classroom') => ({
  isError: true,
  content: [{ type: 'text', text: JSON.stringify({ error: kind, message }) }],
});

const doc = (kind: string, id: string, title: string, text: string) =>
  ok({ kind, id, title, source_path: `${id}/content.json`, indexed: true, chunk_count: 1, text });

type Handler = (name: string, args: Record<string, unknown>) => unknown;

/** A stub MCP client per call, recording what each call sent. */
function stubMcp(handler: Handler) {
  const calls: Array<{ name: string; args: Record<string, unknown>; token: string; url: string }> =
    [];
  const closed = { count: 0 };
  const connect = vi.fn(async ({ url, token }: { url: string; token: string }) => ({
    callTool: async ({
      name,
      arguments: args = {},
    }: {
      name: string;
      arguments?: Record<string, unknown>;
    }) => {
      calls.push({ name, args, token, url });
      return handler(name, args);
    },
    close: async () => {
      closed.count += 1;
    },
  }));
  return { calls, closed, connect };
}

function setup(
  o: { content?: ContentScope | null; handler?: Handler; mint?: () => Promise<string> } = {}
) {
  const writes: Array<Record<string, unknown>> = [];
  const log = vi.fn();
  const mcp = stubMcp(o.handler ?? (() => ok({})));
  const mintMcpToken = vi.fn(o.mint ?? (async () => TOKEN));
  const tools = quizTools(context(o.content === undefined ? scope() : o.content), {
    writer: {
      write: (c: Record<string, unknown>) => writes.push(c),
      merge: vi.fn(),
      onError: undefined,
    } as never,
    queue: createToolQueue(),
    signal: new AbortController().signal,
    services: { grading: {}, mintMcpToken, connectMcp: mcp.connect } as never,
    log,
    wordsWritten: () => 40,
  });
  const steps = () => writes.filter(w => w.type === 'data-step').map(w => w.data);
  return { tools, writes, steps, log, mcp, mintMcpToken };
}

const call = (tools: ToolSet, name: string, input: unknown, abortSignal?: AbortSignal) => {
  const execute = tools[name]?.execute;
  if (!execute) throw new Error(`${name} has no execute`);
  return execute(
    input as never,
    {
      toolCallId: `call-${name}`,
      messages: [],
      abortSignal,
      context: undefined,
    } as never
  ) as Promise<string>;
};

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ─── Which attempts have the tools ────────────────────────────────────────────

describe('contentScopeFor: when an attempt has the content tools', () => {
  const base = { mcpBaseUrl: 'https://mcp.example.test/', classroomRef: REF, docs: LINKED };

  it('needs linked material or course search, a classroom and the MCP server', () => {
    expect(contentScopeFor({ ...base, courseSearchEnabled: false })?.mcpUrl).toBe(
      'https://mcp.example.test/mcp'
    );
    expect(contentScopeFor({ ...base, docs: [], courseSearchEnabled: true })).not.toBeNull();
    expect(contentScopeFor({ ...base, docs: [], courseSearchEnabled: false })).toBeNull();
    expect(contentScopeFor({ ...base, classroomRef: null, courseSearchEnabled: true })).toBeNull();
    expect(
      contentScopeFor({ ...base, mcpBaseUrl: undefined, courseSearchEnabled: true })
    ).toBeNull();
    expect(contentScopeFor({ ...base, mcpBaseUrl: '  ', courseSearchEnabled: true })).toBeNull();
  });

  it('registers no content tool for an attempt without them', () => {
    const { tools } = setup({ content: null });
    expect(tools.content_get).toBeUndefined();
    expect(tools.content_search).toBeUndefined();
  });
});

// ─── Scope: linked documents only ──────────────────────────────────────────────

describe('without course search: the linked documents only', () => {
  it("reads a linked document as the attempt's user, naming this classroom", async () => {
    const { tools, mcp, mintMcpToken, steps } = setup({
      handler: (_name, args) =>
        doc('page', String(args.id), 'Semantic HTML', 'The nav element marks up navigation.'),
    });

    const out = await call(tools, 'content_get', { kind: 'page', id: 'page-linked' });

    expect(out).toBe(
      '=== page: "Semantic HTML" (id: page-linked) ===\nThe nav element marks up navigation.'
    );
    expect(mintMcpToken).toHaveBeenCalledWith('user-student-1');
    expect(mcp.calls).toEqual([
      {
        name: 'content_get',
        args: { classroom: REF, kind: 'page', id: 'page-linked' },
        token: TOKEN,
        url: 'https://mcp.example.test/mcp',
      },
    ]);
    expect(mcp.closed.count).toBe(1);
    // Named by the material as the call starts.
    expect(steps()).toEqual([{ kind: 'course_material', title: 'Semantic HTML' }]);
  });

  it('refuses a document that is not linked before any call, and shows nothing', async () => {
    const { tools, mcp, mintMcpToken, steps } = setup();

    await expect(call(tools, 'content_get', { kind: 'page', id: 'page-other' })).rejects.toThrow(
      CONTENT_NOT_LINKED_TEXT
    );
    // A linked id under the wrong kind is not the linked document.
    await expect(call(tools, 'content_get', { kind: 'slide', id: 'page-linked' })).rejects.toThrow(
      CONTENT_NOT_LINKED_TEXT
    );
    expect(mcp.connect).not.toHaveBeenCalled();
    expect(mintMcpToken).not.toHaveBeenCalled();
    expect(steps()).toEqual([]);
  });

  it('never lets the input name another classroom', async () => {
    const { tools, mcp } = setup({
      handler: (_n, args) => doc('page', String(args.id), 'Semantic HTML', 'text'),
    });
    await call(tools, 'content_get', { kind: 'page', id: 'page-linked', classroom: 'other/class' });
    await call(tools, 'content_search', { query: QUERY, classroom: 'other/class' });
    expect(mcp.calls.map(c => c.args.classroom)).toEqual([REF, REF]);
  });

  it('searches, keeping only hits among the linked documents', async () => {
    const hits = [
      {
        kind: 'page',
        id: 'page-unlinked',
        title: 'Other page',
        snippet: 'unlinked text',
        score: 0.9,
      },
      {
        kind: 'page',
        id: 'page-linked',
        title: 'Semantic HTML',
        snippet: 'The nav element',
        score: 0.8,
      },
      { kind: 'file', id: 'bot-context/notes.md', title: 'Notes', snippet: 'notes', score: 0.7 },
      { kind: 'slide', id: 'deck-linked', title: 'Flexbox deck', snippet: 'Flex rows', score: 0.6 },
    ];
    const { tools, mcp, steps } = setup({ handler: () => ok({ count: hits.length, hits }) });

    const out = await call(tools, 'content_search', { query: QUERY });

    expect(mcp.calls[0]).toMatchObject({
      name: 'content_search',
      args: { classroom: REF, query: QUERY, scope: 'course', limit: LINKED_SEARCH_LIMIT },
    });
    expect(out).toContain('page: "Semantic HTML" (id: page-linked)');
    expect(out).toContain('slide: "Flexbox deck" (id: deck-linked)');
    expect(out).not.toContain('page-unlinked');
    expect(out).not.toContain('bot-context');
    expect(out).toMatch(/^2 matches/);
    // A search shows the fixed label only: no title, no query.
    expect(steps()).toEqual([{ kind: 'course_material' }]);
  });
});

// ─── Scope: whole-course search ────────────────────────────────────────────────

describe('with course search: any document the user may see', () => {
  const courseWide = scope({ courseSearchEnabled: true });

  it('opens a search hit, titled from what the server returned', async () => {
    const { tools, mcp, steps } = setup({
      content: courseWide,
      handler: (_n, args) => doc('file', String(args.id), 'Office hours', 'Tuesdays at 3.'),
    });

    const out = await call(tools, 'content_get', { kind: 'file', id: 'bot-context/hours.md' });

    expect(out).toContain('Tuesdays at 3.');
    expect(mcp.calls[0].args).toEqual({ classroom: REF, kind: 'file', id: 'bot-context/hours.md' });
    expect(steps()).toEqual([{ kind: 'course_material', title: 'Office hours' }]);
  });

  it('searches the whole course with the default result count', async () => {
    const hits = Array.from({ length: 5 }, (_, i) => ({
      kind: 'page',
      id: `page-${i}`,
      title: `Page ${i}`,
      snippet: `snippet ${i}`,
    }));
    const { tools, mcp } = setup({ content: courseWide, handler: () => ok({ count: 5, hits }) });

    const out = await call(tools, 'content_search', { query: QUERY });

    expect(mcp.calls[0].args.limit).toBe(SEARCH_RESULT_LIMIT);
    expect(out).toMatch(/^5 matches/);
    expect(out).toContain('page: "Page 4" (id: page-4)');
  });

  it('refuses what the user may not see (a draft or unpublished id) and shows nothing', async () => {
    const { tools, steps, log } = setup({
      content: courseWide,
      handler: () => refused('not_found'),
    });

    await expect(call(tools, 'content_get', { kind: 'page', id: 'page-draft' })).rejects.toThrow(
      CONTENT_NOT_FOUND_TEXT
    );
    expect(steps()).toEqual([]);
    expect(log).toHaveBeenCalledWith(
      '[quiz-agent] content_get',
      expect.objectContaining({ outcome: 'not_found', linked: 0 })
    );
  });

  it('says a search that could not run is not an empty result', async () => {
    const { tools } = setup({
      content: courseWide,
      handler: () => ok({ count: 0, hits: [], unavailable: 'embedding_failed', message: 'x' }),
    });
    await expect(call(tools, 'content_search', { query: QUERY })).resolves.toBe(
      SEARCH_UNAVAILABLE_TEXT
    );
  });

  it('falls back to a fixed title when the served document has none', async () => {
    const { tools, steps } = setup({
      content: courseWide,
      handler: (_n, args) => doc('page', String(args.id), '', 'text'),
    });
    await call(tools, 'content_get', { kind: 'page', id: 'page-untitled' });
    expect(steps()).toEqual([{ kind: 'course_material', title: CONTENT_STEP_FALLBACK_TITLE }]);
  });
});

// ─── Truncation re-fetch ───────────────────────────────────────────────────────

describe('re-reading a document cut in the prompt', () => {
  const PER_DOC_LIMIT = 60_000; // the loader's MAX_CHARS_PER_DOC
  const full = `${'Intro paragraph. '.repeat(4_000)}\n\nThe tail says: grid areas name regions.`;

  it('returns the text the SOURCE MATERIAL block had to cut', async () => {
    const promptText = `${full.slice(0, PER_DOC_LIMIT)}\n\n[… ${(full.length - PER_DOC_LIMIT).toLocaleString('en-US')} of ${full.length.toLocaleString('en-US')} characters omitted]`;
    const prompt = buildMaterialPrompt({
      sourceMaterial: [
        { kind: 'page', id: 'page-linked', title: 'Semantic HTML', text: promptText },
      ],
      classroomRef: REF,
      courseSearchEnabled: false,
      contentToolsAvailable: true,
      isCodeAware: false,
    });
    expect(prompt).toContain('content_get(kind, id) returns the whole of a document listed below');
    expect(prompt).not.toContain('grid areas name regions');

    const { tools } = setup({
      handler: (_n, args) => doc('page', String(args.id), 'Semantic HTML', full),
    });
    const out = await call(tools, 'content_get', { kind: 'page', id: 'page-linked' });

    expect(out.length).toBeGreaterThan(promptText.length);
    expect(out).toContain('The tail says: grid areas name regions.');
    expect(out).not.toContain('characters omitted');
  });

  it('caps a document longer than the ceiling, with the marker line', async () => {
    const huge = 'x'.repeat(CONTENT_GET_MAX_CHARS + 5_000);
    const { tools, log } = setup({
      handler: (_n, args) => doc('page', String(args.id), 'Semantic HTML', huge),
    });
    const out = await call(tools, 'content_get', { kind: 'page', id: 'page-linked' });

    expect(out).toContain('[… 5,000 of 105,000 characters omitted]');
    expect(out.length).toBeLessThan(CONTENT_GET_MAX_CHARS + 200);
    expect(log).toHaveBeenCalledWith(
      '[quiz-agent] content_get',
      expect.objectContaining({ chars: huge.length, cut: 1 })
    );
  });
});

// ─── Failures, the bearer and the logs ────────────────────────────────────────

describe('failures, the bearer and the logs', () => {
  it('mints one bearer per turn and tries again after a failed mint', async () => {
    let n = 0;
    const { tools, mintMcpToken } = setup({
      mint: async () => {
        n += 1;
        if (n === 1) throw new Error('database unavailable');
        return TOKEN;
      },
      handler: (_n, args) => doc(String(args.kind), String(args.id), 'Semantic HTML', 'text'),
    });

    await expect(call(tools, 'content_get', { kind: 'page', id: 'page-linked' })).rejects.toThrow(
      CONTENT_FAILED_TEXT
    );
    await call(tools, 'content_get', { kind: 'page', id: 'page-linked' });
    await call(tools, 'content_get', { kind: 'slide', id: 'deck-linked' });
    expect(mintMcpToken).toHaveBeenCalledTimes(2);
  });

  it('turns a transport failure into fixed text', async () => {
    const { tools } = setup({
      handler: () => {
        throw Object.assign(new Error('MCP HTTP Transport Error: 502 with a body'), {
          statusCode: 502,
        });
      },
    });
    await expect(call(tools, 'content_search', { query: QUERY })).rejects.toThrow(
      CONTENT_FAILED_TEXT
    );
  });

  it('logs ids and counts only: never the query, the text or the bearer', async () => {
    const { tools, log } = setup({
      content: scope({ courseSearchEnabled: true }),
      handler: (name, args) =>
        name === 'content_get'
          ? doc('page', String(args.id), 'Semantic HTML', 'SECRET DOCUMENT TEXT')
          : ok({
              count: 1,
              hits: [{ kind: 'page', id: 'p', title: 'T', snippet: 'SNIPPET TEXT' }],
            }),
    });
    await call(tools, 'content_get', { kind: 'page', id: 'page-linked' });
    await call(tools, 'content_search', { query: QUERY });

    const logged = JSON.stringify(log.mock.calls);
    expect(logged).not.toContain(QUERY);
    expect(logged).not.toContain('SECRET DOCUMENT TEXT');
    expect(logged).not.toContain('SNIPPET TEXT');
    expect(logged).not.toContain(TOKEN);
    expect(log).toHaveBeenCalledWith(
      '[quiz-agent] content_search',
      expect.objectContaining({ queryChars: QUERY.length, hits: 1, kept: 1, scope: 'course' })
    );
  });

  it('logs a document id only when it is linked or UUID-shaped', async () => {
    const UUID = '0b6f5a4e-3c1d-4e2f-9a8b-7c6d5e4f3a2b';
    const ODD_ID = 'a free-text id the model wrote';
    const { tools, log } = setup({
      content: scope({ courseSearchEnabled: true }),
      handler: (_n, args) => doc('page', String(args.id), 'A page', 'text'),
    });
    await call(tools, 'content_get', { kind: 'page', id: 'page-linked' });
    await call(tools, 'content_get', { kind: 'page', id: UUID });
    await call(tools, 'content_get', { kind: 'page', id: ODD_ID });

    const lines = log.mock.calls
      .filter(([line]) => line === '[quiz-agent] content_get')
      .map(([, fields]) => (fields as { docId?: string; linked: number }).docId);
    expect(lines).toEqual(['page-linked', UUID, UNLISTED_DOC_ID]);
    expect(JSON.stringify(log.mock.calls)).not.toContain(ODD_ID);
  });

  it('logs the fixed marker for an id the server did not find', async () => {
    const ODD_ID = 'not-a-classmoji-id';
    const { tools, log } = setup({
      content: scope({ courseSearchEnabled: true }),
      handler: () => refused('not_found'),
    });
    await expect(call(tools, 'content_get', { kind: 'slide', id: ODD_ID })).rejects.toThrow(
      CONTENT_NOT_FOUND_TEXT
    );
    expect(log).toHaveBeenCalledWith(
      '[quiz-agent] content_get',
      expect.objectContaining({ docId: UNLISTED_DOC_ID, outcome: 'not_found', linked: 0 })
    );
    expect(JSON.stringify(log.mock.calls)).not.toContain(ODD_ID);
  });

  it('reads error kinds and payloads from MCP results', () => {
    expect(readMcpResult(refused('forbidden'))).toEqual({ ok: false, kind: 'forbidden' });
    expect(readMcpResult({ content: [{ type: 'text', text: 'not json' }] })).toEqual({
      ok: false,
      kind: 'invalid_result',
    });
    expect(readMcpResult(ok({ a: 1 }))).toEqual({ ok: true, payload: { a: 1 } });
  });
});

// ─── Lookups per turn ──────────────────────────────────────────────────────────

describe('lookups per turn', () => {
  const answer: Handler = (name, args) =>
    name === 'content_get'
      ? doc(String(args.kind), String(args.id), 'Semantic HTML', 'text')
      : ok({ count: 0, hits: [] });

  it('takes three lookups in a turn, reads and searches together, then refuses with fixed text', async () => {
    expect(MAX_LOOKUPS_PER_TURN).toBe(3);
    const { tools, mcp, log, steps } = setup({ handler: answer });
    await call(tools, 'content_get', { kind: 'page', id: 'page-linked' });
    await call(tools, 'content_search', { query: QUERY });
    await call(tools, 'content_get', { kind: 'slide', id: 'deck-linked' });
    const shown = steps().length;

    await expect(call(tools, 'content_get', { kind: 'page', id: 'page-linked' })).rejects.toThrow(
      CONTENT_LIMIT_TEXT
    );
    await expect(call(tools, 'content_search', { query: QUERY })).rejects.toThrow(
      CONTENT_LIMIT_TEXT
    );
    expect(CONTENT_LIMIT_TEXT).toBe(
      'You have looked up enough course material this turn. Continue with what you have.'
    );
    // The refused calls read nothing and show nothing.
    expect(mcp.calls).toHaveLength(3);
    expect(steps()).toHaveLength(shown);
    expect(log).toHaveBeenCalledWith('[quiz-agent] content lookup refused', {
      attemptId: 'attempt-1',
      runId: 'run_1',
      reason: 'turn_limit',
    });
  });

  it('counts a lookup that failed', async () => {
    const { tools, mcp } = setup({
      handler: () => {
        throw new Error('MCP HTTP Transport Error: 502');
      },
    });
    for (let i = 0; i < MAX_LOOKUPS_PER_TURN; i++) {
      await expect(call(tools, 'content_search', { query: QUERY })).rejects.toThrow(
        CONTENT_FAILED_TEXT
      );
    }
    await expect(call(tools, 'content_search', { query: QUERY })).rejects.toThrow(
      CONTENT_LIMIT_TEXT
    );
    expect(mcp.calls).toHaveLength(MAX_LOOKUPS_PER_TURN);
  });

  it('does not count a document refused as not linked', async () => {
    const { tools, mcp } = setup({ handler: answer });
    await expect(call(tools, 'content_get', { kind: 'page', id: 'page-other' })).rejects.toThrow(
      CONTENT_NOT_LINKED_TEXT
    );
    for (let i = 0; i < MAX_LOOKUPS_PER_TURN; i++) {
      await call(tools, 'content_get', { kind: 'page', id: 'page-linked' });
    }
    expect(mcp.calls).toHaveLength(MAX_LOOKUPS_PER_TURN);
  });

  it('bounds the lookups of one step, which start together', async () => {
    const { tools, mcp } = setup({ handler: answer });
    const results = await Promise.allSettled(
      Array.from({ length: MAX_LOOKUPS_PER_TURN + 2 }, () =>
        call(tools, 'content_search', { query: QUERY })
      )
    );
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(MAX_LOOKUPS_PER_TURN);
    expect(
      results
        .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
        .map(r => (r.reason as Error).message)
    ).toEqual([CONTENT_LIMIT_TEXT, CONTENT_LIMIT_TEXT]);
    expect(mcp.calls).toHaveLength(MAX_LOOKUPS_PER_TURN);
  });

  it("starts afresh with the next turn's tool set", async () => {
    const first = setup({ handler: answer });
    for (let i = 0; i < MAX_LOOKUPS_PER_TURN; i++) {
      await call(first.tools, 'content_search', { query: QUERY });
    }
    const next = setup({ handler: answer });
    await expect(call(next.tools, 'content_search', { query: QUERY })).resolves.toBeTypeOf(
      'string'
    );
  });
});

// ─── What reaches the browser ──────────────────────────────────────────────────

describe('what the browser receives', () => {
  it('keeps the titles of the steps and drops the tool parts', async () => {
    const long = 'T'.repeat(500);
    const { tools, writes } = setup({
      content: scope({ courseSearchEnabled: true }),
      handler: (name, args) =>
        name === 'content_get'
          ? doc('page', String(args.id), long, 'DOCUMENT TEXT')
          : ok({ count: 0, hits: [] }),
    });
    await call(tools, 'content_get', { kind: 'page', id: 'page-9' });
    await call(tools, 'content_search', { query: QUERY });

    const message = {
      id: 'm1',
      role: 'assistant',
      parts: [
        ...writes.map(w => ({ type: w.type, data: w.data })),
        {
          type: 'tool-content_get',
          toolCallId: 'c1',
          state: 'output-available',
          input: { kind: 'page', id: 'page-9' },
          output: 'DOCUMENT TEXT',
        },
        {
          type: 'tool-content_search',
          toolCallId: 'c2',
          state: 'output-available',
          input: { query: QUERY },
          output: 'no matches',
        },
      ],
    } as unknown as QuizUIMessage;
    const projected = projectMessage(message, quizVisibility);
    const sent = JSON.stringify(projected);

    expect(projected?.parts).toEqual([
      { type: 'data-step', data: { kind: 'course_material', title: 'T'.repeat(200) } },
      { type: 'data-step', data: { kind: 'course_material' } },
    ]);
    expect(sent).not.toContain(QUERY);
    expect(sent).not.toContain('page-9');
    expect(sent).not.toContain('DOCUMENT TEXT');
  });
});

// ─── The real MCP client over a stubbed server ────────────────────────────────

describe('connectMcp: the real client against a stubbed MCP endpoint', () => {
  it('sends the bearer and a tools/call with the arguments, over stateless HTTP', async () => {
    const requests: Array<{
      method: string;
      auth: string | null;
      version: string | null;
      body: unknown;
    }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit = {}) => {
        const headers = new Headers(init.headers);
        const method = init.method ?? 'GET';
        const body = typeof init.body === 'string' ? JSON.parse(init.body) : null;
        requests.push({
          method,
          auth: headers.get('authorization'),
          version: headers.get('mcp-protocol-version'),
          body,
        });
        if (method !== 'POST') return new Response(null, { status: 405 });
        if (!('id' in body)) return new Response(null, { status: 202 });
        const json = (result: unknown) =>
          new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        if (body.method === 'initialize') {
          return json({
            // An older version than the client asked for: it must carry this one after.
            protocolVersion: '2025-06-18',
            capabilities: { tools: {} },
            serverInfo: { name: 'classmoji-stub', version: '1.0.0' },
          });
        }
        if (body.method === 'tools/call') {
          return json(doc('page', body.params.arguments.id, 'Semantic HTML', 'Served over HTTP.'));
        }
        return new Response(null, { status: 400 });
      })
    );

    const writes: unknown[] = [];
    const tools = quizTools(context(), {
      writer: {
        write: (c: unknown) => writes.push(c),
        merge: vi.fn(),
        onError: undefined,
      } as never,
      queue: createToolQueue(),
      signal: new AbortController().signal,
      services: { grading: {}, mintMcpToken: async () => TOKEN, connectMcp } as never,
      log: vi.fn(),
      wordsWritten: () => 40,
    });

    const out = await call(tools, 'content_get', { kind: 'page', id: 'page-linked' });

    expect(out).toContain('Served over HTTP.');
    const posts = requests.filter(r => r.method === 'POST');
    expect(posts.map(r => (r.body as { method: string }).method)).toEqual([
      'initialize',
      'notifications/initialized',
      'tools/call',
    ]);
    expect(requests.every(r => r.auth === `Bearer ${TOKEN}`)).toBe(true);
    expect(posts[2].version).toBe('2025-06-18');
    expect((posts[2].body as { params: unknown }).params).toEqual({
      name: 'content_get',
      arguments: { classroom: REF, kind: 'page', id: 'page-linked' },
    });
  });
});
