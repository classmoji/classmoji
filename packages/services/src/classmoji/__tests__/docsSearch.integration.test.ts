/**
 * The docs read statements, against a real Postgres.
 *
 * ── Why these CANNOT be unit tests ─────────────────────────────────────────
 * Everything worth asserting about them is SQL semantics:
 *
 *   - `DISTINCT ON (slug)` picking each page's BEST chunk before the limit;
 *   - pgvector's `<=>` actually ordering the way the statement claims;
 *   - `string_agg(… ORDER BY chunk_ix)` reassembling a page in reading order;
 *   - `NOT EXISTS (… WHERE embedding IS NOT NULL)` returning a boolean rather
 *     than a row count;
 *   - `limit + 1` / `truncated` / `nextOffset` paging over a total order.
 *
 * A fake Prisma agrees with all of those whatever the statement says.
 *
 * ── Why a DISPOSABLE database ──────────────────────────────────────────────
 * `docs_index` is GLOBAL — no classroom column, so no namespace to hide
 * fixtures behind. Ranking, pagination and "is the index empty" are all
 * statements over the WHOLE table, and a developer's real docs rows would sit
 * between the fixtures and change every answer. See `helpers/docsTestDatabase`.
 *
 * Opted in with `DOCS_INDEX_INTEGRATION=1`; when opted in it FAILS rather than
 * skipping if the database is unreachable.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createDocsTestDatabase,
  docsDbOptedIn,
  type DisposableDatabase,
} from './helpers/docsTestDatabase.ts';

const RUN = docsDbOptedIn();

let database: DisposableDatabase | null = null;
if (RUN) {
  database = await createDocsTestDatabase();
  process.env.DATABASE_URL = database.url;
}

const getPrisma = (await import('@classmoji/database')).default;
const { toVectorLiteral } = await import('../contentSearch.service.ts');
const {
  DOCS_SEARCH_MIN_CHARS,
  DocsNotFoundError,
  docsIndexIsEmpty,
  getDocText,
  listDocs,
  searchDocs,
} = await import('../docsSearch.service.ts');
const { EMBEDDING_DIMENSIONS } = await import('../../helpers/workersAi.ts');

afterAll(async () => {
  if (!RUN) return;
  await getPrisma().$disconnect();
  await database?.drop();
});

// ─── Deterministic vectors ──────────────────────────────────────────────────

/**
 * The i-th unit basis vector.
 *
 * Cosine distance from one basis vector to the same one is 0 and to any other
 * is exactly 1, so the ranking a search returns is decided entirely by which
 * basis vector each fixture carries — nothing depends on an embedding model's
 * judgement, or on it being reachable.
 */
const basis = (index: number): number[] => {
  const vector = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
  vector[index] = 1;
  return vector;
};

/**
 * A vector between two bases, closer to `near` than a pure `far` basis is.
 *
 * Used for the "a LATER chunk is strictly better" case: an equal-distance later
 * chunk would let a `DISTINCT ON` that simply took the first chunk pass.
 */
const between = (near: number, weight: number): number[] => {
  const vector = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
  vector[near] = weight;
  vector[EMBEDDING_DIMENSIONS - 1] = Math.sqrt(1 - weight * weight);
  return vector;
};

interface Seed {
  slug: string;
  chunkIx: number;
  chunkCount: number;
  title: string;
  description?: string | null;
  section?: string | null;
  text: string;
  vector: number[] | null;
}

const insert = async (seed: Seed): Promise<void> => {
  const literal = seed.vector === null ? null : toVectorLiteral(seed.vector);
  await getPrisma().$executeRaw`
    INSERT INTO docs_index
      (slug, chunk_ix, chunk_count, title, description, section, text,
       source_sha, extract_version, embed_model, embedding, updated_at)
    VALUES
      (${seed.slug}, ${seed.chunkIx}::int, ${seed.chunkCount}::int, ${seed.title},
       ${seed.description ?? null}, ${seed.section ?? null}, ${seed.text},
       ${'a'.repeat(40)}, 1, ${'@cf/qwen/qwen3-embedding-0.6b'},
       ${literal}::vector, NOW())`;
};

// ─── Fixtures ───────────────────────────────────────────────────────────────

const ROSTER = 'docs/instructors/roster';
const GRADING = 'docs/instructors/grading';
const TOKENS = 'docs/students/use-tokens';
const ROOT = 'docs';
const NO_VECTOR = 'docs/self-hosting/docker';
/**
 * Long, and named so its TITLE sorts first in its section while its SLUG sorts
 * last. Two contracts ride on that: the snippet is bounded rather than the
 * whole chunk, and `listDocs` orders by title rather than inheriting the inner
 * query's slug order.
 */
const LONG = 'docs/instructors/tokens';
const LONG_TEXT = `Add tokens to a class. ${'Tokens buy a student extra hours on a deadline. '.repeat(40)}`;

/**
 * The NAVIGATION STUB and the page it stands in front of.
 *
 * `STUB` is the shape `DOCS_SEARCH_MIN_CHARS` exists for: a real corpus page
 * (`docs/instructors` is 253 characters, `docs/students` 187) that is a heading
 * and a list of link labels. It carries the same vector the query does, so it
 * is STRICTLY nearer than anything else — which is exactly what happened
 * against the live corpus, and why "the top hit" was a page of links.
 * `DEADLINES` is the page that actually answers, one notch further away.
 *
 * Their lengths bracket the threshold on purpose: 200 and 600, either side of
 * 400, mirroring the real gap between 253 and 537.
 */
const STUB = 'docs/instructors';
const DEADLINES = 'docs/instructors/deadlines';
const fill = (lead: string, length: number): string =>
  `${lead} ${'Classmoji is a Git-native platform for CS courses. '.repeat(30)}`.slice(0, length);
const STUB_TEXT = fill('For instructors. Roster. Grading. Tokens.', 200);
const DEADLINES_TEXT = fill('Set a deadline on an assignment from the Assignments tab.', 600);

/**
 * A fixture body comfortably over the search floor, with its sentinel FIRST.
 *
 * First matters twice: `LEFT(text, SNIPPET_CHARS)` is the snippet, and the
 * assertions below look for the sentinel in it.
 */
const body = (lead: string): string => fill(lead, 520);

beforeAll(async () => {
  if (!RUN) return;

  await insert({
    slug: ROSTER,
    chunkIx: 0,
    chunkCount: 1,
    title: 'Manage your roster',
    description: 'How to add students and teaching staff',
    section: 'instructors',
    text: body('Go to the Teaching Staff tab and click New staff member.'),
    vector: basis(0),
  });

  // THREE chunks, and the BEST one is chunk 2 — strictly better than chunk 0,
  // not merely equal. An equal-distance later chunk would let a statement that
  // took the first chunk of each page pass by accident.
  await insert({
    slug: GRADING,
    chunkIx: 0,
    chunkCount: 3,
    title: 'Grading',
    section: 'instructors',
    text: body('GRADING-CHUNK-ZERO emoji mappings.'),
    vector: between(1, 0.2),
  });
  await insert({
    slug: GRADING,
    chunkIx: 2,
    chunkCount: 3,
    title: 'Grading',
    section: 'instructors',
    text: body('GRADING-CHUNK-TWO releasing grades.'),
    vector: basis(1),
  });
  // Deliberately inserted OUT OF ORDER, after chunk 2, so `getDocText` has to
  // do the ordering rather than inherit the insertion order.
  await insert({
    slug: GRADING,
    chunkIx: 1,
    chunkCount: 3,
    title: 'Grading',
    section: 'instructors',
    text: body('GRADING-CHUNK-ONE grading an assignment.'),
    vector: between(1, 0.1),
  });

  // TWO chunks at EXACTLY the same distance. This is the `chunk_ix` tiebreaker's
  // fixture: with equal distances, `ORDER BY di.slug, distance` alone leaves
  // which chunk survives `DISTINCT ON` to whatever order the sort happens to
  // emit, and the page answers out of a paragraph nobody chose.
  //
  // Written in READING ORDER, which is not an arbitrary choice: `writePage`
  // inserts `chunks.entries()` ascending, so this is the physical layout a real
  // page has. Verified against this Postgres: with the `chunk_ix` key removed
  // from the inner ORDER BY, this exact shape returns chunk 1.
  await insert({
    slug: TOKENS,
    chunkIx: 0,
    chunkCount: 2,
    title: 'Use tokens',
    section: 'students',
    text: body('TOKENS-CHUNK-ZERO spend a token to extend a deadline.'),
    vector: basis(2),
  });
  await insert({
    slug: TOKENS,
    chunkIx: 1,
    chunkCount: 2,
    title: 'Use tokens',
    section: 'students',
    text: body('TOKENS-CHUNK-ONE what happens when you run out.'),
    vector: basis(2),
  });

  await insert({
    slug: ROOT,
    chunkIx: 0,
    chunkCount: 1,
    title: 'Welcome to Classmoji Docs',
    section: null,
    text: body('Classmoji is a Git-native platform for CS courses.'),
    vector: basis(3),
  });

  await insert({
    slug: LONG,
    chunkIx: 0,
    chunkCount: 1,
    title: 'Add tokens to a class',
    section: 'instructors',
    text: LONG_TEXT,
    vector: basis(6),
  });

  // The navigation stub, and the page it stands in front of. The stub carries
  // the query vector ITSELF, so it is nearer than anything else in the table.
  await insert({
    slug: STUB,
    chunkIx: 0,
    chunkCount: 1,
    title: 'For instructors',
    section: 'instructors',
    text: STUB_TEXT,
    vector: basis(7),
  });
  await insert({
    slug: DEADLINES,
    chunkIx: 0,
    chunkCount: 1,
    title: 'Set a deadline',
    section: 'instructors',
    text: DEADLINES_TEXT,
    vector: between(7, 0.9),
  });

  // A row with NO vector: written, but unsearchable. LONG ENOUGH to clear the
  // search floor, so the only thing keeping it out of results is the missing
  // embedding and not its length.
  await insert({
    slug: NO_VECTOR,
    chunkIx: 0,
    chunkCount: 1,
    title: 'Docker',
    section: 'self-hosting',
    text: body('UNEMBEDDED-SENTINEL run it with docker compose.'),
    vector: null,
  });
});

const slugsOf = (hits: Array<{ slug: string }>): string[] => hits.map(hit => hit.slug);

describe.skipIf(!RUN)('searchDocs', () => {
  it('ranks by cosine distance, nearest first', async () => {
    const hits = await searchDocs({ queryVector: basis(0), limit: 20 });
    expect(slugsOf(hits)[0]).toBe(ROSTER);
    expect(hits[0].score).toBeCloseTo(1, 5);
    expect(hits[0].title).toBe('Manage your roster');
    expect(hits[0].section).toBe('instructors');
    expect(hits[0].description).toBe('How to add students and teaching staff');
  });

  it('returns a page ONCE, on its BEST chunk — not its first', async () => {
    const hits = await searchDocs({ queryVector: basis(1), limit: 20 });
    const grading = hits.filter(hit => hit.slug === GRADING);

    expect(grading).toHaveLength(1);
    // Chunk 2 is strictly nearer than chunks 0 and 1, so a statement that
    // collapsed to the first chunk would answer with the wrong text here.
    expect(grading[0].chunkIx).toBe(2);
    expect(grading[0].snippet).toContain('GRADING-CHUNK-TWO');
    expect(slugsOf(hits)[0]).toBe(GRADING);
  });

  it('EXCLUDES a row with no vector, at a limit wide enough to have included it', async () => {
    // The limit matters: at limit 5 a removed `embedding IS NOT NULL` filter
    // could be masked by the cap. 20 is wider than the whole fixture corpus.
    const hits = await searchDocs({ queryVector: basis(0), limit: 20 });
    expect(slugsOf(hits)).not.toContain(NO_VECTOR);
    expect(JSON.stringify(hits)).not.toContain('UNEMBEDDED-SENTINEL');
    // Every embedded page long enough to be searchable came back, so the
    // exclusion is the filter and not the limit.
    expect(new Set(slugsOf(hits))).toEqual(
      new Set([ROSTER, GRADING, TOKENS, ROOT, LONG, DEADLINES])
    );
  });

  it('de-dupes BEFORE the limit, so a chunked page cannot crowd the results out', async () => {
    // Grading alone has three rows. A `LIMIT 3` applied before the collapse
    // would return three copies of it and nothing else.
    const hits = await searchDocs({ queryVector: basis(1), limit: 3 });
    expect(hits).toHaveLength(3);
    expect(new Set(slugsOf(hits)).size).toBe(3);
    expect(slugsOf(hits)[0]).toBe(GRADING);
  });

  it('bounds the snippet rather than returning the whole chunk', async () => {
    // The fixture is deliberately far longer than the budget: with a short one,
    // `LEFT(text, 400)` and `text` are the same string and the cap is untested.
    expect(LONG_TEXT.length).toBeGreaterThan(1000);
    const hits = await searchDocs({ queryVector: basis(6), limit: 1 });
    expect(hits[0].slug).toBe(LONG);
    expect(hits[0].snippet).toHaveLength(400);
    expect(hits[0].snippet).toBe(LONG_TEXT.slice(0, 400));
    // And the whole page is still available through getDocText.
    const document = await getDocText(LONG);
    expect(document.text.length).toBeGreaterThan(1000);
  });

  it('clamps a silly limit instead of refusing', async () => {
    await expect(searchDocs({ queryVector: basis(0), limit: 9999 })).resolves.toBeInstanceOf(Array);
    const one = await searchDocs({ queryVector: basis(0), limit: 0 });
    expect(one).toHaveLength(1);
  });

  it('refuses a query vector of the wrong width', async () => {
    await expect(searchDocs({ queryVector: [1, 2, 3] })).rejects.toThrow(/1024 dimensions/);
  });

  it('DROPS a page shorter than the search floor even when it ranks FIRST', async () => {
    // The stub carries the query vector itself, so by distance alone it is the
    // top hit and nothing else can displace it. This is the live failure: "where
    // do I add a TA" ranked `docs/instructors` — a list of link labels — above
    // the page that answers.
    expect(STUB_TEXT.length).toBeLessThan(DOCS_SEARCH_MIN_CHARS);
    expect(DEADLINES_TEXT.length).toBeGreaterThan(DOCS_SEARCH_MIN_CHARS);

    const hits = await searchDocs({ queryVector: basis(7), limit: 20 });
    expect(slugsOf(hits)).not.toContain(STUB);
    // And the page behind it is what a caller gets instead — first, because the
    // stub is no longer standing in front of it.
    expect(slugsOf(hits)[0]).toBe(DEADLINES);
  });

  it('the stub really is the nearer page — the floor is what removed it', async () => {
    // Without this the test above passes for a stub that simply ranked badly.
    // Cosine distance to its own basis vector is 0; `between(7, 0.9)` is 0.1
    // away, so the ordering is arithmetic rather than an embedding's opinion.
    const stub = await getPrisma().$queryRaw<Array<{ distance: number }>>`
      SELECT (embedding <=> ${toVectorLiteral(basis(7))}::vector) AS distance
      FROM docs_index WHERE slug = ${STUB}`;
    const answer = await getPrisma().$queryRaw<Array<{ distance: number }>>`
      SELECT (embedding <=> ${toVectorLiteral(basis(7))}::vector) AS distance
      FROM docs_index WHERE slug = ${DEADLINES}`;
    expect(Number(stub[0].distance)).toBeLessThan(Number(answer[0].distance));
  });

  it('a short page is still LISTED and still READABLE — the floor is search only', async () => {
    // The stub is navigation, not a secret. `content_list` must still show it
    // and `content_get` must still serve it, because the prompt tells the model
    // to follow a stub's labels to the page behind them — which it can only do
    // if it can look one up by title.
    const page = await listDocs();
    expect(page.items.map(item => item.slug)).toContain(STUB);
    expect(page.items.find(item => item.slug === STUB)?.title).toBe('For instructors');

    const document = await getDocText(STUB);
    expect(document.text).toBe(STUB_TEXT);
    expect(document.title).toBe('For instructors');
  });

  it('breaks an EQUAL-distance tie on the lower chunk_ix', async () => {
    // Both of `TOKENS`'s chunks carry the same vector, so distance cannot decide
    // between them and `DISTINCT ON (slug)` keeps exactly one. Without
    // `chunk_ix` closing the inner ORDER BY, which one survives is whatever the
    // sort emitted first — and a page that answers out of its opening paragraph
    // today answers out of its second tomorrow, with nothing in the diff to
    // explain it. On this Postgres, removing that key makes this fixture return
    // chunk 1.
    const hits = await searchDocs({ queryVector: basis(2), limit: 20 });
    const tokens = hits.filter(hit => hit.slug === TOKENS);

    expect(tokens).toHaveLength(1);
    expect(tokens[0].chunkIx).toBe(0);
    expect(tokens[0].snippet).toContain('TOKENS-CHUNK-ZERO');
    expect(tokens[0].snippet).not.toContain('TOKENS-CHUNK-ONE');
  });
});

describe.skipIf(!RUN)('listDocs', () => {
  it('returns ONE row per page, never one per chunk', async () => {
    const page = await listDocs();
    const grading = page.items.filter(item => item.slug === GRADING);
    expect(grading).toHaveLength(1);
    expect(grading[0].title).toBe('Grading');
  });

  it('lists unembedded pages too — the index is where they exist', async () => {
    const page = await listDocs();
    expect(page.items.map(item => item.slug)).toContain(NO_VECTOR);
  });

  it('orders root pages first, then sections, titles alphabetically within', async () => {
    const page = await listDocs();
    expect(page.items[0].slug).toBe(ROOT);
    expect(page.items[0].section).toBeNull();
    const sections = page.items.map(item => item.section);
    expect(sections).toEqual([
      null,
      'instructors',
      'instructors',
      'instructors',
      'instructors',
      'instructors',
      'self-hosting',
      'students',
    ]);
    // Alphabetical by LOWERCASED TITLE within a section — which for the first
    // three is deliberately the opposite of their slug order, so an ORDER BY
    // that merely inherited the inner query's `ORDER BY slug` shows up here.
    const instructors = page.items.filter(item => item.section === 'instructors');
    expect(instructors.map(item => item.title)).toEqual([
      'Add tokens to a class',
      'For instructors',
      'Grading',
      'Manage your roster',
      'Set a deadline',
    ]);
    expect(instructors.map(item => item.slug)).toEqual([LONG, STUB, GRADING, ROSTER, DEADLINES]);
  });

  it('carries the canonical URL for every row', async () => {
    const page = await listDocs();
    const roster = page.items.find(item => item.slug === ROSTER);
    expect(roster?.url).toBe('https://classmoji.io/docs/instructors/roster');
  });

  it('reports truncation and a next offset, and pages cleanly through', async () => {
    const first = await listDocs({ limit: 2 });
    expect(first.items).toHaveLength(2);
    expect(first.truncated).toBe(true);
    expect(first.nextOffset).toBe(2);

    // Walk the whole catalogue two at a time, following `nextOffset` the way a
    // caller does, and stop only when the listing says it is complete.
    const all: string[] = [...first.items.map(item => item.slug)];
    let cursor = first.nextOffset;
    let pages = 1;
    while (cursor !== null) {
      const next = await listDocs({ limit: 2, offset: cursor });
      all.push(...next.items.map(item => item.slug));
      cursor = next.nextOffset;
      pages += 1;
      expect(pages, 'paging did not terminate').toBeLessThan(20);
    }

    expect(pages).toBe(4);
    // No page repeated, none skipped: the ORDER BY is total.
    expect(new Set(all).size).toBe(all.length);
    expect(all).toHaveLength(8);
  });

  it('COMPLETES on its OWN default, which is not the search default of 5', async () => {
    // Called with NO arguments, the way a "what documentation is there?" caller
    // calls it. Clamped to search's default of 5, this corpus would come back
    // truncated — which reads to a model as "there is much more" rather than
    // "that is all of it". The real corpus is 25 pages against a default of
    // 100, for the same reason.
    const page = await listDocs();
    expect(page.items).toHaveLength(8);
    expect(page.truncated).toBe(false);
    expect(page.nextOffset).toBeNull();
  });
});

describe.skipIf(!RUN)('getDocText', () => {
  it('returns a single-chunk page whole', async () => {
    const document = await getDocText(ROSTER);
    expect(document.slug).toBe(ROSTER);
    expect(document.title).toBe('Manage your roster');
    expect(document.section).toBe('instructors');
    expect(document.url).toBe('https://classmoji.io/docs/instructors/roster');
    expect(document.chunkCount).toBe(1);
    expect(document.text).toContain('New staff member');
  });

  it('reassembles a chunked page IN READING ORDER, whatever order it was written', async () => {
    // The fixtures were inserted 0, 2, 1 on purpose: without the ORDER BY
    // inside `string_agg`, Postgres may concatenate in scan order, and a model
    // reading a shuffled document answers out of a paragraph that lost its
    // context.
    const document = await getDocText(GRADING);
    expect(document.chunkCount).toBe(3);
    const zero = document.text.indexOf('GRADING-CHUNK-ZERO');
    const one = document.text.indexOf('GRADING-CHUNK-ONE');
    const two = document.text.indexOf('GRADING-CHUNK-TWO');
    expect(zero).toBeGreaterThanOrEqual(0);
    expect(zero).toBeLessThan(one);
    expect(one).toBeLessThan(two);
  });

  it('serves a page that has no vector — reading does not need one', async () => {
    const document = await getDocText(NO_VECTOR);
    expect(document.text).toContain('UNEMBEDDED-SENTINEL');
  });

  it('orders INSIDE the aggregate, not by relying on the plan', () => {
    // Honest about what the behavioural test above can and cannot show. With
    // seven rows and a primary key on (slug, chunk_ix), the planner happens to
    // use an index scan, which already returns chunk order — so REMOVING the
    // `ORDER BY` still passes today, and would start failing silently the day
    // the corpus grows into a sequential or parallel plan. (Verified: on a
    // plain seq scan, `string_agg` without an ORDER BY returns heap order.)
    //
    // The behavioural test catches a WRONG ordering (`DESC`); this catches a
    // MISSING one.
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(resolve(here, '..', 'docsSearch.service.ts'), 'utf8');
    // Anchored on `string_agg(di.text` and confined to ONE line. `[^)]*` fails
    // (the separator `chr(10) || chr(10)` carries its own parentheses) and
    // `[\s\S]*?` fails too — it lets the `string_agg(` in the docblock above
    // reach the `array_agg(… ORDER BY di.chunk_ix)` further down and match a
    // statement that has no ordering at all.
    expect(source).toMatch(/string_agg\(di\.text,[^\n]*ORDER BY di\.chunk_ix\)/);
  });

  it('throws DocsNotFoundError for a slug that is not there', async () => {
    await expect(getDocText('docs/instructors/made-up')).rejects.toBeInstanceOf(DocsNotFoundError);
    await expect(getDocText('')).rejects.toBeInstanceOf(DocsNotFoundError);
  });
});

describe.skipIf(!RUN)('docsIndexIsEmpty', () => {
  it('is false while embedded rows exist', async () => {
    await expect(docsIndexIsEmpty()).resolves.toBe(false);
  });

  it('is TRUE when every row is unembedded — not merely when the table is empty', async () => {
    // `count(*) = 0` would say false here, and the caller would tell a user
    // "the docs say nothing about that" about a corpus search cannot reach.
    await getPrisma().$executeRaw`UPDATE docs_index SET embedding = NULL`;
    await expect(docsIndexIsEmpty()).resolves.toBe(true);

    // And restore, so the ordering of these blocks does not matter.
    await getPrisma().$executeRaw`
      UPDATE docs_index SET embedding = ${toVectorLiteral(basis(5))}::vector
      WHERE slug <> ${NO_VECTOR}`;
    await expect(docsIndexIsEmpty()).resolves.toBe(false);
  });

  it('is TRUE on a genuinely empty table, and returns a BOOLEAN not a row count', async () => {
    await getPrisma().$executeRaw`CREATE TEMP TABLE docs_backup AS SELECT * FROM docs_index`;
    await getPrisma().$executeRaw`DELETE FROM docs_index`;

    const answer = await docsIndexIsEmpty();
    expect(typeof answer).toBe('boolean');
    expect(answer).toBe(true);

    await getPrisma().$executeRaw`INSERT INTO docs_index SELECT * FROM docs_backup`;
    await getPrisma().$executeRaw`DROP TABLE docs_backup`;
    await expect(docsIndexIsEmpty()).resolves.toBe(false);
  });
});
