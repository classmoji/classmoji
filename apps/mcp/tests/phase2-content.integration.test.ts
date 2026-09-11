/**
 * The security tests of the content phase, end to end (plan §5.7 / §7.3).
 *
 * Real Postgres, a real spawned MCP server, real OAuth bearer tokens, the real
 * registry pipeline. What a student's token can reach through `content_search`
 * / `content_list` / `content_get` is decided here by the gate, not by a
 * handler remembering to check something.
 *
 * NO LIVE CREDENTIALS ARE REQUIRED (review finding 17). Every scenario that
 * decides who may see what runs against a server started with Workers AI
 * DELIBERATELY UNCONFIGURED, and rides `content_list` / `content_get`, which
 * need no embeddings and go through exactly the same visibility predicate as
 * search. That also makes the "search is unavailable" case reachable on demand
 * instead of only when someone's token happens to be missing. The second block
 * — search itself, with a configured server — is additive, skips without
 * credentials, and is still deterministic: the fixture vectors are unit basis
 * vectors and the limit is wider than the corpus, so WHICH documents come back
 * is decided by the permission join rather than by embedding quality.
 *
 * SAFETY: every fixture hangs off ONE throwaway GitOrganization under a fresh
 * uuid namespace, and teardown deletes that organization — cascading its
 * classrooms, pages, slides, memberships and content_index rows — plus the
 * three fixture users and the tokens this run minted. Nothing pre-existing is
 * read or written, and nothing is truncated.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import {
  callTool,
  deleteMintedTokens,
  expectForbidden,
  expectScopedNotFound,
  getPrisma,
  mintToken,
  rpc,
  startServer,
  type ServerHandle,
  type ToolCallOutcome,
} from './helpers.ts';

// Deferred for the same reason helpers.ts defers `@classmoji/database`: this
// module pulls the database package in, and the .env load inside helpers has to
// have happened before the Prisma client is constructed.
const { toVectorLiteral, EMBEDDING_DIMENSIONS } = await import('@classmoji/services');

// These suites CREATE rows, so they run only against a local database.
const DATABASE_URL = process.env.DATABASE_URL ?? '';
const RUN = /@(localhost|127\.0\.0\.1)[:/]/.test(DATABASE_URL);

const WORKERS_AI_VARS = ['CLOUDFLARE_WORKERS_AI_TOKEN', 'CLOUDFLARE_ACCOUNT_ID'] as const;
const HAS_WORKERS_AI = WORKERS_AI_VARS.every(name => Boolean(process.env[name]));

/**
 * Remove the Workers AI credentials from THIS process's env so the server
 * `startServer` spawns (it inherits `process.env`) comes up unconfigured.
 * Returns the restore function.
 */
function withoutWorkersAi(): () => void {
  const saved = new Map<string, string | undefined>();
  for (const name of WORKERS_AI_VARS) {
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

// ─── Fixtures ───────────────────────────────────────────────────────────────

const ns = randomUUID().slice(0, 8);
const ORG_LOGIN = `p27-org-${ns}`;
const CLASS_SLUG = `p27-${ns}-a`;
const FOREIGN_SLUG = `p27-${ns}-b`;
const CLASS_REF = `${ORG_LOGIN}/${CLASS_SLUG}`;
const FOREIGN_REF = `${ORG_LOGIN}/${FOREIGN_SLUG}`;
const FILE_DOC_ID = 'bot-context/office-hours.md';
const BOGUS_ID = '00000000-0000-4000-8000-00000000dead';

const LOGINS = {
  teacher: `p27-teacher-${ns}`,
  student: `p27-student-${ns}`,
  outsider: `p27-outsider-${ns}`,
};

const ids = {
  org: '',
  classroom: '',
  foreign: '',
  author: '',
  publishedPage: '',
  draftPage: '',
  unindexedDraftPage: '',
  deck: '',
};

const tokens = { teacher: '', student: '', outsider: '' };

let server: ServerHandle | null = null;
let restoreEnv: (() => void) | null = null;

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
  const [teacherUser, studentUser, outsiderUser] = users;
  ids.author = teacherUser.id;

  ids.classroom = await createClassroom(CLASS_SLUG);
  ids.foreign = await createClassroom(FOREIGN_SLUG);

  await prisma.classroomMembership.createMany({
    data: [
      { classroom_id: ids.classroom, user_id: teacherUser.id, role: 'TEACHER' },
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
});

afterAll(async () => {
  if (!RUN) return;
  await server?.stop();
  restoreEnv?.();
  const prisma = getPrisma();
  await deleteMintedTokens();
  if (ids.org) await prisma.gitOrganization.delete({ where: { id: ids.org } });
  await prisma.user.deleteMany({ where: { login: { in: Object.values(LOGINS) } } });
});

/** Mint one read+write token per fixture identity against the running server. */
async function mintFixtureTokens(): Promise<void> {
  const [teacher, student, outsider] = await Promise.all([
    mintToken({ login: LOGINS.teacher, scopes: ['read'] }),
    mintToken({ login: LOGINS.student, scopes: ['read'] }),
    mintToken({ login: LOGINS.outsider, scopes: ['read'] }),
  ]);
  tokens.teacher = teacher.access_token;
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

  it('registers all three tools on a read-scoped token', async () => {
    const envelope = await rpc(tokens.student, 'tools/list', {});
    const names = ((envelope.result?.tools ?? []) as Array<{ name: string }>).map(t => t.name);
    expect(names).toContain('content_search');
    expect(names).toContain('content_list');
    expect(names).toContain('content_get');
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

// ─── With Workers AI credentials: search itself ─────────────────────────────

describe.skipIf(!RUN || !HAS_WORKERS_AI)('content_search — through real retrieval', () => {
  beforeAll(async () => {
    // The previous block's server holds the port and has no credentials.
    await server?.stop();
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
