/**
 * The security tests of the content phase, end to end (plan §5.7 / §7.3).
 *
 * Real Postgres, a real spawned MCP server, real OAuth bearer tokens, the real
 * registry pipeline. What a student's token can reach through `content_search`
 * / `content_list` / `content_get` is decided here by the gate, not by a
 * handler remembering to check something.
 *
 * NO LIVE CREDENTIALS ARE REQUIRED (review finding 17) — and that now includes
 * `content_search` itself. Three blocks, in order:
 *
 *   1. Workers AI DELIBERATELY UNCONFIGURED: the visibility matrix, ridden over
 *      `content_list` / `content_get`, which need no embeddings and go through
 *      exactly the same predicate as search. That also makes the "search is
 *      unavailable" case reachable on demand instead of only when someone's
 *      token happens to be missing.
 *   2. Workers AI pointed at a STUB IN THIS PROCESS (`startFakeEmbedder`).
 *      This is the block that answers plan §7.3 #1–#3 about `content_search`
 *      END TO END — real tool, real registry, real bearer token, real SQL — on
 *      a machine holding no Cloudflare account. The stub turns a query into a
 *      unit basis vector by keyword, so ranking is exactly determined and WHICH
 *      documents come back is decided by the permission join.
 *   3. The same scenarios against the REAL endpoint, as a paraphrase smoke
 *      test: additive, and skipped when there are no credentials.
 *
 * The stubbed root reaches the SERVER ONLY, through `startServer({ env })`.
 * This process never sets it, so block 1's unconfigured case cannot be
 * contaminated by block 2.
 *
 * SAFETY: every fixture hangs off ONE throwaway GitOrganization under a fresh
 * uuid namespace, and teardown deletes that organization — cascading its
 * classrooms, pages, slides, memberships and content_index rows — plus the
 * four fixture users and the tokens this run minted. Nothing pre-existing is
 * read or written, and nothing is truncated.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Prisma } from '@prisma/client';
import {
  callTool,
  deleteMintedTokens,
  expectForbidden,
  expectScopedNotFound,
  getPrisma,
  mintToken,
  mintedTokens,
  rpc,
  startServer,
  type ServerHandle,
  type ToolCallOutcome,
} from './helpers.ts';

// Deferred for the same reason helpers.ts defers `@classmoji/database`: these
// modules pull the database package in, and the .env load inside helpers has to
// have happened before the Prisma client is constructed.
const { toVectorLiteral, EMBEDDING_DIMENSIONS } = await import('@classmoji/services');
const { EMBEDDING_MODEL, BASE_URL_ENV } = await import('@classmoji/services/workers-ai');
const { mintMcpAccessToken } = await import('@classmoji/auth/mcp-token');

// These suites CREATE rows, so they run only against a local database.
const DATABASE_URL = process.env.DATABASE_URL ?? '';
const RUN = /@(localhost|127\.0\.0\.1)[:/]/.test(DATABASE_URL);

const WORKERS_AI_VARS = ['CLOUDFLARE_WORKERS_AI_TOKEN', 'CLOUDFLARE_ACCOUNT_ID'] as const;
const HAS_WORKERS_AI = WORKERS_AI_VARS.every(name => Boolean(process.env[name]));

/**
 * Remove every Workers AI setting from THIS process's env so the server
 * `startServer` spawns (it inherits `process.env`) comes up unconfigured.
 * The base-URL override is cleared too: a developer who has one set in `.env`
 * must not be able to turn the unconfigured case into a configured one.
 * Returns the restore function.
 */
function withoutWorkersAi(): () => void {
  const saved = new Map<string, string | undefined>();
  for (const name of [...WORKERS_AI_VARS, BASE_URL_ENV]) {
    saved.set(name, process.env[name]);
    delete process.env[name];
  }
  return () => {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
}

// ─── Deterministic vectors ──────────────────────────────────────────────────

/** The i-th unit basis vector: distance 0 to itself, exactly 1 to any other. */
const basis = (index: number): number[] => {
  const vector = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
  vector[index] = 1;
  return vector;
};

// ─── The stubbed embedder ───────────────────────────────────────────────────

const FAKE_ACCOUNT_ID = 'p27-fake-account';
const FAKE_TOKEN = 'p27-fake-workers-ai-token';

/**
 * A query's "embedding": the basis vector of the fixture it is asking about.
 *
 * Cosine distance from a basis vector is 0 to the row carrying the same one and
 * exactly 1 to every other row, so the ranking a search returns is fully
 * determined by this table plus the permission join — nothing here depends on
 * an embedding model's judgement, or on it still being reachable. An unmatched
 * query lands on a basis vector NO fixture carries, which is how "the course
 * has nothing about that" is expressed without special-casing it.
 */
const stubEmbedding = (text: string): number[] => {
  const lowered = text.toLowerCase();
  if (lowered.includes('midterm') || lowered.includes('exam')) return basis(0); // published page
  if (lowered.includes('capstone') || lowered.includes('final project')) return basis(1); // draft
  if (lowered.includes('recursion')) return basis(2); // the deck
  if (lowered.includes('office hours')) return basis(3); // the bot-context note
  // The DOCUMENTATION fixture. Deliberately a basis no course fixture carries,
  // so a corpus leak in either direction shows up as a hit that should not
  // exist rather than as a reordering.
  if (lowered.includes('teaching assistant') || lowered.includes('add a ta')) return basis(5);
  return basis(4); // orthogonal to the entire fixture corpus
};

interface FakeEmbedder {
  /** Pass as CLOUDFLARE_WORKERS_AI_BASE_URL to the spawned server. */
  url: string;
  /** How many embed calls the server actually made. */
  calls: () => number;
  close: () => Promise<void>;
}

/**
 * Cloudflare Workers AI, stood in for on loopback.
 *
 * It answers the ONE route the client calls and 404s everything else, and it
 * checks the bearer token, so a client that built the wrong URL or dropped the
 * Authorization header fails here rather than quietly passing. The response
 * envelope is the real one (`{ result: { data, shape }, success }`), because
 * the client validates `shape` and every vector's width.
 */
async function startFakeEmbedder(): Promise<FakeEmbedder> {
  const route = `/accounts/${FAKE_ACCOUNT_ID}/ai/run/${EMBEDDING_MODEL}`;
  let calls = 0;

  const fail = (res: http.ServerResponse, status: number, message: string): void => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ success: false, errors: [{ code: status, message }], messages: [] }));
  };

  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== route) {
      fail(res, 404, `stub embedder has no route for ${req.method} ${req.url}`);
      return;
    }
    if (req.headers.authorization !== `Bearer ${FAKE_TOKEN}`) {
      fail(res, 401, 'stub embedder rejected the Authorization header');
      return;
    }

    let body = '';
    req.on('data', chunk => (body += chunk));
    req.on('end', () => {
      let texts: string[];
      try {
        texts = (JSON.parse(body) as { text?: string[] }).text ?? [];
      } catch {
        fail(res, 400, 'stub embedder could not parse the request body');
        return;
      }
      calls += 1;
      const data = texts.map(stubEmbedding);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          result: { data, shape: [data.length, EMBEDDING_DIMENSIONS] },
          success: true,
          errors: [],
          messages: [],
        })
      );
    });
  });

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    calls: () => calls,
    close: () =>
      new Promise<void>(resolve => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

// ─── Fixtures ───────────────────────────────────────────────────────────────

const ns = randomUUID().slice(0, 8);
const ORG_LOGIN = `p27-org-${ns}`;
const CLASS_SLUG = `p27-${ns}-a`;
const FOREIGN_SLUG = `p27-${ns}-b`;
const CLASS_REF = `${ORG_LOGIN}/${CLASS_SLUG}`;
const FOREIGN_REF = `${ORG_LOGIN}/${FOREIGN_SLUG}`;
const FILE_DOC_ID = 'bot-context/office-hours.md';
/**
 * The documentation fixture.
 *
 * `docs_index` is GLOBAL — there is no classroom to hang it off and no cascade
 * to clean it up — so the slug is namespaced with this run's uuid and teardown
 * deletes exactly that prefix. Nothing pre-existing is read or written, and a
 * developer's real docs rows (which this database may well hold) are left
 * alone: they sit at distance 1 from the stub's basis vector while the fixture
 * sits at 0, so they cannot change what the top hit is.
 */
const DOCS_SLUG = `docs/p27-${ns}/roster`;
/** An identifier that must survive the extractor AND the round trip. */
const DOCS_CODE_SENTINEL = 'AI_AGENT_SHARED_SECRET';
const BOGUS_ID = '00000000-0000-4000-8000-00000000dead';

const LOGINS = {
  teacher: `p27-teacher-${ns}`,
  // D2 parity: an ASSISTANT prepares course material alongside the teacher and
  // must reach drafts on exactly the same terms. Without a fixture of its own,
  // "staff" in this file would only ever mean TEACHER.
  assistant: `p27-assistant-${ns}`,
  student: `p27-student-${ns}`,
  outsider: `p27-outsider-${ns}`,
};

const ids = {
  org: '',
  classroom: '',
  foreign: '',
  author: '',
  studentUser: '',
  publishedPage: '',
  draftPage: '',
  unindexedDraftPage: '',
  deck: '',
};

const tokens = { teacher: '', assistant: '', student: '', outsider: '' };

let server: ServerHandle | null = null;
let restoreEnv: (() => void) | null = null;
let fakeEmbedder: FakeEmbedder | null = null;

const insertIndexRow = async (args: {
  docKind: 'page' | 'slide' | 'file';
  docId: string;
  title: string;
  text: string;
  vector: number[];
  sourcePath: string;
}): Promise<void> => {
  await getPrisma().$executeRaw`
    INSERT INTO content_index (
      classroom_id, doc_kind, doc_id, chunk_ix, chunk_count,
      source_path, source_sha, extract_version, embed_model,
      title, text, embedding
    ) VALUES (
      ${ids.classroom}, ${args.docKind}, ${args.docId}, 0, 1,
      ${args.sourcePath}, ${`sha-${ns}`}, 1, ${'@cf/qwen/qwen3-embedding-0.6b'},
      ${args.title}, ${args.text}, ${Prisma.sql`${toVectorLiteral(args.vector)}::vector`}
    )`;
};

/**
 * One documentation row.
 *
 * `docs_index` has no classroom column, no FK and no visibility columns — that
 * is the point of the second corpus — so this writes a GLOBAL row and teardown
 * removes it by its namespaced slug prefix.
 */
const insertDocsRow = async (args: {
  slug: string;
  title: string;
  description: string;
  section: string;
  text: string;
  vector: number[];
}): Promise<void> => {
  await getPrisma().$executeRaw`
    INSERT INTO docs_index (
      slug, chunk_ix, chunk_count, title, description, section, text,
      source_sha, extract_version, embed_model, embedding
    ) VALUES (
      ${args.slug}, 0, 1, ${args.title}, ${args.description}, ${args.section}, ${args.text},
      ${`sha-${ns}`}, 1, ${'@cf/qwen/qwen3-embedding-0.6b'},
      ${Prisma.sql`${toVectorLiteral(args.vector)}::vector`}
    )`;
};

const createPage = async (title: string, isDraft: boolean): Promise<string> => {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const page = await getPrisma().page.create({
    data: {
      classroom_id: ids.classroom,
      title,
      slug,
      content_path: `pages/${slug}`,
      created_by: ids.author,
      is_draft: isDraft,
      is_public: false,
    },
  });
  return page.id;
};

const createClassroom = async (slug: string): Promise<string> => {
  const classroom = await getPrisma().classroom.create({
    data: {
      slug,
      git_org_id: ids.org,
      name: `P2-7 fixture ${slug}`,
      content_namespace: slug,
      content_repo: `content-${slug}`,
    },
  });
  return classroom.id;
};

beforeAll(async () => {
  if (!RUN) return;
  const prisma = getPrisma();

  const org = await prisma.gitOrganization.create({
    data: { provider: 'GITHUB', provider_id: `p27-${ns}`, login: ORG_LOGIN },
  });
  ids.org = org.id;

  const users = await Promise.all(
    Object.values(LOGINS).map(login =>
      prisma.user.create({ data: { login, email: `${login}@example.test`, name: login } })
    )
  );
  const [teacherUser, assistantUser, studentUser, outsiderUser] = users;
  ids.author = teacherUser.id;
  ids.studentUser = studentUser.id;

  ids.classroom = await createClassroom(CLASS_SLUG);
  ids.foreign = await createClassroom(FOREIGN_SLUG);

  await prisma.classroomMembership.createMany({
    data: [
      { classroom_id: ids.classroom, user_id: teacherUser.id, role: 'TEACHER' },
      { classroom_id: ids.classroom, user_id: assistantUser.id, role: 'ASSISTANT' },
      { classroom_id: ids.classroom, user_id: studentUser.id, role: 'STUDENT' },
      // A real user, a real membership — in the OTHER classroom. Addressing
      // this classroom must be refused as "not a member", not as "no such
      // classroom": a member of the platform asking about a course they are not
      // in is a different fact from a bad reference.
      { classroom_id: ids.foreign, user_id: outsiderUser.id, role: 'STUDENT' },
    ],
  });

  ids.publishedPage = await createPage(`Assessment Schedule ${ns}`, false);
  ids.draftPage = await createPage(`Unreleased Final Project ${ns}`, true);
  // Deliberately NEVER indexed: this is the row content_get's live fallback
  // reaches for, and the only path on which the tool applies the predicate
  // itself rather than letting the SQL apply it.
  ids.unindexedDraftPage = await createPage(`Unindexed Draft ${ns}`, true);

  const deckSlug = `recursion-deck-${ns}`;
  const deck = await prisma.slide.create({
    data: {
      classroom_id: ids.classroom,
      title: `Recursion Deck ${ns}`,
      slug: deckSlug,
      content_path: `slides/${deckSlug}`,
      created_by: ids.author,
      is_draft: false,
      is_public: false,
    },
  });
  ids.deck = deck.id;

  await insertIndexRow({
    docKind: 'page',
    docId: ids.publishedPage,
    title: `Assessment Schedule ${ns}`,
    text: 'Exam 2 is scheduled for 14 November in Kemeny 007.',
    vector: basis(0),
    sourcePath: `pages/assessment-schedule-${ns}/content.json`,
  });
  await insertIndexRow({
    docKind: 'page',
    docId: ids.draftPage,
    title: `Unreleased Final Project ${ns}`,
    text: 'The capstone will be a distributed key-value store.',
    vector: basis(1),
    sourcePath: `pages/unreleased-final-project-${ns}/content.json`,
  });
  await insertIndexRow({
    docKind: 'slide',
    docId: ids.deck,
    title: `Recursion Deck ${ns}`,
    text: 'Recursion: always write the base case first.',
    vector: basis(2),
    sourcePath: `slides/${deckSlug}/index.html`,
  });
  await insertIndexRow({
    docKind: 'file',
    docId: FILE_DOC_ID,
    title: 'office-hours',
    text: 'Office hours are Tuesday afternoons in Sudikoff.',
    vector: basis(3),
    sourcePath: FILE_DOC_ID,
  });

  await insertDocsRow({
    slug: DOCS_SLUG,
    title: `Manage your roster ${ns}`,
    description: 'How to add students and teaching staff to your classroom',
    section: 'instructors',
    // Long enough to clear `DOCS_SEARCH_MIN_CHARS`. `searchDocs` drops any
    // chunk under 400 characters, which is what keeps the corpus's two
    // section-index pages — a heading and a list of links — out of the results;
    // a two-sentence fixture is indistinguishable from one of those.
    text:
      'Go to the Teaching Staff tab and click New staff member. Pick the role, enter their ' +
      `Github username, and confirm. Set ${DOCS_CODE_SENTINEL} to enable AI features. ` +
      'Roles add up rather than replace: granting someone a second role in the same class ' +
      'leaves the first one alone, and they appear once per role they hold. Removing someone ' +
      'takes away that one role and nothing else. An assistant grades the work assigned to ' +
      'them and helps run the class; a teacher can do everything an owner can except delete ' +
      'the classroom itself.',
    vector: basis(5),
  });
});

afterAll(async () => {
  if (!RUN) return;
  await server?.stop();
  await fakeEmbedder?.close();
  restoreEnv?.();
  const prisma = getPrisma();
  await deleteMintedTokens();
  if (ids.org) await prisma.gitOrganization.delete({ where: { id: ids.org } });
  await prisma.user.deleteMany({ where: { login: { in: Object.values(LOGINS) } } });
  // `docs_index` is global and cascades from nothing, so it is deleted by this
  // run's own slug prefix. A bare `DELETE FROM docs_index` would take a
  // developer's real 25 documentation rows with it.
  await prisma.$executeRaw`DELETE FROM docs_index WHERE slug LIKE ${`docs/p27-${ns}/%`}`;
});

/** Mint one read token per fixture identity against the running server. */
async function mintFixtureTokens(): Promise<void> {
  const [teacher, assistant, student, outsider] = await Promise.all([
    mintToken({ login: LOGINS.teacher, scopes: ['read'] }),
    mintToken({ login: LOGINS.assistant, scopes: ['read'] }),
    mintToken({ login: LOGINS.student, scopes: ['read'] }),
    mintToken({ login: LOGINS.outsider, scopes: ['read'] }),
  ]);
  tokens.teacher = teacher.access_token;
  tokens.assistant = assistant.access_token;
  tokens.student = student.access_token;
  tokens.outsider = outsider.access_token;
}

const rowsIn = (outcome: ToolCallOutcome, key: 'hits' | 'items'): Array<Record<string, unknown>> =>
  (outcome.payload[key] ?? []) as Array<Record<string, unknown>>;

const idsIn = (outcome: ToolCallOutcome, key: 'hits' | 'items'): string[] =>
  rowsIn(outcome, key).map(row => String(row.id));

/** The one row with this id, failing loudly (rather than as `undefined`) if absent. */
const rowById = (
  outcome: ToolCallOutcome,
  key: 'hits' | 'items',
  id: string,
  what: string
): Record<string, unknown> => {
  const row = rowsIn(outcome, key).find(candidate => candidate.id === id);
  expect(row, what).toBeDefined();
  return row as Record<string, unknown>;
};

// ─── Without Workers AI credentials: the security matrix ────────────────────

describe.skipIf(!RUN)('content tools — visibility (no embedding credentials)', () => {
  beforeAll(async () => {
    restoreEnv = withoutWorkersAi();
    server = await startServer({ attempts: 2, retryDelayMs: 10_000 });
    await mintFixtureTokens();
  });

  it('registers all three tools on a token minted the way Ask Moji mints one', async () => {
    // NOT /dev/mint-token. That endpoint is test-only scaffolding, so a suite
    // built on it proves the three tools are reachable by a token shape no user
    // ever holds. This is the real production path — `mintMcpAccessToken`, the
    // function the webapp calls on every Ask Moji turn, writing a real
    // oauth_access_tokens row against the real Ask Moji application.
    const minted = await mintMcpAccessToken(ids.studentUser);
    mintedTokens.push(minted.accessToken); // tracked for the same teardown

    const envelope = await rpc(minted.accessToken, 'tools/list', {});
    const names = ((envelope.result?.tools ?? []) as Array<{ name: string }>).map(t => t.name);
    expect(names).toContain('content_search');
    expect(names).toContain('content_list');
    expect(names).toContain('content_get');
    // The mint is read-only by construction (ASK_MOJI_SCOPES), and the registry
    // filters at REGISTRATION rather than at call time — so a write tool is not
    // merely refused for this token, it is absent, and a model cannot be talked
    // into calling something it was never offered.
    expect(names).not.toContain('grade_add');
  });

  it('tells a caller that search is UNAVAILABLE rather than answering "no matches"', async () => {
    const outcome = await callTool(tokens.student, 'content_search', {
      classroom: CLASS_REF,
      query: 'when is the midterm?',
    });

    expect(outcome.isError).toBe(false);
    expect(outcome.payload.unavailable).toBe('embedding_not_configured');
    expect(outcome.payload.hits).toEqual([]);
    expect(String(outcome.payload.message)).toMatch(/not an empty result set/i);
  });

  it('hides an unpublished page from a student, and never tells them it exists', async () => {
    const outcome = await callTool(tokens.student, 'content_list', { classroom: CLASS_REF });

    expect(outcome.isError).toBe(false);
    const listed = idsIn(outcome, 'items');
    expect(listed).toContain(ids.publishedPage);
    expect(listed).toContain(ids.deck);
    expect(listed).toContain(FILE_DOC_ID); // bot-context: any member (D8)
    expect(listed).not.toContain(ids.draftPage);
    // Not even as a nulled field: a student is never told the column exists.
    for (const item of rowsIn(outcome, 'items')) {
      expect(Object.keys(item)).not.toContain('isDraft');
    }
  });

  it('shows staff the same page, marked as unpublished', async () => {
    const outcome = await callTool(tokens.teacher, 'content_list', { classroom: CLASS_REF });

    expect(rowById(outcome, 'items', ids.draftPage, 'a teacher must see the draft').isDraft).toBe(
      true
    );
    expect(
      rowById(outcome, 'items', ids.publishedPage, 'the published page is still listed').isDraft
    ).toBe(false);
  });

  it('refuses a draft to a student with the SAME bytes a nonexistent id gets', async () => {
    const draft = await callTool(tokens.student, 'content_get', {
      classroom: CLASS_REF,
      kind: 'page',
      id: ids.draftPage,
    });
    const bogus = await callTool(tokens.student, 'content_get', {
      classroom: CLASS_REF,
      kind: 'page',
      id: BOGUS_ID,
    });

    expectScopedNotFound(draft, 'draft page as a student');
    expectScopedNotFound(bogus, 'nonexistent id as a student');
    // Byte-identical: there is no probe channel for enumerating draft ids.
    expect(draft.payload).toEqual(bogus.payload);
  });

  it('serves the published page to a student and the draft to a teacher', async () => {
    const published = await callTool(tokens.student, 'content_get', {
      classroom: CLASS_REF,
      kind: 'page',
      id: ids.publishedPage,
    });
    expect(published.isError).toBe(false);
    expect(published.payload.indexed).toBe(true);
    expect(String(published.payload.text)).toContain('14 November');
    expect(Object.keys(published.payload)).not.toContain('isDraft');

    const draft = await callTool(tokens.teacher, 'content_get', {
      classroom: CLASS_REF,
      kind: 'page',
      id: ids.draftPage,
    });
    expect(draft.isError).toBe(false);
    expect(draft.payload.isDraft).toBe(true);
    expect(String(draft.payload.text)).toContain('key-value store');
  });

  it("refuses a non-member with 'forbidden/NOT_A_MEMBER', not a not_found", async () => {
    for (const tool of ['content_list', 'content_search', 'content_get'] as const) {
      const outcome = await callTool(tokens.outsider, tool, {
        classroom: CLASS_REF,
        ...(tool === 'content_search' ? { query: 'midterm' } : {}),
        ...(tool === 'content_get' ? { kind: 'page', id: ids.publishedPage } : {}),
      });
      expectForbidden(outcome, `${tool} as a non-member`, 'NOT_A_MEMBER');
    }
  });

  it("cannot reach another classroom's document from a classroom the caller IS in", async () => {
    const outcome = await callTool(tokens.outsider, 'content_get', {
      classroom: FOREIGN_REF,
      kind: 'page',
      id: ids.publishedPage,
    });
    expectScopedNotFound(outcome, 'cross-classroom page id');

    const bogus = await callTool(tokens.outsider, 'content_get', {
      classroom: FOREIGN_REF,
      kind: 'page',
      id: BOGUS_ID,
    });
    expect(outcome.payload).toEqual(bogus.payload);
  });

  it('refuses an UNINDEXED draft to a student before the live fallback can read it', async () => {
    // The index has nothing for this page, so content_get falls through to the
    // record — the one place the tool evaluates the predicate itself.
    const draft = await callTool(tokens.student, 'content_get', {
      classroom: CLASS_REF,
      kind: 'page',
      id: ids.unindexedDraftPage,
    });
    const bogus = await callTool(tokens.student, 'content_get', {
      classroom: CLASS_REF,
      kind: 'page',
      id: BOGUS_ID,
    });

    expectScopedNotFound(draft, 'unindexed draft page as a student');
    expect(draft.payload).toEqual(bogus.payload);
  });

  it('lists an unindexed draft to staff, marked as unindexed', async () => {
    const outcome = await callTool(tokens.teacher, 'content_list', { classroom: CLASS_REF });
    const item = rowById(
      outcome,
      'items',
      ids.unindexedDraftPage,
      'listing reads live records, not the index'
    );
    expect(item.indexed).toBe(false);
    expect(item.isDraft).toBe(true);
  });

  it('leaves no draft id anywhere in a student-visible listing of any kind', async () => {
    for (const kind of ['page', 'slide', 'file'] as const) {
      const outcome = await callTool(tokens.student, 'content_list', {
        classroom: CLASS_REF,
        kind,
      });
      expect(JSON.stringify(outcome.payload)).not.toContain(ids.draftPage);
      expect(JSON.stringify(outcome.payload)).not.toContain(ids.unindexedDraftPage);
    }
  });
});

// ─── With a stubbed embedder: search itself, credential-free ────────────────

describe.skipIf(!RUN)('content_search — end to end against a stubbed embedder', () => {
  beforeAll(async () => {
    // The previous block's server holds the port and has no credentials.
    await server?.stop();
    restoreEnv?.();
    restoreEnv = null;

    fakeEmbedder = await startFakeEmbedder();
    // The stub reaches the SERVER only. This process stays unconfigured, so
    // nothing here can leak back into the unconfigured block above.
    server = await startServer({
      attempts: 2,
      retryDelayMs: 10_000,
      env: {
        [BASE_URL_ENV]: fakeEmbedder.url,
        CLOUDFLARE_ACCOUNT_ID: FAKE_ACCOUNT_ID,
        CLOUDFLARE_WORKERS_AI_TOKEN: FAKE_TOKEN,
      },
    });
    await mintFixtureTokens();
  });

  afterAll(async () => {
    await fakeEmbedder?.close();
    fakeEmbedder = null;
  });

  const search = (token: string, query: string) =>
    callTool(token, 'content_search', { classroom: CLASS_REF, query, limit: 20 });

  it('actually runs a search — the stub was called, and nothing is unavailable', async () => {
    const before = fakeEmbedder?.calls() ?? 0;

    const outcome = await search(tokens.student, 'when is the midterm?');

    expect(outcome.isError).toBe(false);
    // The distinction the `unavailable` marker exists to carry: this is a real
    // result set, not retrieval quietly failing open into an empty one.
    expect(outcome.payload.unavailable).toBeUndefined();
    expect(fakeEmbedder?.calls()).toBe(before + 1);
    // And the stub's vector genuinely drove the ranking: the page whose index
    // row carries the same basis vector is at distance 0, everything else at 1.
    expect(idsIn(outcome, 'hits')[0]).toBe(ids.publishedPage);
  });

  it("keeps an unpublished page out of a student's results entirely (§7.3 #1)", async () => {
    const outcome = await search(tokens.student, 'when is the midterm?');

    expect(idsIn(outcome, 'hits')).toContain(ids.publishedPage);
    // The whole point: not the id, not the title, not a snippet of it.
    expect(JSON.stringify(outcome.payload)).not.toContain(ids.draftPage);
    expect(JSON.stringify(outcome.payload)).not.toContain('key-value store');
    for (const hit of rowsIn(outcome, 'hits')) {
      expect(Object.keys(hit)).not.toContain('isDraft');
    }
  });

  it('hides the draft even from a query aimed straight at it', async () => {
    // 'capstone' embeds to the DRAFT's own basis vector, so the draft is the
    // single nearest row in the corpus. A visibility bug would be maximally
    // visible here, and the student must still never see it.
    const outcome = await search(tokens.student, 'what is the capstone final project?');

    expect(outcome.isError).toBe(false);
    expect(JSON.stringify(outcome.payload)).not.toContain(ids.draftPage);
    expect(JSON.stringify(outcome.payload)).not.toContain('key-value store');

    const staff = await search(tokens.teacher, 'what is the capstone final project?');
    expect(idsIn(staff, 'hits')[0]).toBe(ids.draftPage);
  });

  it('returns it to a teacher, marked as unpublished (§7.3 #2)', async () => {
    const outcome = await search(tokens.teacher, 'when is the midterm?');

    expect(rowById(outcome, 'hits', ids.draftPage, 'a teacher must reach the draft').isDraft).toBe(
      true
    );
    expect(
      rowById(outcome, 'hits', ids.publishedPage, 'the published page is still ranked').isDraft
    ).toBe(false);
  });

  it('gives an ASSISTANT exactly what it gives a TEACHER (D2 parity, §7.3 #3)', async () => {
    const assistant = await search(tokens.assistant, 'when is the midterm?');
    const teacher = await search(tokens.teacher, 'when is the midterm?');

    expect(
      rowById(assistant, 'hits', ids.draftPage, 'an assistant must reach the draft').isDraft
    ).toBe(true);
    // Same documents, same order: an assistant prepares material alongside the
    // teacher, so "staff" here cannot quietly mean TEACHER only.
    expect(idsIn(assistant, 'hits')).toEqual(idsIn(teacher, 'hits'));
  });

  it('answers a classroom with nothing indexed as an EMPTY result, not as unavailable', async () => {
    // The contrast the `unavailable` marker exists to draw, now reachable from
    // BOTH sides on a credential-free machine. The outsider is a real member of
    // the foreign classroom, which has no content_index rows at all: zero hits
    // and no `unavailable` field means "the course has nothing"; the identical
    // zero hits WITH one (block 1) means "retrieval never ran".
    const outcome = await callTool(tokens.outsider, 'content_search', {
      classroom: FOREIGN_REF,
      query: 'when is the midterm?',
    });

    expect(outcome.isError).toBe(false);
    expect(outcome.payload.unavailable).toBeUndefined();
    expect(outcome.payload.count).toBe(0);
    expect(outcome.payload.hits).toEqual([]);
  });

  // ── scope: 'docs' — the SECOND corpus, end to end ─────────────────────────

  const searchDocsAs = (token: string, query: string) =>
    callTool(token, 'content_search', { classroom: CLASS_REF, query, scope: 'docs', limit: 20 });

  it('answers a documentation question for a STUDENT with a real, non-empty result', async () => {
    const outcome = await searchDocsAs(tokens.student, 'where do I add a teaching assistant?');

    expect(outcome.isError).toBe(false);
    expect(outcome.payload.unavailable).toBeUndefined();
    // NON-EMPTY, asserted on its own. "the two roles agree" is satisfied by two
    // empty lists and by two identical errors, so agreement alone proves
    // nothing about retrieval having worked.
    expect(Number(outcome.payload.count)).toBeGreaterThan(0);
    expect(idsIn(outcome, 'hits')[0]).toBe(DOCS_SLUG);

    const hit = rowById(outcome, 'hits', DOCS_SLUG, 'the docs fixture must be the top hit');
    expect(hit.kind).toBe('doc');
    expect(hit.section).toBe('instructors');
    expect(hit.url).toBe(`https://classmoji.io/${DOCS_SLUG}`);
  });

  it('gives a TEACHER exactly the same documentation, non-empty', async () => {
    // Documentation is public and fleet-wide: unlike course content there is no
    // role tier here at all, and that has to be shown on a result set that
    // actually contains something.
    const student = await searchDocsAs(tokens.student, 'where do I add a teaching assistant?');
    const teacher = await searchDocsAs(tokens.teacher, 'where do I add a teaching assistant?');

    expect(Number(student.payload.count)).toBeGreaterThan(0);
    expect(Number(teacher.payload.count)).toBeGreaterThan(0);
    expect(idsIn(teacher, 'hits')).toEqual(idsIn(student, 'hits'));
    expect(idsIn(teacher, 'hits')).toContain(DOCS_SLUG);
  });

  it('keeps the two corpora apart in BOTH directions', async () => {
    // A docs search must not reach this classroom's pages…
    const docs = await searchDocsAs(tokens.teacher, 'where do I add a teaching assistant?');
    const docsPayload = JSON.stringify(docs.payload);
    expect(docsPayload).not.toContain(ids.publishedPage);
    expect(docsPayload).not.toContain(ids.draftPage);
    expect(docsPayload).not.toContain(FILE_DOC_ID);

    // …and a course search must not reach the documentation.
    const course = await callTool(tokens.teacher, 'content_search', {
      classroom: CLASS_REF,
      query: 'where do I add a teaching assistant?',
      limit: 20,
    });
    expect(JSON.stringify(course.payload)).not.toContain(DOCS_SLUG);
    expect(JSON.stringify(course.payload)).not.toContain(DOCS_CODE_SENTINEL);
  });

  it('reads a documentation page in full through content_get, code identifiers intact', async () => {
    const outcome = await callTool(tokens.student, 'content_get', {
      classroom: CLASS_REF,
      kind: 'doc',
      id: DOCS_SLUG,
    });

    expect(outcome.isError).toBe(false);
    expect(outcome.payload.kind).toBe('doc');
    expect(outcome.payload.id).toBe(DOCS_SLUG);
    expect(outcome.payload.url).toBe(`https://classmoji.io/${DOCS_SLUG}`);
    expect(String(outcome.payload.text)).toContain('New staff member');
    // The whole extractor contract, checked at the far end of the pipe: an
    // underscored identifier still reads as itself after indexing, storage and
    // retrieval.
    expect(String(outcome.payload.text)).toContain(DOCS_CODE_SENTINEL);
  });

  it('lists the documentation under scope: docs, with real URLs', async () => {
    const outcome = await callTool(tokens.student, 'content_list', {
      classroom: CLASS_REF,
      scope: 'docs',
      limit: 200,
    });

    expect(outcome.isError).toBe(false);
    expect(idsIn(outcome, 'items')).toContain(DOCS_SLUG);
    const row = rowById(outcome, 'items', DOCS_SLUG, 'the docs fixture must be listed');
    expect(row.kind).toBe('doc');
    expect(row.url).toBe(`https://classmoji.io/${DOCS_SLUG}`);
  });

  it("refuses `kind` together with scope: 'docs' rather than ignoring one", async () => {
    const outcome = await callTool(tokens.student, 'content_search', {
      classroom: CLASS_REF,
      query: 'where do I add a teaching assistant?',
      scope: 'docs',
      kind: 'page',
    });

    expect(outcome.isError).toBe(true);
    expect(JSON.stringify(outcome.payload)).toMatch(/invalid_params/);
  });

  it('refuses a NON-MEMBER a documentation search, exactly as it refuses a course one', async () => {
    // Global corpus, not a global door. Membership in the supplied classroom is
    // still what gets you in.
    const outcome = await callTool(tokens.outsider, 'content_search', {
      classroom: CLASS_REF,
      query: 'where do I add a teaching assistant?',
      scope: 'docs',
    });
    expectForbidden(outcome, "content_search scope:'docs' as a non-member", 'NOT_A_MEMBER');
  });

  it("still refuses a non-member with 'forbidden/NOT_A_MEMBER' before embedding anything", async () => {
    const before = fakeEmbedder?.calls() ?? 0;

    const outcome = await callTool(tokens.outsider, 'content_search', {
      classroom: CLASS_REF,
      query: 'when is the midterm?',
    });

    expectForbidden(outcome, 'content_search as a non-member', 'NOT_A_MEMBER');
    // The gate runs in the registry, before the handler — a stranger's question
    // is never even sent to the embedding service.
    expect(fakeEmbedder?.calls()).toBe(before);
  });
});

// ─── With Workers AI credentials: the real endpoint ─────────────────────────

describe.skipIf(!RUN || !HAS_WORKERS_AI)('content_search — through real retrieval', () => {
  beforeAll(async () => {
    // The previous block's server holds the port and is pointed at the stub.
    await server?.stop();
    await fakeEmbedder?.close();
    fakeEmbedder = null;
    restoreEnv?.();
    restoreEnv = null;
    server = await startServer({ attempts: 2, retryDelayMs: 10_000 });
    await mintFixtureTokens();
  });

  it("keeps an unpublished page out of a student's results entirely", async () => {
    const outcome = await callTool(tokens.student, 'content_search', {
      classroom: CLASS_REF,
      query: 'when is the midterm?',
      limit: 20,
    });

    expect(outcome.isError).toBe(false);
    expect(outcome.payload.unavailable).toBeUndefined();
    expect(idsIn(outcome, 'hits')).toContain(ids.publishedPage);
    // The whole point: not the id, not the title, not a snippet of it.
    expect(JSON.stringify(outcome.payload)).not.toContain(ids.draftPage);
    expect(JSON.stringify(outcome.payload)).not.toContain('key-value store');
    for (const hit of rowsIn(outcome, 'hits')) {
      expect(Object.keys(hit)).not.toContain('isDraft');
    }
  });

  it('returns it to a teacher, marked as unpublished', async () => {
    const outcome = await callTool(tokens.teacher, 'content_search', {
      classroom: CLASS_REF,
      query: 'when is the midterm?',
      limit: 20,
    });

    expect(rowById(outcome, 'hits', ids.draftPage, 'a teacher must reach the draft').isDraft).toBe(
      true
    );
  });
});
