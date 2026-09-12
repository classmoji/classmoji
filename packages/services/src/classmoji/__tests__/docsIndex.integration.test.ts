/**
 * The docs indexer's SQL, against a real Postgres.
 *
 * ── Why this exists beside `docsIndex.test.ts` ─────────────────────────────
 * That file drives every branch over a recording Prisma, which agrees with
 * whatever statement it is handed. It can prove a statement was or was not
 * ISSUED; it cannot prove one is correct. Three things here are only true if
 * real SQL says so:
 *
 *   - `embedding` is an `Unsupported("vector(1024)")` column. Prisma Client
 *     cannot see it, so every read and write is raw, and the only proof that
 *     the `'[…]'::vector` parameter, the two-column `ON CONFLICT` target and
 *     the 1,024-dimension width line up is a row landing in pgvector;
 *   - `updated_at` has `@updatedAt`, which is a Prisma CLIENT feature a raw
 *     upsert goes straight past. Only a real UPDATE shows the column moved;
 *   - the SHRINK-TAIL delete, the SWEEP and transactional ROLLBACK are SQL.
 *
 * ── The database ───────────────────────────────────────────────────────────
 * A disposable one, created from the migrations and dropped afterwards — see
 * `helpers/docsTestDatabase.ts` for why namespacing cannot work for a global
 * table. It is created BEFORE `@classmoji/database` is imported, because that
 * module builds its client from `DATABASE_URL` at import time.
 *
 * Opted in with `DOCS_INDEX_INTEGRATION=1`, and when opted in it FAILS rather
 * than skipping if the database is unreachable.
 */

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createDocsTestDatabase,
  docsDbOptedIn,
  type DisposableDatabase,
} from './helpers/docsTestDatabase.ts';

const RUN = docsDbOptedIn();

// Created at module scope, on purpose: `@classmoji/database` constructs its
// singleton the moment it is imported, so the URL has to be in place first.
let database: DisposableDatabase | null = null;
if (RUN) {
  database = await createDocsTestDatabase();
  process.env.DATABASE_URL = database.url;
}

const embedTextsMock = vi.fn();
vi.mock('../../helpers/workersAi.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('../../helpers/workersAi.ts')>();
  return {
    ...actual,
    isWorkersAiConfigured: () => true,
    embedTexts: (...args: unknown[]) => embedTextsMock(...args),
  };
});

const getPrisma = (await import('@classmoji/database')).default;
const { DOCS_EXTRACT_VERSION, reconcileDocsIndex } = await import('../docsIndex.service.ts');
const { EMBEDDING_MODEL, EMBEDDING_DIMENSIONS } = await import('../../helpers/workersAi.ts');

afterAll(async () => {
  if (!RUN) return;
  await getPrisma().$disconnect();
  await database?.drop();
});

// ─── Fixtures ───────────────────────────────────────────────────────────────

const COMMIT = 'a'.repeat(40);
const shaFor = (seed: string): string =>
  seed
    .padEnd(40, '0')
    .replace(/[^0-9a-f]/g, '1')
    .slice(0, 40);

const blob = (path: string, seed: string) => ({ path, type: 'blob', sha: shaFor(seed) });

const mdx = (title: string, body: string): string =>
  `---\ntitle: ${title}\ndescription: Fixture page\n---\n\n${body}\n`;

const reader = (entries: ReturnType<typeof blob>[], bodies: Record<string, string>) => ({
  head: async () => COMMIT,
  tree: async () => ({ entries: entries as never, truncated: false }),
  body: async (_commit: string, relPath: string) => bodies[relPath] ?? null,
});

const unitVector = (seed: number): number[] =>
  Array.from({ length: EMBEDDING_DIMENSIONS }, (_, i) =>
    i === seed % EMBEDDING_DIMENSIONS ? 1 : 0
  );

interface Row {
  slug: string;
  chunk_ix: number;
  chunk_count: number;
  title: string;
  description: string | null;
  section: string | null;
  text: string;
  source_sha: string;
  extract_version: number;
  embed_model: string;
  embedding_null: boolean;
  updated_at: Date;
}

/**
 * Set (or unset) an env var and hand back a restore.
 *
 * `process.env.X = undefined` assigns the STRING "undefined", which is a
 * different bug every time: here it left the embed cap unparseable for every
 * test that ran after the one that lowered it.
 */
function withEnv(name: string, value: string): () => void {
  const previous = process.env[name];
  process.env[name] = value;
  return () => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  };
}

const rows = async (): Promise<Row[]> =>
  getPrisma().$queryRaw<Row[]>`
    SELECT slug, chunk_ix, chunk_count, title, description, section, text,
           source_sha, extract_version, embed_model,
           (embedding IS NULL) AS embedding_null, updated_at
    FROM docs_index ORDER BY slug, chunk_ix`;

beforeEach(async () => {
  if (!RUN) return;
  await getPrisma().$executeRaw`DELETE FROM docs_index`;
  embedTextsMock.mockReset();
  embedTextsMock.mockImplementation(async (texts: string[]) => ({
    ok: true,
    vectors: texts.map((_, index) => unitVector(index + 1)),
  }));
});

describe.skipIf(!RUN)('docsIndex writes (real Postgres)', () => {
  it('lands a row with a real vector, the frontmatter and the derived section', async () => {
    const report = await reconcileDocsIndex({
      reader: reader([blob('docs/instructors/roster.mdx', 'abc')], {
        'docs/instructors/roster.mdx': mdx('Manage your roster', 'Go to the Students tab.'),
      }),
    });

    expect(report.error).toBeUndefined();
    expect(report.indexed).toBe(1);

    const [row] = await rows();
    expect(row.slug).toBe('docs/instructors/roster');
    expect(row.chunk_ix).toBe(0);
    expect(row.chunk_count).toBe(1);
    expect(row.title).toBe('Manage your roster');
    expect(row.description).toBe('Fixture page');
    expect(row.section).toBe('instructors');
    expect(row.text).toContain('Go to the Students tab.');
    expect(row.source_sha).toBe(shaFor('abc'));
    expect(row.extract_version).toBe(DOCS_EXTRACT_VERSION);
    expect(row.embed_model).toBe(EMBEDDING_MODEL);
    // The whole point of a real database: pgvector accepted the literal at the
    // declared width.
    expect(row.embedding_null).toBe(false);
    const [{ dims }] = await getPrisma().$queryRaw<Array<{ dims: number }>>`
      SELECT vector_dims(embedding) AS dims FROM docs_index WHERE slug = 'docs/instructors/roster'`;
    expect(dims).toBe(EMBEDDING_DIMENSIONS);
  });

  it('leaves section NULL for a page directly under the docs root', async () => {
    await reconcileDocsIndex({
      reader: reader([blob('docs/index.mdx', 'bbb')], {
        'docs/index.mdx': mdx('Welcome', 'Some prose.'),
      }),
    });
    const [row] = await rows();
    expect(row.slug).toBe('docs');
    expect(row.section).toBeNull();
  });

  it('UPDATES in place on a re-index, and moves updated_at by hand', async () => {
    const first = reader([blob('docs/a.mdx', 'aaa')], { 'docs/a.mdx': mdx('A', 'First body.') });
    await reconcileDocsIndex({ reader: first });
    const [before] = await rows();

    await new Promise(resolve => setTimeout(resolve, 25));

    const second = reader([blob('docs/a.mdx', 'bbb')], { 'docs/a.mdx': mdx('A', 'Second body.') });
    const report = await reconcileDocsIndex({ reader: second });

    expect(report.indexed).toBe(1);
    const after = await rows();
    // One row, not two: the ON CONFLICT target is the real primary key.
    expect(after).toHaveLength(1);
    expect(after[0].text).toContain('Second body.');
    expect(after[0].source_sha).toBe(shaFor('bbb'));
    // `@updatedAt` is a Prisma Client feature and a raw upsert goes past it, so
    // the statement sets the column itself. Only a real UPDATE proves it moved.
    expect(after[0].updated_at.getTime()).toBeGreaterThan(before.updated_at.getTime());
  });

  it('DELETES the tail a shrinking document leaves behind', async () => {
    // Force two chunks, then one, by driving the chunker's budget down.
    const restoreCap = withEnv('CLOUDFLARE_WORKERS_AI_EMBED_MAX_TOKENS', '30');

    const long = `${'First paragraph is reasonably long here. '.repeat(3)}\n\n${'Second paragraph is also reasonably long. '.repeat(3)}`;
    await reconcileDocsIndex({
      reader: reader([blob('docs/a.mdx', 'aaa')], { 'docs/a.mdx': mdx('A', long) }),
    });
    const chunked = await rows();
    expect(chunked.length).toBeGreaterThan(1);

    restoreCap();

    await reconcileDocsIndex({
      reader: reader([blob('docs/a.mdx', 'bbb')], { 'docs/a.mdx': mdx('A', 'Now short.') }),
    });

    const after = await rows();
    // Chunk 1 of the previous version is a perfectly good row with a perfectly
    // good vector, and it would go on answering out of text this page no longer
    // has.
    expect(after).toHaveLength(1);
    expect(after[0].chunk_ix).toBe(0);
    expect(after[0].chunk_count).toBe(1);
    expect(after[0].text).toContain('Now short.');
  });

  it('ROLLS BACK the whole page when a chunk write fails', async () => {
    const restoreCap = withEnv('CLOUDFLARE_WORKERS_AI_EMBED_MAX_TOKENS', '30');
    const long = `${'First paragraph is reasonably long here. '.repeat(3)}\n\n${'Second paragraph is also reasonably long. '.repeat(3)}`;

    // A vector of the wrong width: pgvector refuses the second INSERT, inside
    // the transaction that already wrote the first.
    embedTextsMock.mockImplementation(async (texts: string[]) => ({
      ok: true,
      vectors: texts.map((_, index) => (index === 0 ? unitVector(1) : new Array(16).fill(0.5))),
    }));

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const report = await reconcileDocsIndex({
      reader: reader([blob('docs/a.mdx', 'aaa')], { 'docs/a.mdx': mdx('A', long) }),
    });
    warn.mockRestore();
    restoreCap();

    expect(report.failed).toBe(1);
    // NOT a half-written document. Chunk 0 with a `chunk_count` of 2 and no
    // chunk 1 reads as stale to `isFresh`, but it is also a document the search
    // can already reach with half its text.
    expect(await rows()).toHaveLength(0);
  });

  it('SWEEPS a page that has left the tree, and only that page', async () => {
    await reconcileDocsIndex({
      reader: reader([blob('docs/a.mdx', 'aaa'), blob('docs/b.mdx', 'bbb')], {
        'docs/a.mdx': mdx('A', 'Body A.'),
        'docs/b.mdx': mdx('B', 'Body B.'),
      }),
    });
    expect((await rows()).map(row => row.slug)).toEqual(['docs/a', 'docs/b']);

    const report = await reconcileDocsIndex({
      reader: reader([blob('docs/a.mdx', 'aaa')], { 'docs/a.mdx': mdx('A', 'Body A.') }),
    });

    expect(report.deleted).toBe(1);
    expect((await rows()).map(row => row.slug)).toEqual(['docs/a']);
  });

  it('does NOT sweep when the tree could not be trusted', async () => {
    await reconcileDocsIndex({
      reader: reader([blob('docs/a.mdx', 'aaa')], { 'docs/a.mdx': mdx('A', 'Body A.') }),
    });
    expect(await rows()).toHaveLength(1);

    // The failure this guard exists for: `slug <> ALL('{}'::text[])` matches
    // every row, so a truncated or empty tree taken at face value empties the
    // corpus. Against a real database, that is the difference between one row
    // and none.
    const truncated = {
      head: async () => COMMIT,
      tree: async () => ({ entries: [] as never, truncated: true }),
      body: async () => null,
    };
    const report = await reconcileDocsIndex({ reader: truncated });

    expect(report.halted).toBe('tree_invalid');
    expect(await rows()).toHaveLength(1);
  });

  it('is idempotent: a second run indexes nothing and deletes nothing', async () => {
    const same = () => reader([blob('docs/a.mdx', 'aaa')], { 'docs/a.mdx': mdx('A', 'Body A.') });

    await reconcileDocsIndex({ reader: same() });
    const first = await rows();

    const report = await reconcileDocsIndex({ reader: same() });

    expect(report.indexed).toBe(0);
    expect(report.byReason.fresh).toBe(1);
    expect(report.deleted).toBe(0);
    // Freshness is read out of the real row, so this is the proof that the
    // stamp written and the stamp compared are the same three values.
    expect(await rows()).toEqual(first);
  });

  it('finishes a half-written document rather than calling it fresh', async () => {
    await reconcileDocsIndex({
      reader: reader([blob('docs/a.mdx', 'aaa')], { 'docs/a.mdx': mdx('A', 'Body A.') }),
    });
    // Simulate the write that died between chunks: the stored row claims there
    // are two, and only one is there.
    await getPrisma().$executeRaw`UPDATE docs_index SET chunk_count = 2 WHERE slug = 'docs/a'`;

    const report = await reconcileDocsIndex({
      reader: reader([blob('docs/a.mdx', 'aaa')], { 'docs/a.mdx': mdx('A', 'Body A.') }),
    });

    expect(report.indexed).toBe(1);
    const after = await rows();
    expect(after).toHaveLength(1);
    expect(after[0].chunk_count).toBe(1);
  });
});
