/**
 * The indexer against a REAL Postgres.
 *
 * Everything this file covers is exactly what a fake Prisma would agree with
 * whatever the service did, and is therefore the part most worth running for
 * real:
 *
 *   - `embedding` is an `Unsupported("vector(1024)")` column. Prisma Client
 *     cannot see it, so every read and write of it is raw SQL, and the ONLY
 *     proof that the `'[…]'::vector` parameter, the 4-column `ON CONFLICT`
 *     target and the 1,024-dimension width all line up is a row landing in
 *     pgvector;
 *   - `updated_at` has `@updatedAt` in the schema, which is a Prisma CLIENT
 *     feature. A raw upsert goes straight past it, so the statement sets the
 *     column by hand — and only a real UPDATE can show the value moved;
 *   - the shrink delete and the reconcile's plan are SQL, not TypeScript.
 *
 * Workers AI is mocked — no test in this repo may reach Cloudflare. The
 * extractor is REAL, because "what does a content.json actually extract to" is
 * half of what makes the stored row right.
 *
 * SAFETY: every fixture is namespaced with a fresh uuid and torn down in
 * `afterAll` by deleting the git organization, which cascades classroom →
 * pages → slides → content_assets → content_index. Nothing is truncated and no
 * pre-existing row is touched.
 *
 * Skipped unless DATABASE_URL names a LOCAL database. The house rule (see
 * forms.integration.test.ts) also refuses the SHARED dev database by name,
 * because a bare `vitest` run in a worktree still points at it —
 * `CONTENT_INDEX_INTEGRATION=1` is the deliberate opt-in for running it there.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';

const DATABASE_URL = process.env.DATABASE_URL ?? '';
const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(DATABASE_URL);
const isSharedDevDb = /\/classmoji(\?|$)/.test(DATABASE_URL);
const optedIn = process.env.CONTENT_INDEX_INTEGRATION === '1';
const RUN = Boolean(DATABASE_URL) && isLocal && (!isSharedDevDb || optedIn);

/** A deterministic unit vector, so a stored row can be compared exactly. */
const vectorFor = (text: string): number[] =>
  Array.from({ length: 1024 }, (_, i) => ((text.length + i) % 17) / 17);

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
const { EXTRACT_VERSION, indexOneFile, planClassroomIndex, reconcileContentIndex } =
  await import('../contentIndex.service.ts');
const { EMBEDDING_MODEL } = await import('../../helpers/workersAi.ts');

/** One BlockNote document, in the wrapper shape the editor writes. */
const contentJson = (paragraphs: string[]) =>
  JSON.stringify({
    blocks: paragraphs.map((text, index) => ({
      id: `b${index}`,
      type: 'paragraph',
      props: {},
      content: [{ type: 'text', text, styles: {} }],
      children: [],
    })),
  });

describe.skipIf(!RUN)('contentIndex (integration)', () => {
  const suite = randomUUID().slice(0, 8);
  const prisma = getPrisma();

  let orgId: string;
  let classroomId: string;
  let userId: string;
  let pageId: string;
  let slideId: string;

  const PAGE_PATH = 'pages/lab-1/content.json';
  const DECK_PATH = 'slides/lecture-1/index.html';
  const PAGE_SHA = 'a'.repeat(40);
  const DECK_SHA = 'b'.repeat(40);

  const PAGE_BODY = contentJson(['Office hours are Tuesday at four.']);
  const DECK_BODY = `<!doctype html><html><head><title>Lecture 1</title></head><body>
    <div class="reveal"><div class="slides">
      <section><h1>Recursion</h1><p>A function that calls itself.</p></section>
    </div></div></body></html>`;

  const recordAsset = (path: string, sha: string) =>
    prisma.contentAsset.upsert({
      where: { classroom_id_path: { classroom_id: classroomId, path } },
      create: { classroom_id: classroomId, path, sha, type: 'blob', synced_at: new Date() },
      update: { sha, synced_at: new Date() },
    });

  /** Every stored chunk, including the column Prisma Client cannot select. */
  const storedRows = (kind: string, docId: string) =>
    prisma.$queryRaw<
      Array<{
        chunk_ix: number;
        chunk_count: number;
        source_path: string;
        source_sha: string;
        extract_version: number;
        embed_model: string;
        title: string;
        text: string;
        dims: number | null;
        updated_at: Date;
      }>
    >`
      SELECT chunk_ix, chunk_count, source_path, source_sha, extract_version, embed_model,
             title, text, vector_dims(embedding) AS dims, updated_at
      FROM content_index
      WHERE classroom_id = ${classroomId} AND doc_kind = ${kind} AND doc_id = ${docId}
      ORDER BY chunk_ix
    `;

  beforeAll(async () => {
    const org = await prisma.gitOrganization.create({
      data: {
        provider: 'GITHUB',
        provider_id: `cindex-${suite}`,
        login: `cindex-org-${suite}`,
      },
    });
    orgId = org.id;

    const classroom = await prisma.classroom.create({
      data: {
        slug: `cindex-${suite}`,
        git_org_id: orgId,
        name: `Content Index ${suite}`,
        content_namespace: `cindex-${suite}`,
        content_repo: `content-cindex-${suite}`,
      },
    });
    classroomId = classroom.id;

    const user = await prisma.user.create({
      data: {
        login: `cindex-${suite}-owner`,
        email: `cindex-${suite}@example.test`,
        name: 'Content Index Owner',
      },
    });
    userId = user.id;

    const page = await prisma.page.create({
      data: {
        classroom_id: classroomId,
        title: 'Lab 1',
        slug: `lab-1-${suite}`,
        content_path: 'pages/lab-1',
        created_by: userId,
      },
    });
    pageId = page.id;

    const slide = await prisma.slide.create({
      data: {
        classroom_id: classroomId,
        title: 'Lecture 1',
        slug: `lecture-1-${suite}`,
        content_path: 'slides/lecture-1',
        created_by: userId,
      },
    });
    slideId = slide.id;

    await recordAsset(PAGE_PATH, PAGE_SHA);
    await recordAsset(DECK_PATH, DECK_SHA);
  });

  afterAll(async () => {
    // Cascades: classroom → pages, slides, content_assets, content_index.
    if (orgId) await prisma.gitOrganization.delete({ where: { id: orgId } }).catch(() => {});
    if (userId) await prisma.user.delete({ where: { id: userId } }).catch(() => {});
  });

  beforeEach(() => {
    delete process.env.CLOUDFLARE_WORKERS_AI_EMBED_MAX_TOKENS;
    embedTextsMock.mockReset();
    embedTextsMock.mockImplementation(async (texts: string[]) => ({
      ok: true,
      vectors: texts.map(vectorFor),
    }));
  });

  it('writes a real 1,024-dimension vector through the raw upsert', async () => {
    const result = await indexOneFile({
      classroomId,
      path: PAGE_PATH,
      sha: PAGE_SHA,
      body: PAGE_BODY,
      docHint: { kind: 'page', id: pageId, title: 'Lab 1' },
    });
    expect(result).toEqual({ outcome: 'indexed', chunks: 1 });

    const rows = await storedRows('page', pageId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      chunk_ix: 0,
      chunk_count: 1,
      source_path: PAGE_PATH,
      source_sha: PAGE_SHA,
      extract_version: EXTRACT_VERSION,
      embed_model: EMBEDDING_MODEL,
      title: 'Lab 1',
    });
    // The real extractor ran: the title leads and the paragraph survived.
    expect(rows[0].text).toContain('Lab 1');
    expect(rows[0].text).toContain('Office hours are Tuesday at four.');
    // pgvector agrees it is a vector of the width the column declares.
    expect(rows[0].dims).toBe(1024);
  });

  it('is a no-op on the second run, and moves updated_at when it is not', async () => {
    const before = (await storedRows('page', pageId))[0];

    embedTextsMock.mockClear();
    expect(
      await indexOneFile({
        classroomId,
        path: PAGE_PATH,
        sha: PAGE_SHA,
        body: PAGE_BODY,
        docHint: { kind: 'page', id: pageId, title: 'Lab 1' },
      })
    ).toEqual({ outcome: 'skipped', reason: 'fresh' });
    expect(embedTextsMock).not.toHaveBeenCalled();

    // A new sha re-indexes, and `updated_at` moves — which is the assertion
    // that `@updatedAt` being bypassed by raw SQL is actually compensated for.
    const nextSha = 'c'.repeat(40);
    await recordAsset(PAGE_PATH, nextSha);
    await indexOneFile({
      classroomId,
      path: PAGE_PATH,
      sha: nextSha,
      body: contentJson(['Office hours moved to Thursday at three.']),
      docHint: { kind: 'page', id: pageId, title: 'Lab 1' },
    });

    const after = (await storedRows('page', pageId))[0];
    expect(after.source_sha).toBe(nextSha);
    expect(after.text).toContain('Thursday');
    expect(after.updated_at.getTime()).toBeGreaterThanOrEqual(before.updated_at.getTime());
  });

  it('deletes the tail in SQL when a document shrinks', async () => {
    process.env.CLOUDFLARE_WORKERS_AI_EMBED_MAX_TOKENS = '40'; // a 120-char budget

    const longSha = 'd'.repeat(40);
    await recordAsset(PAGE_PATH, longSha);
    expect(
      await indexOneFile({
        classroomId,
        path: PAGE_PATH,
        sha: longSha,
        body: contentJson(['A'.repeat(70), 'B'.repeat(70), 'C'.repeat(70)]),
        docHint: { kind: 'page', id: pageId, title: 'Lab 1' },
      })
    ).toMatchObject({ outcome: 'indexed' });
    expect((await storedRows('page', pageId)).length).toBeGreaterThan(1);

    const shortSha = 'e'.repeat(40);
    await recordAsset(PAGE_PATH, shortSha);
    expect(
      await indexOneFile({
        classroomId,
        path: PAGE_PATH,
        sha: shortSha,
        body: contentJson(['A'.repeat(20)]),
        docHint: { kind: 'page', id: pageId, title: 'Lab 1' },
      })
    ).toEqual({ outcome: 'indexed', chunks: 1 });

    const rows = await storedRows('page', pageId);
    expect(rows).toHaveLength(1);
    expect(rows[0].chunk_count).toBe(1);
  });

  it('reconciles the fixture classroom and reports what it did', async () => {
    // Reset both documents to a known, un-indexed state.
    await prisma.$executeRaw`DELETE FROM content_index WHERE classroom_id = ${classroomId}`;
    await recordAsset(PAGE_PATH, PAGE_SHA);
    await recordAsset(DECK_PATH, DECK_SHA);

    const plan = await planClassroomIndex(classroomId);
    expect(plan.items.map(item => item.path).sort()).toEqual([PAGE_PATH, DECK_PATH].sort());

    const bodies: Record<string, { text: string; sha: string }> = {
      [PAGE_PATH]: { text: PAGE_BODY, sha: PAGE_SHA },
      [DECK_PATH]: { text: DECK_BODY, sha: DECK_SHA },
    };

    const report = await reconcileContentIndex({
      classroomIds: [classroomId],
      fetchBody: async (_classroom, path) => bodies[path] ?? null,
    });

    expect(report).toMatchObject({
      classrooms: 1,
      eligible: 2,
      indexed: 2,
      failed: 0,
      orphansDeleted: 0,
    });

    const deckRows = await storedRows('slide', slideId);
    expect(deckRows).toHaveLength(1);
    expect(deckRows[0].dims).toBe(1024);
    expect(deckRows[0].text).toContain('Recursion');

    // A second run finds nothing, which is the property that makes this safe to
    // schedule nightly over the whole fleet.
    const second = await reconcileContentIndex({
      classroomIds: [classroomId],
      fetchBody: async (_classroom, path) => bodies[path] ?? null,
    });
    expect(second).toMatchObject({ eligible: 0, indexed: 0 });
  });

  it('sweeps a row whose document is gone', async () => {
    const goneId = `gone-${suite}`;
    await prisma.$executeRaw`
      INSERT INTO content_index
        (classroom_id, doc_kind, doc_id, chunk_ix, chunk_count, source_path, source_sha,
         extract_version, embed_model, title, text, embedding, indexed_at, updated_at)
      VALUES
        (${classroomId}, 'page', ${goneId}, 0, 1, 'pages/gone/content.json', ${'f'.repeat(40)},
         ${EXTRACT_VERSION}, ${EMBEDDING_MODEL}, 'Gone', 'gone',
         ${`[${vectorFor('gone').join(',')}]`}::vector, NOW(), NOW())
    `;

    const report = await reconcileContentIndex({
      classroomIds: [classroomId],
      fetchBody: async () => null,
    });

    expect(report.orphansDeleted).toBe(1);
    expect(await storedRows('page', goneId)).toHaveLength(0);
  });
});
