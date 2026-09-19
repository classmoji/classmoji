/**
 * contentSearch.service against a REAL Postgres with pgvector.
 *
 * These are the security tests of the content phase, so they must not be able
 * to pass for the wrong reason. Two consequences shape this file:
 *
 *   - NO MOCKS. The thing under test is a SQL statement; a fake Prisma would
 *     agree with whatever the service asked for, including a leak.
 *   - NO LIVE EMBEDDING CALLS. Every vector here is a unit basis vector built
 *     locally, so cosine distance is exactly 0 (identical) or exactly 1
 *     (orthogonal) and every ordering assertion is deterministic. The suite
 *     never needs Workers AI credentials and cannot fail because they expired.
 *
 * SAFETY: every fixture is namespaced with a fresh uuid under ONE throwaway
 * GitOrganization, and afterAll deletes that organization — which cascades
 * classrooms → pages/slides/content_index — plus the two fixture users.
 * Nothing is truncated and no pre-existing row is read or written.
 *
 * Unlike the other integration suites here this one does NOT refuse the shared
 * dev database by name: `content_index` currently exists only on the local
 * `classmoji` database this worktree's .env points at, and a suite that always
 * skips proves nothing. The uuid namespacing plus the single cascading delete
 * is what makes that safe.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';

import getPrisma from '@classmoji/database';
import {
  contentVisibility,
  searchContent,
  listContent,
  getContentText,
  toVectorLiteral,
  ContentNotFoundError,
  EMBEDDING_DIMENSIONS,
  MAX_SEARCH_LIMIT,
  DEFAULT_LIST_LIMIT,
  MAX_LIST_LIMIT,
  type ContentViewerRole,
} from '../contentSearch.service.ts';

const DATABASE_URL = process.env.DATABASE_URL ?? '';
const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(DATABASE_URL);
const RUN = Boolean(DATABASE_URL) && isLocal;

// ─── Deterministic vectors ─────────────────────────────────────────────────

/** The i-th unit basis vector. Distance to itself 0, to any other exactly 1. */
const basis = (index: number): number[] => {
  const vector = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
  vector[index] = 1;
  return vector;
};

const V = {
  publishedPage: basis(0),
  draftPage: basis(1),
  publicPage: basis(2),
  draftPublicPage: basis(3),
  deckChunk0: basis(4),
  deckChunk1: basis(5),
  deckChunk2: basis(6),
  draftDeck: basis(7),
  file: basis(8),
  noVectorPage: basis(9), // never stored; only used to show the row cannot match
  misIndexed: basis(10),
} as const;

// ─── Fixture ids ───────────────────────────────────────────────────────────

const ns = randomUUID().slice(0, 8);
const ids = {
  org: '',
  classroomA: '',
  classroomB: '',
  author: '',
  publishedPage: '',
  draftPage: '',
  publicPage: '',
  draftPublicPage: '',
  unindexedPage: '',
  noVectorPage: '',
  deck: '',
  draftDeck: '',
  otherClassroomPage: '',
};

const FILE_DOC_ID = 'bot-context/office-hours.md';
const OTHER_FILE_DOC_ID = 'bot-context/other-classroom.md';

// ─── Fixture helpers ───────────────────────────────────────────────────────

const insertIndexRow = async (args: {
  classroomId: string;
  docKind: 'page' | 'slide' | 'file';
  docId: string;
  chunkIx?: number;
  chunkCount?: number;
  title: string;
  text: string;
  vector: number[] | null;
  sourcePath?: string;
}): Promise<void> => {
  const embedding = args.vector
    ? Prisma.sql`${toVectorLiteral(args.vector)}::vector`
    : Prisma.sql`NULL::vector`;

  await getPrisma().$executeRaw`
    INSERT INTO content_index (
      classroom_id, doc_kind, doc_id, chunk_ix, chunk_count,
      source_path, source_sha, extract_version, embed_model,
      title, text, embedding
    ) VALUES (
      ${args.classroomId}, ${args.docKind}, ${args.docId},
      ${args.chunkIx ?? 0}, ${args.chunkCount ?? 1},
      ${args.sourcePath ?? `pages/${args.docId}/content.json`}, ${'sha-' + ns}, 1,
      ${'@cf/qwen/qwen3-embedding-0.6b'},
      ${args.title}, ${args.text}, ${embedding}
    )`;
};

const createPage = async (args: {
  classroomId: string;
  title: string;
  isDraft: boolean;
  isPublic: boolean;
}): Promise<string> => {
  const page = await getPrisma().page.create({
    data: {
      classroom_id: args.classroomId,
      title: args.title,
      slug: args.title.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
      content_path: `pages/${args.title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
      created_by: ids.author,
      is_draft: args.isDraft,
      is_public: args.isPublic,
    },
  });
  return page.id;
};

const createSlide = async (args: {
  classroomId: string;
  title: string;
  isDraft: boolean;
  isPublic: boolean;
}): Promise<string> => {
  const slug = args.title.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const slide = await getPrisma().slide.create({
    data: {
      classroom_id: args.classroomId,
      title: args.title,
      slug,
      content_path: `slides/${slug}`,
      created_by: ids.author,
      is_draft: args.isDraft,
      is_public: args.isPublic,
    },
  });
  return slide.id;
};

const createClassroom = async (suffix: string): Promise<string> => {
  const classroom = await getPrisma().classroom.create({
    data: {
      slug: `p26-${ns}-${suffix}`,
      git_org_id: ids.org,
      name: `P2-6 fixture ${suffix}`,
      content_namespace: `p26-${ns}-${suffix}`,
      content_repo: `content-p26-${ns}-${suffix}`,
    },
  });
  return classroom.id;
};

// ─── Viewers ───────────────────────────────────────────────────────────────

const STUDENT: ContentViewerRole = 'STUDENT';
const ASSISTANT: ContentViewerRole = 'ASSISTANT';
const TEACHER: ContentViewerRole = 'TEACHER';
const OWNER: ContentViewerRole = 'OWNER';
const OUTSIDER: ContentViewerRole = null;

const search = (role: ContentViewerRole, queryVector: number[], extra: object = {}) =>
  searchContent({
    classroomId: ids.classroomA,
    role,
    queryVector,
    limit: MAX_SEARCH_LIMIT,
    ...extra,
  });

const idsOf = (hits: Array<{ docId: string }>): string[] => hits.map(hit => hit.docId);

/** `listContent`'s rows alone, for the assertions that are about visibility. */
const listItems = async (args: Parameters<typeof listContent>[0]) =>
  (await listContent(args)).items;

// ─── Setup / teardown ──────────────────────────────────────────────────────

beforeAll(async () => {
  if (!RUN) return;

  const org = await getPrisma().gitOrganization.create({
    data: { provider: 'GITHUB', provider_id: `p26-${ns}`, login: `p26-org-${ns}` },
  });
  ids.org = org.id;

  const author = await getPrisma().user.create({
    data: { login: `p26-author-${ns}`, email: `p26-author-${ns}@example.test`, name: 'Fixture' },
  });
  ids.author = author.id;

  ids.classroomA = await createClassroom('a');
  ids.classroomB = await createClassroom('b');

  // ── Classroom A: the corpus under test ──────────────────────────────────
  ids.publishedPage = await createPage({
    classroomId: ids.classroomA,
    title: `Assessment Schedule ${ns}`,
    isDraft: false,
    isPublic: false,
  });
  ids.draftPage = await createPage({
    classroomId: ids.classroomA,
    title: `Unreleased Final Project ${ns}`,
    isDraft: true,
    isPublic: false,
  });
  ids.publicPage = await createPage({
    classroomId: ids.classroomA,
    title: `Public Syllabus ${ns}`,
    isDraft: false,
    isPublic: true,
  });
  // Representable, and the admin UI never writes it: draft AND public.
  // Both live implementations resolve this pair to HIDDEN.
  ids.draftPublicPage = await createPage({
    classroomId: ids.classroomA,
    title: `Draft And Public ${ns}`,
    isDraft: true,
    isPublic: true,
  });
  // Live but never indexed — listContent must still find it.
  ids.unindexedPage = await createPage({
    classroomId: ids.classroomA,
    title: `Never Indexed ${ns}`,
    isDraft: false,
    isPublic: false,
  });
  // Indexed but the embedding call had not succeeded yet.
  ids.noVectorPage = await createPage({
    classroomId: ids.classroomA,
    title: `Awaiting Embedding ${ns}`,
    isDraft: false,
    isPublic: false,
  });
  ids.deck = await createSlide({
    classroomId: ids.classroomA,
    title: `Recursion Deck ${ns}`,
    isDraft: false,
    isPublic: false,
  });
  ids.draftDeck = await createSlide({
    classroomId: ids.classroomA,
    title: `Draft Deck ${ns}`,
    isDraft: true,
    isPublic: false,
  });

  await insertIndexRow({
    classroomId: ids.classroomA,
    docKind: 'page',
    docId: ids.publishedPage,
    title: 'Assessment Schedule',
    text: 'The midterm is on 14 November in the usual room.',
    vector: V.publishedPage,
  });
  await insertIndexRow({
    classroomId: ids.classroomA,
    docKind: 'page',
    docId: ids.draftPage,
    title: 'Unreleased Final Project',
    text: 'Build a key-value store with a write-ahead log.',
    vector: V.draftPage,
  });
  await insertIndexRow({
    classroomId: ids.classroomA,
    docKind: 'page',
    docId: ids.publicPage,
    title: 'Public Syllabus',
    text: 'Anyone may read this syllabus, member or not.',
    vector: V.publicPage,
  });
  await insertIndexRow({
    classroomId: ids.classroomA,
    docKind: 'page',
    docId: ids.draftPublicPage,
    title: 'Draft And Public',
    text: 'Draft and public at once — still hidden from students.',
    vector: V.draftPublicPage,
  });
  await insertIndexRow({
    classroomId: ids.classroomA,
    docKind: 'page',
    docId: ids.noVectorPage,
    title: 'Awaiting Embedding',
    text: 'Indexed, but the embedding call had not returned yet.',
    vector: null,
  });

  // A deck the extractor had to chunk. Chunk 1 is the one that answers.
  const deckChunks = [
    { ix: 0, vector: V.deckChunk0, text: 'Deck chunk zero: administrivia.' },
    { ix: 1, vector: V.deckChunk1, text: 'Deck chunk one: the base case is what stops it.' },
    { ix: 2, vector: V.deckChunk2, text: 'Deck chunk two: worked example.' },
  ];
  for (const chunk of deckChunks) {
    await insertIndexRow({
      classroomId: ids.classroomA,
      docKind: 'slide',
      docId: ids.deck,
      chunkIx: chunk.ix,
      chunkCount: 3,
      title: 'Recursion Deck',
      text: chunk.text,
      vector: chunk.vector,
      sourcePath: 'slides/recursion-deck/index.html',
    });
  }
  await insertIndexRow({
    classroomId: ids.classroomA,
    docKind: 'slide',
    docId: ids.draftDeck,
    title: 'Draft Deck',
    text: 'An unfinished deck.',
    vector: V.draftDeck,
    sourcePath: 'slides/draft-deck/index.html',
  });
  await insertIndexRow({
    classroomId: ids.classroomA,
    docKind: 'file',
    docId: FILE_DOC_ID,
    title: 'Office hours',
    text: 'Office hours are Tuesdays at four.',
    vector: V.file,
    sourcePath: FILE_DOC_ID,
  });

  // ── Classroom B: the other tenant. Its vectors are IDENTICAL to A's, so
  //    any statement that loses its classroom filter surfaces them first. ──
  ids.otherClassroomPage = await createPage({
    classroomId: ids.classroomB,
    title: `Other Classroom Page ${ns}`,
    isDraft: false,
    isPublic: true,
  });
  await insertIndexRow({
    classroomId: ids.classroomB,
    docKind: 'page',
    docId: ids.otherClassroomPage,
    title: 'Other Classroom Page',
    text: 'Another tenant. This must never be reachable from classroom A.',
    vector: V.publishedPage,
  });
  await insertIndexRow({
    classroomId: ids.classroomB,
    docKind: 'file',
    docId: OTHER_FILE_DOC_ID,
    title: 'Other classroom file',
    text: 'Another tenant, file flavour.',
    vector: V.file,
    sourcePath: OTHER_FILE_DOC_ID,
  });

  // A MIS-INDEXED row: it sits in classroom A but names classroom B's page.
  // An index row is derived data and must never be what decides tenancy, so the
  // joins restate `classroom_id` on the live record. Without that restatement
  // this row would join to B's page and leak it into A's results.
  await insertIndexRow({
    classroomId: ids.classroomA,
    docKind: 'page',
    docId: ids.otherClassroomPage,
    title: 'Mis-indexed row',
    text: 'This index row points at another classroom page.',
    vector: V.misIndexed,
  });
}, 60_000);

afterAll(async () => {
  if (!RUN || !ids.org) return;
  // Cascades: git_organizations → classrooms → pages/slides/content_index.
  await getPrisma().gitOrganization.delete({ where: { id: ids.org } });
  if (ids.author) await getPrisma().user.delete({ where: { id: ids.author } });
});

// ─── The visibility builder ────────────────────────────────────────────────

const ROLES: ContentViewerRole[] = [OWNER, TEACHER, ASSISTANT, STUDENT, OUTSIDER];
const FLAG_PAIRS = [
  { is_draft: false, is_public: false },
  { is_draft: false, is_public: true },
  { is_draft: true, is_public: false },
  { is_draft: true, is_public: true },
];

describe('contentVisibility (pure)', () => {
  it('matches the pages-app rule for every role and flag pair', () => {
    const expected = (
      role: ContentViewerRole,
      flags: { is_draft: boolean; is_public: boolean }
    ) => {
      const staff = role === 'OWNER' || role === 'TEACHER' || role === 'ASSISTANT';
      const member = role !== null;
      return (!flags.is_draft || staff) && (flags.is_public || member);
    };

    for (const role of ROLES) {
      const visibility = contentVisibility(role);
      for (const flags of FLAG_PAIRS) {
        expect({ role, ...flags, visible: visibility.allows(flags) }).toEqual({
          role,
          ...flags,
          visible: expected(role, flags),
        });
      }
    }
  });

  it('hides a row that is BOTH draft and public from a student', () => {
    expect(contentVisibility(STUDENT).allows({ is_draft: true, is_public: true })).toBe(false);
    expect(contentVisibility(ASSISTANT).allows({ is_draft: true, is_public: true })).toBe(true);
  });

  it('shows file rows to any member and to no outsider', () => {
    expect(contentVisibility(STUDENT).allowsFiles).toBe(true);
    expect(contentVisibility(OWNER).allowsFiles).toBe(true);
    expect(contentVisibility(OUTSIDER).allowsFiles).toBe(false);
  });

  it('refuses an unsafe SQL alias', () => {
    expect(() => contentVisibility(STUDENT).sql('p; DROP TABLE pages --')).toThrow(
      /unsafe SQL identifier/
    );
  });
});

describe.skipIf(!RUN)('contentVisibility — SQL and TypeScript agree', () => {
  /**
   * The anti-drift test. The rule is written once and rendered twice; this
   * evaluates BOTH renderings over the whole role × flag matrix and requires
   * them to return the same answer every time. Change one rendering without
   * the other and this fails on the first disagreeing cell.
   */
  it('returns the same verdict in Postgres as in JavaScript', async () => {
    for (const role of ROLES) {
      const visibility = contentVisibility(role);
      for (const flags of FLAG_PAIRS) {
        const [row] = await getPrisma().$queryRaw<Array<{ visible: boolean }>>`
          SELECT ${visibility.sql('p')} AS visible
          FROM (SELECT ${flags.is_draft}::boolean AS is_draft,
                       ${flags.is_public}::boolean AS is_public) AS p`;
        expect({ role, ...flags, sql: row.visible }).toEqual({
          role,
          ...flags,
          sql: visibility.allows(flags),
        });
      }
    }
  });
});

// ─── searchContent ─────────────────────────────────────────────────────────

describe.skipIf(!RUN)('searchContent', () => {
  it('finds a published page for every member role', async () => {
    for (const role of [STUDENT, ASSISTANT, TEACHER, OWNER] as ContentViewerRole[]) {
      const hits = await search(role, V.publishedPage);
      expect(idsOf(hits)).toContain(ids.publishedPage);
      expect(hits[0].docId).toBe(ids.publishedPage);
      expect(hits[0].score).toBeCloseTo(1, 6);
      expect(hits[0].title).toBe('Assessment Schedule');
    }
  });

  it('finds a draft page for staff only', async () => {
    for (const role of [ASSISTANT, TEACHER, OWNER] as ContentViewerRole[]) {
      expect(idsOf(await search(role, V.draftPage))).toContain(ids.draftPage);
    }
    expect(idsOf(await search(STUDENT, V.draftPage))).not.toContain(ids.draftPage);
    expect(idsOf(await search(OUTSIDER, V.draftPage))).not.toContain(ids.draftPage);
  });

  it('hides a draft-and-public page from a student and shows it to staff', async () => {
    expect(idsOf(await search(STUDENT, V.draftPublicPage))).not.toContain(ids.draftPublicPage);
    expect(idsOf(await search(TEACHER, V.draftPublicPage))).toContain(ids.draftPublicPage);
  });

  it('reports is_draft to staff and never to anyone else', async () => {
    const staffHits = await search(TEACHER, V.draftPage);
    const draftHit = staffHits.find(hit => hit.docId === ids.draftPage);
    expect(draftHit?.isDraft).toBe(true);
    expect(staffHits.find(hit => hit.docId === ids.publishedPage)?.isDraft).toBe(false);

    for (const role of [STUDENT, OUTSIDER] as ContentViewerRole[]) {
      const hits = await search(role, V.publishedPage);
      expect(hits.length).toBeGreaterThan(0);
      expect(hits.every(hit => hit.isDraft === null)).toBe(true);
    }
  });

  it('returns a chunked deck once, at its best chunk', async () => {
    const hits = await search(STUDENT, V.deckChunk1);
    const deckHits = hits.filter(hit => hit.docId === ids.deck);
    expect(deckHits).toHaveLength(1);
    expect(deckHits[0].chunkIx).toBe(1);
    expect(deckHits[0].snippet).toContain('base case');
    expect(deckHits[0].score).toBeCloseTo(1, 6);
    expect(hits[0].docId).toBe(ids.deck);
  });

  it('finds a file row for members and hides it from a non-member', async () => {
    for (const role of [STUDENT, ASSISTANT, OWNER] as ContentViewerRole[]) {
      const hits = await search(role, V.file);
      expect(idsOf(hits)).toContain(FILE_DOC_ID);
      expect(hits.find(hit => hit.docId === FILE_DOC_ID)?.docKind).toBe('file');
    }
    expect(idsOf(await search(OUTSIDER, V.file))).not.toContain(FILE_DOC_ID);
  });

  it('never returns another classroom rows, even when they are the closest', async () => {
    // Classroom B holds a row whose vector is IDENTICAL to the query, so a lost
    // classroom filter puts it first. Run as OWNER: the most privileged viewer.
    const hits = await search(OWNER, V.publishedPage);
    expect(idsOf(hits)).not.toContain(ids.otherClassroomPage);
    expect(idsOf(hits)).not.toContain(OTHER_FILE_DOC_ID);

    const fileHits = await search(OWNER, V.file);
    expect(idsOf(fileHits)).not.toContain(OTHER_FILE_DOC_ID);
    expect(idsOf(fileHits)).toContain(FILE_DOC_ID);
  });

  it('does not let an index row decide which classroom a document is in', async () => {
    // Classroom A holds an index row naming classroom B's page, and its vector
    // is an exact match. Only the restated `p.classroom_id` on the join keeps
    // it out.
    const hits = await search(OWNER, V.misIndexed);
    expect(idsOf(hits)).not.toContain(ids.otherClassroomPage);
    expect(hits.every(hit => hit.title !== 'Mis-indexed row')).toBe(true);
  });

  it('honours the kind filter', async () => {
    const pages = await search(OWNER, V.publishedPage, { kind: 'page' });
    expect(pages.every(hit => hit.docKind === 'page')).toBe(true);
    expect(idsOf(pages)).toContain(ids.publishedPage);

    const slides = await search(OWNER, V.deckChunk1, { kind: 'slide' });
    expect(slides.every(hit => hit.docKind === 'slide')).toBe(true);
    expect(idsOf(slides)).toContain(ids.deck);
    expect(idsOf(slides)).not.toContain(ids.publishedPage);

    const files = await search(OWNER, V.file, { kind: 'file' });
    expect(files.map(hit => hit.docKind)).toEqual(['file']);
    expect(idsOf(files)).toEqual([FILE_DOC_ID]);
  });

  it('skips rows that have no embedding yet', async () => {
    const hits = await search(OWNER, V.noVectorPage);
    expect(idsOf(hits)).not.toContain(ids.noVectorPage);
  });

  it('gives a non-member only published, public documents', async () => {
    const hits = await search(OUTSIDER, V.publicPage);
    expect(idsOf(hits)).toEqual([ids.publicPage]);
  });

  it('caps the limit and bounds the snippet', async () => {
    const hits = await search(OWNER, V.publishedPage, { limit: 500 });
    expect(hits.length).toBeLessThanOrEqual(MAX_SEARCH_LIMIT);
    expect(hits.every(hit => hit.snippet.length <= 400)).toBe(true);

    const one = await search(OWNER, V.publishedPage, { limit: 1 });
    expect(one).toHaveLength(1);
    expect(one[0].docId).toBe(ids.publishedPage);
  });

  it('rejects a malformed query vector before it reaches the database', async () => {
    await expect(search(OWNER, [1, 2, 3])).rejects.toThrow(/1024 dimensions/);
    const bad = basis(0);
    bad[7] = Number.NaN;
    await expect(search(OWNER, bad)).rejects.toThrow(/finite number/);
    expect(() => toVectorLiteral(['0' as unknown as number, ...basis(0).slice(1)])).toThrow();
  });
});

// ─── listContent ───────────────────────────────────────────────────────────

describe.skipIf(!RUN)('listContent', () => {
  it('returns live pages that were never indexed', async () => {
    const entries = await listItems({ classroomId: ids.classroomA, role: STUDENT });
    const unindexed = entries.find(entry => entry.docId === ids.unindexedPage);
    expect(unindexed).toBeDefined();
    expect(unindexed?.indexed).toBe(false);
    expect(entries.find(entry => entry.docId === ids.publishedPage)?.indexed).toBe(true);
    // Indexed, but without a vector — present, and not searchable.
    expect(entries.find(entry => entry.docId === ids.noVectorPage)?.indexed).toBe(false);
  });

  it('omits drafts for a student and marks them for staff', async () => {
    const student = await listItems({ classroomId: ids.classroomA, role: STUDENT });
    expect(idsOf(student)).not.toContain(ids.draftPage);
    expect(idsOf(student)).not.toContain(ids.draftDeck);
    expect(idsOf(student)).not.toContain(ids.draftPublicPage);
    expect(student.every(entry => entry.isDraft === null)).toBe(true);

    const assistant = await listItems({ classroomId: ids.classroomA, role: ASSISTANT });
    expect(idsOf(assistant)).toContain(ids.draftPage);
    expect(idsOf(assistant)).toContain(ids.draftDeck);
    expect(assistant.find(entry => entry.docId === ids.draftPage)?.isDraft).toBe(true);
    expect(assistant.find(entry => entry.docId === ids.publishedPage)?.isDraft).toBe(false);
  });

  it('lists a chunked file once and no files for a non-member', async () => {
    const student = await listItems({ classroomId: ids.classroomA, role: STUDENT });
    expect(student.filter(entry => entry.docId === FILE_DOC_ID)).toHaveLength(1);

    const outsider = await listItems({ classroomId: ids.classroomA, role: OUTSIDER });
    expect(idsOf(outsider)).toEqual([ids.publicPage]);
  });

  it('honours the kind filter', async () => {
    const slides = await listItems({ classroomId: ids.classroomA, role: OWNER, kind: 'slide' });
    expect(slides.every(entry => entry.docKind === 'slide')).toBe(true);
    expect(idsOf(slides).sort()).toEqual([ids.deck, ids.draftDeck].sort());

    const files = await listItems({ classroomId: ids.classroomA, role: OWNER, kind: 'file' });
    expect(idsOf(files)).toEqual([FILE_DOC_ID]);
  });

  it('never lists another classroom documents', async () => {
    const entries = await listItems({ classroomId: ids.classroomA, role: OWNER });
    expect(idsOf(entries)).not.toContain(ids.otherClassroomPage);
    expect(idsOf(entries)).not.toContain(OTHER_FILE_DOC_ID);
  });
});

// ─── listContent paging ────────────────────────────────────────────────────

describe.skipIf(!RUN)('listContent paging', () => {
  const listAll = () => listContent({ classroomId: ids.classroomA, role: OWNER });

  it('answers a whole small course in one complete page', async () => {
    const page = await listAll();
    // The fixture corpus is far under the default, so an uncapped call must
    // report itself COMPLETE — `truncated` is the field a caller decides on.
    expect(page.items.length).toBeGreaterThan(2);
    expect(page.items.length).toBeLessThan(DEFAULT_LIST_LIMIT);
    expect(page.truncated).toBe(false);
    expect(page.nextOffset).toBeNull();
  });

  it('caps a page, flags it truncated, and walks the whole listing with nextOffset', async () => {
    const all = await listAll();

    const first = await listContent({ classroomId: ids.classroomA, role: OWNER, limit: 2 });
    expect(first.items).toHaveLength(2);
    expect(first.truncated).toBe(true);
    expect(first.nextOffset).toBe(2);
    // The probe row the statement fetched to answer "is there more?" is never
    // handed out, and the page is the head of the same total order.
    expect(idsOf(first.items)).toEqual(idsOf(all.items.slice(0, 2)));

    const walked = [...first.items];
    let offset = first.nextOffset;
    let guard = 0;
    while (offset !== null) {
      expect((guard += 1), 'paging did not terminate').toBeLessThan(50);
      const page = await listContent({
        classroomId: ids.classroomA,
        role: OWNER,
        limit: 2,
        offset,
      });
      walked.push(...page.items);
      offset = page.nextOffset;
    }
    expect(idsOf(walked)).toEqual(idsOf(all.items));
  });

  it('reports an exact-fit page as complete, not as truncated', async () => {
    const all = await listAll();
    const exact = await listContent({
      classroomId: ids.classroomA,
      role: OWNER,
      limit: all.items.length,
    });
    expect(idsOf(exact.items)).toEqual(idsOf(all.items));
    expect(exact.truncated).toBe(false);
    expect(exact.nextOffset).toBeNull();
  });

  it('clamps a hostile limit and a negative offset rather than failing', async () => {
    const all = await listAll();
    for (const limit of [0, -5, 1.9, 1e9, Number.NaN]) {
      const page = await listContent({ classroomId: ids.classroomA, role: OWNER, limit });
      expect(page.items.length, `limit ${limit}`).toBeGreaterThan(0);
      expect(page.items.length, `limit ${limit}`).toBeLessThanOrEqual(MAX_LIST_LIMIT);
    }
    const negative = await listContent({ classroomId: ids.classroomA, role: OWNER, offset: -10 });
    expect(idsOf(negative.items)).toEqual(idsOf(all.items));
  });

  it('pages past the end as an empty, complete listing', async () => {
    const page = await listContent({ classroomId: ids.classroomA, role: OWNER, offset: 10_000 });
    expect(page.items).toEqual([]);
    expect(page.truncated).toBe(false);
    expect(page.nextOffset).toBeNull();
  });

  it('applies the visibility rule BEFORE the window, on every page', async () => {
    // A limit that forces many pages is the shape in which a "filter after the
    // limit" bug would show: a draft would surface on some later page.
    const seen: string[] = [];
    let offset: number | null = 0;
    let guard = 0;
    while (offset !== null) {
      expect((guard += 1), 'paging did not terminate').toBeLessThan(50);
      const page: Awaited<ReturnType<typeof listContent>> = await listContent({
        classroomId: ids.classroomA,
        role: STUDENT,
        limit: 1,
        offset,
      });
      for (const entry of page.items) expect(entry.isDraft).toBeNull();
      seen.push(...idsOf(page.items));
      offset = page.nextOffset;
    }
    expect(seen).not.toContain(ids.draftPage);
    expect(seen).not.toContain(ids.draftDeck);
    expect(seen).not.toContain(ids.draftPublicPage);
    expect(seen).toContain(ids.publishedPage);
  });
});

// ─── getContentText ────────────────────────────────────────────────────────

describe.skipIf(!RUN)('getContentText', () => {
  it('returns the indexed text of a published page to a student', async () => {
    const document = await getContentText({
      classroomId: ids.classroomA,
      role: STUDENT,
      docKind: 'page',
      docId: ids.publishedPage,
    });
    expect(document.title).toBe('Assessment Schedule');
    expect(document.text).toContain('14 November');
    expect(document.chunkCount).toBe(1);
    expect(document.isDraft).toBeNull();
  });

  it('concatenates every chunk in chunk_ix order', async () => {
    const document = await getContentText({
      classroomId: ids.classroomA,
      role: STUDENT,
      docKind: 'slide',
      docId: ids.deck,
    });
    expect(document.chunkCount).toBe(3);
    expect(document.text).toBe(
      [
        'Deck chunk zero: administrivia.',
        'Deck chunk one: the base case is what stops it.',
        'Deck chunk two: worked example.',
      ].join('\n\n')
    );
    expect(document.sourcePath).toBe('slides/recursion-deck/index.html');
  });

  it('refuses a draft to a student with the SAME error as a missing id', async () => {
    const attempts = [
      { label: 'draft', docId: ids.draftPage },
      { label: 'missing', docId: randomUUID() },
      { label: 'other classroom', docId: ids.otherClassroomPage },
      { label: 'draft and public', docId: ids.draftPublicPage },
    ];

    const results = await Promise.all(
      attempts.map(async attempt => {
        try {
          await getContentText({
            classroomId: ids.classroomA,
            role: STUDENT,
            docKind: 'page',
            docId: attempt.docId,
          });
          return { label: attempt.label, code: 'NO ERROR', message: '' };
        } catch (error) {
          const failure = error as ContentNotFoundError;
          return { label: attempt.label, code: failure.code, message: failure.message };
        }
      })
    );

    // Every refusal is byte-identical, so a student cannot probe for draft ids.
    const distinct = new Set(results.map(result => `${result.code}|${result.message}`));
    expect(distinct.size).toBe(1);
    expect([...distinct][0]).toBe('CONTENT_NOT_FOUND|Content not found in this classroom.');
  });

  it('gives the same refusal to a non-member holding a members-only id', async () => {
    await expect(
      getContentText({
        classroomId: ids.classroomA,
        role: OUTSIDER,
        docKind: 'page',
        docId: ids.publishedPage,
      })
    ).rejects.toBeInstanceOf(ContentNotFoundError);
    await expect(
      getContentText({
        classroomId: ids.classroomA,
        role: OUTSIDER,
        docKind: 'file',
        docId: FILE_DOC_ID,
      })
    ).rejects.toBeInstanceOf(ContentNotFoundError);
  });

  it('gives staff the draft, with is_draft set', async () => {
    const document = await getContentText({
      classroomId: ids.classroomA,
      role: ASSISTANT,
      docKind: 'page',
      docId: ids.draftPage,
    });
    expect(document.text).toContain('key-value store');
    expect(document.isDraft).toBe(true);
  });

  it('refuses another classroom document to that classroom own owner', async () => {
    // The id is real and the viewer is an OWNER — but not of classroom A.
    await expect(
      getContentText({
        classroomId: ids.classroomA,
        role: OWNER,
        docKind: 'page',
        docId: ids.otherClassroomPage,
      })
    ).rejects.toBeInstanceOf(ContentNotFoundError);
  });

  it('serves a file row to a member', async () => {
    const document = await getContentText({
      classroomId: ids.classroomA,
      role: STUDENT,
      docKind: 'file',
      docId: FILE_DOC_ID,
    });
    expect(document.text).toContain('Tuesdays at four');
    expect(document.isDraft).toBeNull();
  });
});
