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
import { beforeEach, describe, expect, it, vi, afterEach } from 'vitest';
import { ToolError } from '../../mcp/errors.ts';
import { toolAnnotations, type ToolContext, type ToolDefinition } from '../../mcp/registry.ts';

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
  return {
    ...real,
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
