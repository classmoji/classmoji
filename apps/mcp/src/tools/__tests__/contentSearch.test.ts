/**
 * Unit tests for the course-content read tools (plan §5.7, P2-7).
 *
 * WHAT IS REAL HERE, AND WHY
 * --------------------------
 * `@classmoji/database` is the DMMF-validating stand-in (P2-8), and the REAL
 * `contentSearch.service` module is loaded behind the `@classmoji/services`
 * mock. So every Prisma query these tools issue — the live-fallback `findFirst`
 * included — is checked against the generated schema, and the service's raw
 * statements are built for real: the visibility parameters asserted below are
 * the ones that would reach Postgres. `$queryRaw` answers from canned rows
 * (the stub does not execute SQL), which is exactly the division of labour the
 * harness documents: schema drift is caught here, the SQL's *semantics* are
 * pinned by `tests/phase2-content.integration.test.ts` against a real database.
 *
 * NO LIVE CREDENTIALS. `embedTexts` is mocked with a deterministic vector, so
 * nothing here depends on Cloudflare being reachable or on a token being valid
 * (review finding 17) — and the "search is unavailable" paths are reachable on
 * demand rather than only when someone's credentials happen to be missing.
 *
 * Role gating itself (who may call these at all) is registry-enforced and
 * covered by the integration matrix, not here — the same division `reads.test.ts`
 * states explicitly.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Prisma } from '@prisma/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToolError } from '../../mcp/errors.ts';
import {
  buildMcpServer,
  registerToolDefinition,
  toolAnnotations,
  type ToolContext,
  type ToolDefinition,
} from '../../mcp/registry.ts';

const mocks = vi.hoisted(() => ({
  embedTexts: vi.fn(),
  isWorkersAiConfigured: vi.fn(() => true),
  fetchContentText: vi.fn(),
}));

// The schema-validating Prisma stand-in: the tools' own findFirst and the real
// service's $queryRaw both go through it.
vi.mock('@classmoji/database', async () =>
  (await import('../../__tests__/prismaSchemaStub.ts')).databaseModuleMock()
);

// Real embedding client EXCEPT the two functions that would touch the network,
// so `WorkersAiError` stays the real class an `instanceof` can match.
vi.mock('@classmoji/services/workers-ai', async importOriginal => {
  const actual =
    await importOriginal<
      typeof import('../../../../../packages/services/src/helpers/workersAi.ts')
    >();
  return {
    ...actual,
    embedTexts: (...args: unknown[]) => mocks.embedTexts(...args),
    isWorkersAiConfigured: () => mocks.isWorkersAiConfigured(),
  };
});

// The REAL contentSearch service — the whole point of this file is that the
// tools forward a role into it rather than deciding anything themselves.
vi.mock('@classmoji/services', async () => {
  const real = await vi.importActual<
    typeof import('../../../../../packages/services/src/classmoji/contentSearch.service.ts')
  >('../../../../../packages/services/src/classmoji/contentSearch.service.ts');
  // The REAL docs read service too, for the same reason: what these tests are
  // about is that the tool forwards to the right corpus and shapes the result,
  // and a hand-written `searchDocs` stub would agree with a handler that built
  // a nonsense statement.
  const docs = await vi.importActual<
    typeof import('../../../../../packages/services/src/classmoji/docsSearch.service.ts')
  >('../../../../../packages/services/src/classmoji/docsSearch.service.ts');
  return {
    ...real,
    ...docs,
    ClassmojiService: {
      contentDelivery: {
        fetchContentText: (...args: unknown[]) => mocks.fetchContentText(...args),
      },
    },
  };
});

const { contentSearchTool, contentListTool, contentGetTool } = await import('../contentSearch.ts');
const { prismaCalls, prismaCallsFor, resetPrismaStub, setPrismaRaw, setPrismaRows } =
  await import('../../__tests__/prismaSchemaStub.ts');
const { EMBEDDING_DIMENSIONS, WorkersAiError } =
  await import('../../../../../packages/services/src/helpers/workersAi.ts');
const { MAX_LIST_LIMIT, MAX_SEARCH_LIMIT } =
  await import('../../../../../packages/services/src/classmoji/contentSearch.service.ts');

// ─── Fixtures ───────────────────────────────────────────────────────────────

const CLASSROOM_ID = 'classroom-1';
const OTHER_CLASSROOM_ID = 'classroom-2';
const PAGE_ID = '11111111-1111-4111-8111-111111111111';
const DECK_ID = '22222222-2222-4222-8222-222222222222';
const BOGUS_ID = '33333333-3333-4333-8333-333333333333';

const ctxFor = (role: 'OWNER' | 'TEACHER' | 'ASSISTANT' | 'STUDENT'): ToolContext =>
  ({
    viewer: { userId: `user-${role}`, clientId: 'c', scopes: new Set(['read']) },
    classroom: {
      classroomId: CLASSROOM_ID,
      role,
      status: 'ACTIVE',
      membership: { id: 'm-1', role },
      classroom: { settings: {} },
    },
  }) as unknown as ToolContext;

const STUDENT = ctxFor('STUDENT');
const TEACHER = ctxFor('TEACHER');
const ASSISTANT = ctxFor('ASSISTANT');

/** A deterministic unit vector — never a live embedding call. */
const VECTOR = Array.from({ length: EMBEDDING_DIMENSIONS }, (_, i) => (i === 0 ? 1 : 0));

/** Every raw statement the code under test issued, as template parts. */
let rawStatements: unknown[][] = [];
/** What `$queryRaw` answers with. Set per test. */
let rawRows: unknown[] = [];

const payloadOf = (result: { content: Array<{ text: string }> }): Record<string, unknown> =>
  JSON.parse(result.content[0].text) as Record<string, unknown>;

const call = async <A>(tool: ToolDefinition<A>, args: A, ctx: ToolContext) =>
  payloadOf((await tool.handler(args, ctx)) as { content: Array<{ text: string }> });

/** The serialized shape the registry would hand a client for a refusal. */
async function refusalOf(run: () => Promise<unknown>) {
  let caught: unknown;
  try {
    await run();
  } catch (error) {
    caught = error;
  }
  expect(caught, 'expected the handler to refuse').toBeInstanceOf(ToolError);
  const error = caught as ToolError;
  return { error: error.kind, code: error.code, message: error.message, data: error.data };
}

/** The statement the code under test issued most recently. */
const lastStatement = (): unknown[] => {
  const parts = rawStatements.at(-1);
  expect(parts, 'expected a raw statement to have been issued').toBeDefined();
  return parts as unknown[];
};

/** Bound parameters of a raw statement, in order — nested fragments flattened. */
const paramsOf = (parts: unknown[]): unknown[] =>
  Prisma.sql(parts[0] as unknown as ReadonlyArray<string>, ...parts.slice(1)).values;

/** Just the visibility booleans: what the viewer's role is waived by. */
const visibilityBooleansOf = (parts: unknown[]): boolean[] =>
  paramsOf(parts).filter((value): value is boolean => typeof value === 'boolean');

const SEARCH_ROW = {
  docKind: 'page' as const,
  docId: PAGE_ID,
  chunkIx: 0,
  title: 'Assessment Schedule',
  snippet: 'The midterm is on 14 November.',
  score: 0.8123456,
  isDraft: null as boolean | null,
};

const LIST_ROW = {
  docKind: 'page' as const,
  docId: PAGE_ID,
  title: 'Assessment Schedule',
  slug: 'assessment-schedule',
  isDraft: null as boolean | null,
  updatedAt: new Date('2026-09-01T12:00:00.000Z'),
  indexed: true,
};

const GET_ROW = {
  docKind: 'page' as const,
  docId: PAGE_ID,
  title: 'Assessment Schedule',
  sourcePath: 'pages/assessment-schedule/content.json',
  text: 'Assessment Schedule\nThe midterm is on 14 November.',
  chunkCount: 2,
  isDraft: null as boolean | null,
};

/** A page row as Prisma would return it, with the content-repo chain included. */
const pageRecord = (overrides: Record<string, unknown> = {}) => ({
  id: PAGE_ID,
  classroom_id: CLASSROOM_ID,
  title: 'Unreleased Final Project',
  slug: 'unreleased-final-project',
  content_path: 'pages/unreleased-final-project',
  is_draft: true,
  is_public: false,
  classroom: {
    id: CLASSROOM_ID,
    content_key_version: 3,
    content_repo: 'content-cs52',
    content_delivery_enabled: true,
    git_organization: { login: 'classmoji-development' },
  },
  ...overrides,
});

const BLOCKNOTE_BODY = JSON.stringify({
  blocks: [
    { type: 'paragraph', content: [{ type: 'text', text: 'The capstone is a key-value store.' }] },
  ],
});

/** Every `content_search` instrumentation line this test captured. */
const searchLogLines = (): string[] => loggedLines.filter(text => text.includes('content_search'));

/** The single instrumentation line, parsed. Fails if there is not exactly one. */
const searchLog = (): Record<string, unknown> => {
  const lines = searchLogLines();
  expect(lines, 'content_search must log exactly one line per call').toHaveLength(1);
  const line = lines.join('');
  return JSON.parse(line.slice(line.indexOf('{'))) as Record<string, unknown>;
};

/** Captured `console.log` lines — the instrumentation is part of the contract. */
let loggedLines: string[] = [];

beforeEach(() => {
  resetPrismaStub();
  rawStatements = [];
  rawRows = [];
  setPrismaRaw((parts: unknown[]) => {
    rawStatements.push(parts);
    return rawRows;
  });
  mocks.embedTexts.mockReset().mockResolvedValue({ ok: true, vectors: [VECTOR] });
  mocks.isWorkersAiConfigured.mockReset().mockReturnValue(true);
  mocks.fetchContentText.mockReset().mockResolvedValue(null);
  loggedLines = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    loggedLines.push(String(args[0]));
  });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── Definition shape (what the registry enforces at startup) ───────────────

describe('tool definitions', () => {
  const tools = [contentSearchTool, contentListTool, contentGetTool];

  it('are three read-scoped, classroom-bound tools open to every member role', () => {
    expect(tools.map(t => t.name)).toEqual(['content_search', 'content_list', 'content_get']);
    for (const tool of tools) {
      expect(tool.scope, `${tool.name} scope`).toBe('read');
      // roles: null would mean "any authenticated caller, no classroom" — a
      // stranger reading a course. Non-null + a classroom argument is what
      // makes the registry resolve a membership first.
      expect(tool.roles, `${tool.name} roles`).not.toBeNull();
      expect([...(tool.roles ?? [])].sort()).toEqual(['ASSISTANT', 'OWNER', 'STUDENT', 'TEACHER']);
      expect(Object.keys(tool.inputSchema), `${tool.name} inputSchema`).toContain('classroom');
    }
  });

  it('take readOnlyHint from the scope instead of hand-setting annotations', () => {
    for (const tool of tools) {
      expect(tool.annotations, `${tool.name} must not hand-set annotations`).toBeUndefined();
      const annotations = toolAnnotations(tool as unknown as ToolDefinition<never>);
      expect(annotations.readOnlyHint, `${tool.name} readOnlyHint`).toBe(true);
      expect(annotations.openWorldHint, `${tool.name} openWorldHint`).toBe(false);
    }
  });

  it('are all three registered in the tool manifest', () => {
    const manifest = readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../index.ts'),
      'utf8'
    );
    for (const name of ['contentSearchTool', 'contentListTool', 'contentGetTool']) {
      expect(manifest).toContain(`registerToolDefinition(${name})`);
    }
  });
});

// ─── D6: the tools carry no rule of their own ───────────────────────────────

describe('the single visibility predicate (D6)', () => {
  it('is not re-implemented in the tool module', () => {
    const source = readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../contentSearch.ts'),
      'utf8'
    );
    // The rule is (NOT draft OR staff) AND (public OR member), and it is
    // written ONCE, in packages/services. A tool that named either column would
    // be a second copy of it — the exact drift this lane exists to prevent.
    expect(source).not.toContain('is_draft');
    expect(source).not.toContain('is_public');
    // Nor a hand-rolled staff tier.
    expect(source).not.toContain("'ASSISTANT'");
  });
});

// ─── content_search ─────────────────────────────────────────────────────────

describe('content_search', () => {
  it("forwards the viewer's role: a student waives nothing, staff waive the draft gate", async () => {
    rawRows = [];

    await call(
      contentSearchTool,
      { classroom: 'org/slug', query: 'when is the midterm?' },
      STUDENT
    );
    const studentBooleans = visibilityBooleansOf(lastStatement());
    expect(studentBooleans, 'a student must send a false waiver').toContain(false);

    rawStatements = [];
    await call(
      contentSearchTool,
      { classroom: 'org/slug', query: 'when is the midterm?' },
      TEACHER
    );
    const teacherBooleans = visibilityBooleansOf(lastStatement());
    expect(teacherBooleans.length).toBeGreaterThan(0);
    expect(teacherBooleans, 'staff waive every term').not.toContain(false);
  });

  it('gives an ASSISTANT the same draft discovery as a teacher (D2)', async () => {
    await call(contentSearchTool, { classroom: 'org/slug', query: 'final project' }, ASSISTANT);
    expect(visibilityBooleansOf(lastStatement())).not.toContain(false);
  });

  it('passes the classroom id from the resolved context, never from an argument', async () => {
    await call(
      contentSearchTool,
      { classroom: 'org/slug', query: 'midterm', kind: 'page', limit: 3 },
      STUDENT
    );
    const params = paramsOf(lastStatement());
    expect(params).toContain(CLASSROOM_ID);
    expect(params).not.toContain(OTHER_CLASSROOM_ID);
    expect(params).toContain('page');
    expect(params).toContain(3);
  });

  it('marks an unconfigured deployment unavailable rather than returning no matches', async () => {
    mocks.isWorkersAiConfigured.mockReturnValue(false);

    const payload = await call(
      contentSearchTool,
      { classroom: 'org/slug', query: 'when is the midterm?' },
      STUDENT
    );

    expect(payload.unavailable).toBe('embedding_not_configured');
    expect(payload.hits).toEqual([]);
    expect(payload.count).toBe(0);
    // A model must be able to tell this apart from an empty result set.
    expect(String(payload.message)).toMatch(/not an empty result set/i);
    // And no query was run at all.
    expect(mocks.embedTexts).not.toHaveBeenCalled();
    expect(rawStatements).toHaveLength(0);
  });

  it('reports a failed embedding call as unavailable, distinctly from unconfigured', async () => {
    mocks.embedTexts.mockRejectedValue(
      new WorkersAiError('rate limited', { code: 'http_error', status: 429, retryable: true })
    );

    const payload = await call(
      contentSearchTool,
      { classroom: 'org/slug', query: 'midterm' },
      STUDENT
    );

    expect(payload.unavailable).toBe('embedding_failed');
    expect(payload.hits).toEqual([]);
    expect(rawStatements).toHaveLength(0);
  });

  it('treats credentials that vanish mid-call as unconfigured, not as a transient fault', async () => {
    mocks.embedTexts.mockRejectedValue(
      new WorkersAiError('Workers AI is not configured', {
        code: 'not_configured',
        status: 0,
        retryable: false,
      })
    );

    const payload = await call(
      contentSearchTool,
      { classroom: 'org/slug', query: 'midterm' },
      STUDENT
    );
    expect(payload.unavailable).toBe('embedding_not_configured');
  });

  it('reports an over-cap refusal as unavailable rather than as an empty result', async () => {
    mocks.embedTexts.mockResolvedValue({
      ok: false,
      reason: 'over_cap',
      estimatedTokens: 9000,
      limit: 8192,
      index: 0,
    });

    const payload = await call(
      contentSearchTool,
      { classroom: 'org/slug', query: 'midterm' },
      STUDENT
    );
    expect(payload.unavailable).toBe('embedding_failed');
  });

  it('omits isDraft for a student and carries it for staff', async () => {
    rawRows = [SEARCH_ROW];
    const studentPayload = await call(
      contentSearchTool,
      { classroom: 'org/slug', query: 'midterm' },
      STUDENT
    );
    const studentHit = (studentPayload.hits as Array<Record<string, unknown>>)[0];
    expect(Object.keys(studentHit)).not.toContain('isDraft');
    expect(studentHit.id).toBe(PAGE_ID);
    expect(studentHit.score).toBe(0.8123);

    rawRows = [{ ...SEARCH_ROW, isDraft: true }];
    const teacherPayload = await call(
      contentSearchTool,
      { classroom: 'org/slug', query: 'midterm' },
      TEACHER
    );
    expect((teacherPayload.hits as Array<Record<string, unknown>>)[0].isDraft).toBe(true);
  });

  it('logs one structured line per call — ids and counts, never the query text', async () => {
    rawRows = [SEARCH_ROW];
    await call(
      contentSearchTool,
      { classroom: 'org/slug', query: 'when is the midterm?', limit: 5 },
      STUDENT
    );

    const logged = searchLog();
    expect(logged.classroom_id).toBe(CLASSROOM_ID);
    expect(logged.role).toBe('STUDENT');
    expect(logged.query_chars).toBe('when is the midterm?'.length);
    expect(logged.results).toEqual([`page:${PAGE_ID}`]);
    expect(logged.result_count).toBe(1);
    expect(logged.unavailable).toBeNull();
    // The measurement must not become a transcript of what students asked.
    expect(searchLogLines().join('\n')).not.toContain('when is the midterm?');
  });

  it('records the unavailable reason on the same log line', async () => {
    mocks.isWorkersAiConfigured.mockReturnValue(false);
    await call(contentSearchTool, { classroom: 'org/slug', query: 'midterm' }, STUDENT);

    const logged = searchLog();
    expect(logged.unavailable).toBe('embedding_not_configured');
    expect(logged.result_count).toBe(0);
  });
});

// ─── content_list ───────────────────────────────────────────────────────────

describe('content_list', () => {
  it("forwards the viewer's role into the same predicate search uses", async () => {
    await call(contentListTool, { classroom: 'org/slug' }, STUDENT);
    expect(visibilityBooleansOf(lastStatement())).toContain(false);

    rawStatements = [];
    await call(contentListTool, { classroom: 'org/slug' }, TEACHER);
    expect(visibilityBooleansOf(lastStatement())).not.toContain(false);
  });

  it('omits isDraft for a student and carries it for staff, and reports index coverage', async () => {
    rawRows = [LIST_ROW];
    const studentPayload = await call(contentListTool, { classroom: 'org/slug' }, STUDENT);
    const studentItem = (studentPayload.items as Array<Record<string, unknown>>)[0];
    expect(Object.keys(studentItem)).not.toContain('isDraft');
    expect(studentItem.indexed).toBe(true);
    expect(studentItem.updated_at).toBe('2026-09-01T12:00:00.000Z');
    expect(studentPayload.count).toBe(1);

    rawRows = [{ ...LIST_ROW, isDraft: true, indexed: false }];
    const teacherItem = (
      (await call(contentListTool, { classroom: 'org/slug' }, TEACHER)).items as Array<
        Record<string, unknown>
      >
    )[0];
    expect(teacherItem.isDraft).toBe(true);
    expect(teacherItem.indexed).toBe(false);
  });

  it('passes a kind filter through and never a caller-supplied classroom id', async () => {
    await call(contentListTool, { classroom: 'org/slug', kind: 'slide' }, STUDENT);
    const params = paramsOf(lastStatement());
    expect(params).toContain(CLASSROOM_ID);
    expect(params).not.toContain(OTHER_CLASSROOM_ID);
  });

  // ── Paging ────────────────────────────────────────────────────────────────
  //
  // An uncapped listing hands a whole large course to a model in one payload.
  // These pin the window that reaches SQL, and the `truncated` / `next_offset`
  // a model needs to know it is not looking at the whole catalogue.

  const listRow = (id: string) => ({ ...LIST_ROW, docId: id, title: `Doc ${id}` });

  it('bounds an uncapped listing, and asks for one row past the window', async () => {
    await call(contentListTool, { classroom: 'org/slug' }, STUDENT);
    const params = paramsOf(lastStatement());
    // limit + 1 is the probe row that answers "is there more?" without a count.
    expect(params).toContain(101);
    expect(params).toContain(0);
  });

  it('threads a caller-supplied limit and offset into the statement', async () => {
    await call(contentListTool, { classroom: 'org/slug', limit: 25, offset: 50 }, STUDENT);
    const params = paramsOf(lastStatement());
    expect(params).toContain(26);
    expect(params).toContain(50);
  });

  it('reports truncated with a next_offset, and never returns the probe row', async () => {
    rawRows = [listRow('a'), listRow('b'), listRow('c')];

    const payload = await call(contentListTool, { classroom: 'org/slug', limit: 2 }, STUDENT);

    expect(payload.count).toBe(2);
    expect((payload.items as Array<Record<string, unknown>>).map(item => item.id)).toEqual([
      'a',
      'b',
    ]);
    expect(payload.truncated).toBe(true);
    expect(payload.next_offset).toBe(2);
  });

  it('omits next_offset entirely when the listing is complete', async () => {
    rawRows = [listRow('a'), listRow('b')];

    const payload = await call(contentListTool, { classroom: 'org/slug', limit: 2 }, STUDENT);

    expect(payload.count).toBe(2);
    expect(payload.truncated).toBe(false);
    // Absent rather than null: "there is no next page" must not read as a page.
    expect(Object.keys(payload)).not.toContain('next_offset');
  });

  it('declares the window in its schema and its description', () => {
    const schema = contentListTool.inputSchema as unknown as Record<
      string,
      { safeParse(value: unknown): { success: boolean } }
    >;
    expect(Object.keys(schema)).toEqual(
      expect.arrayContaining(['classroom', 'kind', 'limit', 'offset'])
    );
    const accepts = (key: string, value: unknown) => schema[key].safeParse(value).success;

    expect(accepts('limit', 200)).toBe(true);
    expect(accepts('limit', 201)).toBe(false);
    expect(accepts('limit', 0)).toBe(false);
    expect(accepts('offset', 0)).toBe(true);
    expect(accepts('offset', -1)).toBe(false);
    expect(accepts('offset', 1.5)).toBe(false);

    // A model only pages if it is told the listing can be partial.
    expect(contentListTool.description).toContain('truncated');
    expect(contentListTool.description).toContain('next_offset');
  });
});

// ─── content_get ────────────────────────────────────────────────────────────

describe('content_get', () => {
  it('returns the indexed text with the coverage flag set', async () => {
    rawRows = [GET_ROW];
    const payload = await call(
      contentGetTool,
      { classroom: 'org/slug', kind: 'page', id: PAGE_ID },
      STUDENT
    );

    expect(payload.indexed).toBe(true);
    expect(payload.chunk_count).toBe(2);
    expect(payload.text).toContain('14 November');
    expect(Object.keys(payload)).not.toContain('isDraft');
    // Served from the index — no live read needed.
    expect(mocks.fetchContentText).not.toHaveBeenCalled();
  });

  it('refuses a draft to a student with the SAME error a nonexistent id returns', async () => {
    rawRows = []; // not in the index
    setPrismaRows({ page: { findFirst: () => pageRecord() } });
    const draftRefusal = await refusalOf(() =>
      contentGetTool.handler({ classroom: 'org/slug', kind: 'page', id: PAGE_ID }, STUDENT)
    );

    resetPrismaStub();
    setPrismaRaw(() => []);
    setPrismaRows({ page: { findFirst: () => null } });
    const bogusRefusal = await refusalOf(() =>
      contentGetTool.handler({ classroom: 'org/slug', kind: 'page', id: BOGUS_ID }, STUDENT)
    );

    expect(draftRefusal).toEqual(bogusRefusal);
    expect(draftRefusal.error).toBe('not_found');
    // The refusal happened before any content was fetched: a student cannot
    // make the server read a draft even once.
    expect(mocks.fetchContentText).not.toHaveBeenCalled();
  });

  it('scopes the live-fallback lookup to the resolved classroom, by query', async () => {
    rawRows = [];
    setPrismaRows({ page: { findFirst: () => null } });
    await refusalOf(() =>
      contentGetTool.handler({ classroom: 'org/slug', kind: 'page', id: PAGE_ID }, TEACHER)
    );

    const [lookup] = prismaCallsFor('page', 'findFirst');
    expect(lookup, 'the fallback must load the record itself').toBeDefined();
    expect((lookup.args as { where: Record<string, unknown> }).where).toEqual({
      id: PAGE_ID,
      classroom_id: CLASSROOM_ID,
    });
  });

  it('serves an unindexed page live to staff, through the same extractor the indexer uses', async () => {
    rawRows = [];
    setPrismaRows({ page: { findFirst: () => pageRecord() } });
    mocks.fetchContentText.mockResolvedValue({ text: BLOCKNOTE_BODY, sha: 'abc', source: 'api' });

    const payload = await call(
      contentGetTool,
      { classroom: 'org/slug', kind: 'page', id: PAGE_ID },
      TEACHER
    );

    expect(payload.indexed).toBe(false);
    expect(payload.source_path).toBe('pages/unreleased-final-project/content.json');
    expect(payload.text).toContain('key-value store');
    // Title comes from the record, not from the body.
    expect(payload.text).toContain('Unreleased Final Project');
    expect(Object.keys(payload)).not.toContain('chunk_count');

    const [ctxArg, pathArg] = mocks.fetchContentText.mock.calls[0] as [
      { classroom: Record<string, unknown> },
      string,
    ];
    expect(pathArg).toBe('pages/unreleased-final-project/content.json');
    expect(ctxArg.classroom.content_repo).toBe('content-cs52');
  });

  it('falls back to a legacy page body only after content.json misses', async () => {
    rawRows = [];
    setPrismaRows({
      page: { findFirst: () => pageRecord({ is_draft: false, title: 'Legacy Page' }) },
    });
    mocks.fetchContentText.mockImplementation(async (_ctx: unknown, repoPath: string) =>
      repoPath.endsWith('index.html')
        ? {
            text: '<html><body><p>Office hours are Tuesday.</p></body></html>',
            sha: null,
            source: 'cdn',
          }
        : null
    );

    const payload = await call(
      contentGetTool,
      { classroom: 'org/slug', kind: 'page', id: PAGE_ID },
      STUDENT
    );

    expect(payload.source_path).toBe('pages/unreleased-final-project/index.html');
    expect(payload.text).toContain('Office hours are Tuesday.');
    expect(mocks.fetchContentText.mock.calls.map(c => c[1])).toEqual([
      'pages/unreleased-final-project/content.json',
      'pages/unreleased-final-project/index.html',
    ]);
  });

  it("never returns a deck's speaker notes", async () => {
    rawRows = [];
    setPrismaRows({
      slide: {
        findFirst: () =>
          pageRecord({
            id: DECK_ID,
            title: 'Recursion Deck',
            content_path: 'slides/recursion-deck',
            is_draft: false,
          }),
      },
    });
    mocks.fetchContentText.mockResolvedValue({
      text:
        '<html><body><div class="reveal"><div class="slides">' +
        '<section><h2>Recursion</h2><p>Base case first.</p>' +
        '<aside class="notes">Remind them the exam answer key is in the shared drive.</aside>' +
        '</section></div></div></body></html>',
      sha: 'deck',
      source: 'worker',
    });

    const payload = await call(
      contentGetTool,
      { classroom: 'org/slug', kind: 'slide', id: DECK_ID },
      STUDENT
    );

    expect(payload.text).toContain('Base case first.');
    expect(payload.text).not.toContain('answer key');
    expect(JSON.stringify(payload)).not.toContain('answer key');
  });

  it("has no live fallback for a 'file' document — the index is its only record", async () => {
    rawRows = [];
    const refusal = await refusalOf(() =>
      contentGetTool.handler(
        { classroom: 'org/slug', kind: 'file', id: 'bot-context/office-hours.md' },
        TEACHER
      )
    );

    expect(refusal.error).toBe('not_found');
    expect(prismaCalls.filter(c => c.clientKey === 'page' || c.clientKey === 'slide')).toHaveLength(
      0
    );
    expect(mocks.fetchContentText).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// TWO CORPORA BEHIND THE SAME THREE TOOLS
//
// The failure this block exists for is not "docs search does not work" — it is
// the two lanes LEAKING into each other. A `scope: 'docs'` call that reaches
// `searchContent` answers a platform question out of one classroom's material;
// a default call that reaches `searchDocs` answers a course question out of the
// product manual. Both are confident, plausible and wrong.
// ═══════════════════════════════════════════════════════════════════════════

/** Which raw statement a stubbed answer belongs to, keyed by a SQL fragment. */
type RawAnswers = Array<[fragment: string, rows: unknown[]]>;

/** Install a raw handler that dispatches on the statement's own text. */
const answerRawBy = (answers: RawAnswers): void => {
  setPrismaRaw((parts: unknown[]) => {
    rawStatements.push(parts);
    const sql = (parts as string[]).join(' ');
    for (const [fragment, rows] of answers) if (sql.includes(fragment)) return rows;
    return [];
  });
};

const DOCS_ROW = {
  slug: 'docs/instructors/roster',
  chunkIx: 0,
  title: 'Manage your roster',
  description: 'How to add students and teaching staff',
  section: 'instructors',
  snippet: 'Go to the Teaching Staff tab and click New staff member.',
  score: 0.91,
};

const COURSE_ROW = {
  docKind: 'page' as const,
  docId: PAGE_ID,
  chunkIx: 0,
  title: 'Course Policies',
  snippet: 'Late work is accepted for 48 hours.',
  score: 0.8,
  isDraft: null,
};

/** Every raw statement issued, as one string, for "did it touch that table". */
const allSql = (): string => rawStatements.map(parts => (parts as string[]).join(' ')).join('\n');

describe('scope selects the corpus, and the two never leak into each other', () => {
  it('defaults to the COURSE corpus and never touches docs_index', async () => {
    answerRawBy([['content_index', [COURSE_ROW]]]);

    const payload = await call(
      contentSearchTool,
      { classroom: 'o/c', query: 'late work' },
      STUDENT
    );

    expect(payload.count).toBe(1);
    expect((payload.hits as Array<Record<string, unknown>>)[0].kind).toBe('page');
    expect(allSql()).toContain('content_index');
    expect(allSql()).not.toContain('docs_index');
  });

  it("scope: 'docs' reads docs_index and never touches content_index", async () => {
    answerRawBy([['docs_index', [DOCS_ROW]]]);

    const payload = await call(
      contentSearchTool,
      { classroom: 'o/c', query: 'where do I add a TA', scope: 'docs' },
      STUDENT
    );

    expect(payload.count).toBe(1);
    expect(allSql()).toContain('docs_index');
    expect(allSql()).not.toContain('content_index');
  });

  it("shapes a docs hit as kind 'doc' with the slug as id and a real url", async () => {
    answerRawBy([['docs_index', [DOCS_ROW]]]);

    const payload = await call(
      contentSearchTool,
      { classroom: 'o/c', query: 'where do I add a TA', scope: 'docs' },
      STUDENT
    );

    const [hit] = payload.hits as Array<Record<string, unknown>>;
    expect(hit.kind).toBe('doc');
    expect(hit.id).toBe('docs/instructors/roster');
    expect(hit.title).toBe('Manage your roster');
    expect(hit.section).toBe('instructors');
    // The id and the link are the same string by construction, so a citation
    // and the chip under it cannot disagree.
    expect(hit.url).toBe('https://classmoji.io/docs/instructors/roster');
    expect(hit.snippet).toContain('Teaching Staff');
    // No course-only fields leak across.
    expect(Object.keys(hit)).not.toContain('isDraft');
    expect(Object.keys(hit)).not.toContain('source_path');
  });

  it("scope: 'docs' still embeds the query exactly as the course lane does", async () => {
    answerRawBy([['docs_index', [DOCS_ROW]]]);
    await call(
      contentSearchTool,
      { classroom: 'o/c', query: 'how do tokens work', scope: 'docs' },
      STUDENT
    );
    expect(mocks.embedTexts).toHaveBeenCalledWith(['how do tokens work']);
  });

  it('reports an embedding failure on the DOCS lane with the same marker', async () => {
    // Not a docs-specific message: "retrieval is down" is the same fact in both
    // corpora, and a second vocabulary for it is a second thing to get wrong.
    mocks.isWorkersAiConfigured.mockReturnValue(false);

    const payload = await call(
      contentSearchTool,
      { classroom: 'o/c', query: 'anything', scope: 'docs' },
      STUDENT
    );

    expect(payload.unavailable).toBe('embedding_not_configured');
    expect(String(payload.message)).toMatch(/not an empty result set/i);
    expect(allSql()).not.toContain('docs_index');
  });

  it('bounds BOTH scopes at the number the service actually clamps to', async () => {
    // `content_search` and `content_list` each have ONE `limit` field covering
    // both corpora, so each schema can name exactly one ceiling — the course
    // one. The docs read service used to declare its own copy of every bound at
    // the same five values and export them to nobody, which made "the schema
    // refuses where the service clamps" true only by coincidence: editing the
    // docs copy would have moved the clamp and left the refusal behind, with no
    // test anywhere to notice. There is now ONE constant per bound.
    const bound = (tool: typeof contentSearchTool | typeof contentListTool, value: unknown) =>
      (
        tool.inputSchema as unknown as Record<
          string,
          { safeParse(v: unknown): { success: boolean } }
        >
      ).limit.safeParse(value).success;

    expect(bound(contentSearchTool, MAX_SEARCH_LIMIT)).toBe(true);
    expect(bound(contentSearchTool, MAX_SEARCH_LIMIT + 1)).toBe(false);
    expect(bound(contentListTool, MAX_LIST_LIMIT)).toBe(true);
    expect(bound(contentListTool, MAX_LIST_LIMIT + 1)).toBe(false);

    // And the ceiling the schema accepts reaches the docs statement UNCLAMPED,
    // which is what makes the two thresholds the same number rather than two
    // numbers that happen to agree.
    answerRawBy([['docs_index', [DOCS_ROW]]]);
    await call(
      contentSearchTool,
      { classroom: 'o/c', query: 'how do tokens work', scope: 'docs', limit: MAX_SEARCH_LIMIT },
      STUDENT
    );
    expect(paramsOf(lastStatement())).toContain(MAX_SEARCH_LIMIT);

    rawStatements = [];
    answerRawBy([['content_index', [COURSE_ROW]]]);
    await call(
      contentSearchTool,
      { classroom: 'o/c', query: 'late work', limit: MAX_SEARCH_LIMIT },
      STUDENT
    );
    expect(paramsOf(lastStatement())).toContain(MAX_SEARCH_LIMIT);
  });

  it('leaves the docs service no second copy of a bound to drift from', () => {
    // The negative space of the test above. A `MAX_DOCS_SEARCH_LIMIT` declared
    // here again would compile, pass every other test, and silently reopen the
    // gap the moment somebody changed its value.
    const source = readFileSync(
      path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        '../../../../../packages/services/src/classmoji/docsSearch.service.ts'
      ),
      'utf8'
    );
    const declarations = source.match(/^export const [A-Z_]+/gm) ?? [];
    // One export, and it is the search floor — not a bound the tool schema has
    // to mirror.
    expect(declarations).toEqual(['export const DOCS_SEARCH_MIN_CHARS']);
  });

  it("scope: 'docs' lists from docs_index, default lists from the course records", async () => {
    answerRawBy([['docs_index', [{ ...DOCS_ROW, updatedAt: new Date('2026-09-12T00:00:00Z') }]]]);
    const docs = await call(contentListTool, { classroom: 'o/c', scope: 'docs' }, STUDENT);
    expect((docs.items as Array<Record<string, unknown>>)[0].kind).toBe('doc');
    expect((docs.items as Array<Record<string, unknown>>)[0].url).toBe(
      'https://classmoji.io/docs/instructors/roster'
    );

    rawStatements = [];
    answerRawBy([['pages', []]]);
    await call(contentListTool, { classroom: 'o/c' }, STUDENT);
    expect(allSql()).not.toContain('docs_index');
  });
});

describe('kind and scope: docs are refused together, never silently reconciled', () => {
  it.each([['page'], ['slide'], ['file']] as const)(
    "refuses kind '%s' with scope: 'docs'",
    async kind => {
      const refusal = await refusalOf(() =>
        call(
          contentSearchTool,
          { classroom: 'o/c', query: 'anything', scope: 'docs', kind },
          STUDENT
        )
      );
      expect(refusal.error).toBe('invalid_params');
      expect(refusal.message).toMatch(/has no meaning for scope: 'docs'/);
    }
  );

  it('refuses the pair on content_list too', async () => {
    const refusal = await refusalOf(() =>
      call(contentListTool, { classroom: 'o/c', scope: 'docs', kind: 'page' }, STUDENT)
    );
    expect(refusal.error).toBe('invalid_params');
  });

  it('refuses BEFORE running anything, so no statement is issued', async () => {
    await refusalOf(() =>
      call(
        contentSearchTool,
        { classroom: 'o/c', query: 'anything', scope: 'docs', kind: 'page' },
        STUDENT
      )
    );
    expect(mocks.embedTexts).not.toHaveBeenCalled();
    expect(rawStatements).toHaveLength(0);
  });

  it('still accepts kind on the COURSE lane', async () => {
    answerRawBy([['content_index', [COURSE_ROW]]]);
    const payload = await call(
      contentSearchTool,
      { classroom: 'o/c', query: 'late work', kind: 'page' },
      STUDENT
    );
    expect(payload.count).toBe(1);
  });
});

describe('an unbuilt docs index is an UNAVAILABLE, not an empty result', () => {
  it('carries the marker and a message that does not claim no search was run', async () => {
    answerRawBy([
      ['docs_index di', []],
      ['NOT EXISTS', [{ empty: true }]],
    ]);

    const payload = await call(
      contentSearchTool,
      { classroom: 'o/c', query: 'anything', scope: 'docs' },
      STUDENT
    );

    expect(payload.unavailable).toBe('docs_index_empty');
    expect(payload.hits).toEqual([]);
    expect(String(payload.message)).toMatch(/has not been built on this deployment/);
    expect(String(payload.message)).toMatch(/not an empty result set/i);
    // A search WAS run on this branch. Saying otherwise is simply false, and it
    // is the sentence the course lane uses for a DIFFERENT state.
    expect(String(payload.message)).not.toMatch(/no search was run/);
  });

  it('is never an error — the caller can still answer around it', async () => {
    answerRawBy([
      ['docs_index di', []],
      ['NOT EXISTS', [{ empty: true }]],
    ]);
    await expect(
      contentSearchTool.handler({ classroom: 'o/c', query: 'anything', scope: 'docs' }, STUDENT)
    ).resolves.toBeDefined();
  });

  it('reports a genuinely empty ANSWER as empty when the index is populated', async () => {
    answerRawBy([
      ['docs_index di', []],
      ['NOT EXISTS', [{ empty: false }]],
    ]);

    const payload = await call(
      contentSearchTool,
      { classroom: 'o/c', query: 'quantum tunnelling', scope: 'docs' },
      STUDENT
    );

    expect(payload.count).toBe(0);
    expect(payload.unavailable).toBeUndefined();
    expect(payload.message).toBeUndefined();
  });

  it('does NOT ask whether the index is empty when there are hits', async () => {
    // One statement, not two: the emptiness probe exists only to explain an
    // absence, and running it on every successful search is a query per call
    // for an answer nobody reads.
    answerRawBy([['docs_index', [DOCS_ROW]]]);

    await call(contentSearchTool, { classroom: 'o/c', query: 'roster', scope: 'docs' }, STUDENT);

    expect(allSql()).not.toContain('NOT EXISTS');
  });

  it('marks an empty docs LISTING the same way', async () => {
    answerRawBy([
      ['docs_index di', []],
      ['NOT EXISTS', [{ empty: true }]],
    ]);
    const payload = await call(contentListTool, { classroom: 'o/c', scope: 'docs' }, STUDENT);
    expect(payload.unavailable).toBe('docs_index_empty');
    expect(payload.items).toEqual([]);
  });
});

describe('content_get with kind: doc', () => {
  it('returns the page text, its canonical url, and no course-only fields', async () => {
    answerRawBy([
      [
        'docs_index di',
        [
          {
            slug: 'docs/instructors/roster',
            title: 'Manage your roster',
            description: 'How to add students',
            section: 'instructors',
            text: 'Go to the Teaching Staff tab and click New staff member.',
            chunkCount: 1,
            updatedAt: new Date('2026-09-12T00:00:00Z'),
          },
        ],
      ],
    ]);

    const payload = await call(
      contentGetTool,
      { classroom: 'o/c', kind: 'doc', id: 'docs/instructors/roster' },
      STUDENT
    );

    expect(payload.kind).toBe('doc');
    expect(payload.id).toBe('docs/instructors/roster');
    expect(payload.url).toBe('https://classmoji.io/docs/instructors/roster');
    expect(String(payload.text)).toContain('Teaching Staff');
    expect(Object.keys(payload)).not.toContain('source_path');
    expect(Object.keys(payload)).not.toContain('isDraft');
  });

  it('refuses a missing page distinctly, because docs are public', async () => {
    answerRawBy([['docs_index di', []]]);

    const refusal = await refusalOf(() =>
      call(contentGetTool, { classroom: 'o/c', kind: 'doc', id: 'docs/nope' }, STUDENT)
    );

    expect(refusal.error).toBe('not_found');
    // NOT the uniform `scopedNotFound('Content')` wording. That one is uniform
    // to stop a student enumerating drafts by watching which ids answer
    // differently; documentation is global and public, so there is nothing to
    // enumerate.
    expect(refusal.message).toBe('Documentation page not found');
    expect(refusal.message).not.toMatch(/in this classroom/);
  });

  it('never falls back to a live fetch for a doc', async () => {
    answerRawBy([['docs_index di', []]]);
    await refusalOf(() =>
      call(contentGetTool, { classroom: 'o/c', kind: 'doc', id: 'docs/nope' }, STUDENT)
    );
    // The course lane reads the content repo when its index lags. Documentation
    // exists ONLY in the index, so a fallback would be an on-demand fetch of a
    // caller-supplied path from github.com.
    expect(mocks.fetchContentText).not.toHaveBeenCalled();
    // Keyed (model, method) — the stub's own signature. A single dotted string
    // silently matches nothing, which is a passing assertion about nothing.
    expect(prismaCallsFor('page', 'findFirst')).toHaveLength(0);
    expect(prismaCallsFor('slide', 'findFirst')).toHaveLength(0);
  });
});

describe('the instrumentation line carries the corpus, and still never the query', () => {
  it("logs scope 'docs' and the doc ids, not the text asked for", async () => {
    answerRawBy([['docs_index', [DOCS_ROW]]]);

    await call(
      contentSearchTool,
      { classroom: 'o/c', query: 'where do I add a teaching assistant', scope: 'docs' },
      STUDENT
    );

    const line = searchLog();
    expect(line.scope).toBe('docs');
    expect(line.result_count).toBe(1);
    expect(line.results).toEqual(['doc:docs/instructors/roster']);
    expect(line.query_chars).toBe('where do I add a teaching assistant'.length);
    // The whole point of logging a LENGTH: what a student typed is not kept.
    expect(loggedLines.join('\n')).not.toContain('teaching assistant');
  });

  it("logs scope 'course' by default, with the course ids", async () => {
    answerRawBy([['content_index', [COURSE_ROW]]]);
    await call(contentSearchTool, { classroom: 'o/c', query: 'late work' }, STUDENT);

    const line = searchLog();
    expect(line.scope).toBe('course');
    expect(line.results).toEqual([`page:${PAGE_ID}`]);
  });

  it('logs the marker when the docs index is unbuilt', async () => {
    answerRawBy([
      ['docs_index di', []],
      ['NOT EXISTS', [{ empty: true }]],
    ]);
    await call(contentSearchTool, { classroom: 'o/c', query: 'anything', scope: 'docs' }, STUDENT);

    const line = searchLog();
    expect(line.scope).toBe('docs');
    expect(line.unavailable).toBe('docs_index_empty');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// THE SCHEMAS AS A CLIENT ACTUALLY SEES THEM
//
// Everything above reads `contentSearchTool.inputSchema` — the object this file
// exports. That is not what a model is handed. The registry converts the zod
// raw shape to JSON Schema and publishes it over `tools/list`, and the SDK
// validates every call against the converted copy. A zod shape that is correct
// in TypeScript and unconvertible, or a tool the registry declines to register
// at all, looks perfect to every assertion above and is invisible to a client.
//
// So this block registers the three REAL definitions and drives a REAL
// McpServer over the SDK's in-memory transport, the same way registry.test.ts
// does.
// ═══════════════════════════════════════════════════════════════════════════

describe('the schemas the registry publishes', () => {
  let listed: Array<{ name: string; description?: string; inputSchema: Record<string, unknown> }>;

  beforeAll(async () => {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');

    for (const tool of [contentSearchTool, contentListTool, contentGetTool]) {
      registerToolDefinition(tool as unknown as ToolDefinition<never>);
    }

    const server = buildMcpServer({
      userId: 'schema-viewer',
      clientId: 'schema-test',
      scopes: new Set(['read']),
    } as never);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'schema-test', version: '0.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    listed = (await client.listTools()).tools as typeof listed;
  });

  const toolNamed = (name: string) => {
    const tool = listed.find(entry => entry.name === name);
    expect(tool, `${name} must be registered`).toBeDefined();
    return tool as (typeof listed)[number];
  };

  const propertiesOf = (name: string): Record<string, { enum?: string[] }> =>
    (toolNamed(name).inputSchema.properties ?? {}) as Record<string, { enum?: string[] }>;

  it('registers all three, so a schema that will not convert fails here', () => {
    expect(listed.map(entry => entry.name)).toEqual(
      expect.arrayContaining(['content_search', 'content_list', 'content_get'])
    );
  });

  it('publishes the two corpus values on search and list', () => {
    for (const name of ['content_search', 'content_list']) {
      expect(propertiesOf(name).scope?.enum).toEqual(['course', 'docs']);
    }
  });

  it("keeps `kind` on search and list at the three COURSE kinds — no 'doc'", () => {
    // Widening the shared `kindArg` would make `kind: 'doc'` a legal FILTER on
    // search and list, where it means nothing, and would carry the same
    // widening into the live fallback.
    for (const name of ['content_search', 'content_list']) {
      expect(propertiesOf(name).kind?.enum).toEqual(['page', 'slide', 'file']);
    }
  });

  it("gives content_get its own four-value kind, including 'doc'", () => {
    expect(propertiesOf('content_get').kind?.enum).toEqual(['page', 'slide', 'file', 'doc']);
  });

  it('does NOT offer a scope argument on content_get', () => {
    // `kind` already selects the corpus there; a second, redundant selector is
    // a second thing for a model to get inconsistent with itself.
    expect(propertiesOf('content_get').scope).toBeUndefined();
  });

  it('describes both corpora in every description, so the choice is not a guess', () => {
    for (const name of ['content_search', 'content_list']) {
      const description = String(toolNamed(name).description);
      expect(description).toMatch(/classmoji\.io/);
      expect(description).toMatch(/scope: 'docs'/);
      expect(description).toMatch(/this classroom/i);
    }
    expect(String(toolNamed('content_get').description)).toMatch(/kind: 'doc'/);
  });

  it('still says an `unavailable` field is not an absence of material', () => {
    expect(String(toolNamed('content_search').description)).toMatch(
      /NOT the same as "nothing found"/
    );
  });
});
