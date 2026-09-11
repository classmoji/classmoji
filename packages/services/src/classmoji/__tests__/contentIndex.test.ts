/**
 * The indexer, on its own.
 *
 * `content_index` is the only thing standing between a student's question and
 * the right page, and every way it can be wrong is silent: a stale row still
 * ranks, an empty row still ranks, a chunk left over from a longer draft still
 * ranks. Nothing downstream can tell the difference between a good answer and a
 * confident one out of content that is no longer there.
 *
 * So this suite is about what the WRITE refuses to do:
 *
 *   - it never embeds anything that is not a document (assets, `deck.json`,
 *     thumbnails, `.classmoji/`, a CSV somebody dropped in `bot-context/`);
 *   - it never re-embeds a document that has not moved — the sha, the extractor
 *     version and the model are all part of "has not moved";
 *   - it never replaces a good row with a bad one: an unreadable save and a
 *     document that extracts to nothing both LEAVE WHAT IS THERE;
 *   - it never leaves a shrunk document's tail behind;
 *   - it never writes bytes under a sha the repo has already moved past;
 *   - and with no Workers AI token it touches nothing at all, because that is
 *     the state most of the fleet runs in.
 *
 * Workers AI is mocked throughout — no test in this repo may reach Cloudflare.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── The fake database ───────────────────────────────────────────────────────
// `embedding` is an `Unsupported` column, so every read and write of it is raw
// SQL and there is nothing typed to stub. The fake therefore matches on the SQL
// itself, which has the side effect of pinning the statements' shape: rename a
// column in the service and these stop matching.

interface IndexRow {
  classroom_id: string;
  doc_kind: string;
  doc_id: string;
  chunk_ix: number;
  chunk_count: number;
  source_path: string;
  source_sha: string;
  extract_version: number;
  embed_model: string;
  title: string;
  text: string;
  embedding: string | null;
}

const indexRows: IndexRow[] = [];
const assetShas = new Map<string, string>();
const pageRows: Array<{ id: string; title: string; content_path: string; classroom_id: string }> =
  [];
const slideRows: Array<{ id: string; title: string; content_path: string; classroom_id: string }> =
  [];

/** Every raw statement the service ran, for the assertions that count them. */
const statements: string[] = [];

const assetKey = (classroomId: string, path: string) => `${classroomId}:${path}`;

/**
 * `Prisma.join` nests a `Sql` inside the values array; flatten it out.
 *
 * Duck-typed rather than `instanceof Prisma.Sql`: that name is a TYPE in
 * @prisma/client v6 and is `undefined` at runtime.
 */
function flatten(values: unknown[]): unknown[] {
  return values.flatMap(value =>
    value && typeof value === 'object' && 'values' in value && 'strings' in value
      ? flatten((value as { values: unknown[] }).values)
      : [value]
  );
}

function runExecuteRaw(strings: TemplateStringsArray, values: unknown[]): number {
  const sql = strings.join(' ? ');
  statements.push(sql);

  if (sql.includes('INSERT INTO content_index')) {
    const [
      classroom_id,
      doc_kind,
      doc_id,
      chunk_ix,
      chunk_count,
      source_path,
      source_sha,
      extract_version,
      embed_model,
      title,
      text,
      embedding,
    ] = values as [
      string,
      string,
      string,
      number,
      number,
      string,
      string,
      number,
      string,
      string,
      string,
      string,
    ];
    const row: IndexRow = {
      classroom_id,
      doc_kind,
      doc_id,
      chunk_ix,
      chunk_count,
      source_path,
      source_sha,
      extract_version,
      embed_model,
      title,
      text,
      embedding,
    };
    const at = indexRows.findIndex(
      existing =>
        existing.classroom_id === classroom_id &&
        existing.doc_kind === doc_kind &&
        existing.doc_id === doc_id &&
        existing.chunk_ix === chunk_ix
    );
    if (at === -1) indexRows.push(row);
    else indexRows[at] = row;
    return 1;
  }

  if (sql.includes('DELETE FROM content_index') && sql.includes('chunk_ix >=')) {
    const [classroom_id, doc_kind, doc_id, from] = values as [string, string, string, number];
    let deleted = 0;
    for (let at = indexRows.length - 1; at >= 0; at -= 1) {
      const row = indexRows[at];
      if (
        row.classroom_id === classroom_id &&
        row.doc_kind === doc_kind &&
        row.doc_id === doc_id &&
        row.chunk_ix >= from
      ) {
        indexRows.splice(at, 1);
        deleted += 1;
      }
    }
    return deleted;
  }

  if (sql.includes('DELETE FROM content_index')) {
    const [classroom_id, ...rest] = flatten(values) as string[];
    const orphans = new Set<string>();
    for (let at = 0; at < rest.length; at += 2) orphans.add(`${rest[at]} ${rest[at + 1]}`);
    let deleted = 0;
    for (let at = indexRows.length - 1; at >= 0; at -= 1) {
      const row = indexRows[at];
      if (row.classroom_id === classroom_id && orphans.has(`${row.doc_kind} ${row.doc_id}`)) {
        indexRows.splice(at, 1);
        deleted += 1;
      }
    }
    return deleted;
  }

  throw new Error(`unexpected statement: ${sql}`);
}

function runQueryRaw(strings: TemplateStringsArray, values: unknown[]): unknown[] {
  const sql = strings.join(' ? ');
  statements.push(sql);

  if (!sql.includes('FROM content_index')) throw new Error(`unexpected query: ${sql}`);

  const scoped = sql.includes('doc_kind =');
  const [classroomId, kind, docId] = values as [string, string, string];
  return indexRows
    .filter(row => row.classroom_id === classroomId)
    .filter(row => (scoped ? row.doc_kind === kind && row.doc_id === docId : true))
    .sort((a, b) => a.chunk_ix - b.chunk_ix)
    .map(row => ({
      doc_kind: row.doc_kind,
      doc_id: row.doc_id,
      chunk_ix: row.chunk_ix,
      chunk_count: row.chunk_count,
      source_sha: row.source_sha,
      extract_version: row.extract_version,
      embed_model: row.embed_model,
      embedding_null: row.embedding === null,
    }));
}

const contentAsset = {
  findUnique: async ({
    where,
  }: {
    where: { classroom_id_path: { classroom_id: string; path: string } };
  }) => {
    const sha = assetShas.get(
      assetKey(where.classroom_id_path.classroom_id, where.classroom_id_path.path)
    );
    return sha ? { sha } : null;
  },
  findMany: async ({ where }: { where: { classroom_id: string } }) =>
    [...assetShas.entries()]
      .filter(([key]) => key.startsWith(`${where.classroom_id}:`))
      .map(([key, sha]) => ({ path: key.slice(where.classroom_id.length + 1), sha })),
};

const fakePrisma = {
  contentAsset,
  page: {
    findUnique: async ({ where }: { where: { id: string } }) =>
      pageRows.find(row => row.id === where.id) ?? null,
    findFirst: async ({ where }: { where: { classroom_id: string; content_path: string } }) =>
      pageRows.find(
        row => row.classroom_id === where.classroom_id && row.content_path === where.content_path
      ) ?? null,
    findMany: async ({ where }: { where: { classroom_id: string } }) =>
      pageRows.filter(row => row.classroom_id === where.classroom_id),
    groupBy: async () =>
      [...new Set(pageRows.map(row => row.classroom_id))].map(id => ({
        classroom_id: id,
      })),
  },
  slide: {
    findUnique: async ({ where }: { where: { id: string } }) =>
      slideRows.find(row => row.id === where.id) ?? null,
    findFirst: async ({ where }: { where: { classroom_id: string; content_path: string } }) =>
      slideRows.find(
        row => row.classroom_id === where.classroom_id && row.content_path === where.content_path
      ) ?? null,
    findMany: async ({ where }: { where: { classroom_id: string } }) =>
      slideRows.filter(row => row.classroom_id === where.classroom_id),
    groupBy: async () =>
      [...new Set(slideRows.map(row => row.classroom_id))].map(id => ({
        classroom_id: id,
      })),
  },
  classroom: {
    findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
      where.id.in.map(id => ({
        id,
        slug: `slug-${id}`,
        content_key_version: 1,
        content_repo: 'content-test-org-cs101',
        content_delivery_enabled: false,
        git_organization: { login: 'test-org' },
      })),
  },
  $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) =>
    runQueryRaw(strings, values),
  $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) =>
    runExecuteRaw(strings, values),
  $transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
    fn({
      contentAsset,
      $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) =>
        runExecuteRaw(strings, values),
    }),
};

vi.mock('@classmoji/database', () => ({ default: () => fakePrisma }));

// ─── Workers AI ──────────────────────────────────────────────────────────────
// Only the two functions that reach the network are replaced; the cap and the
// token estimate stay real, because the chunker's whole job is to respect them.

const embedTextsMock = vi.fn();
const configuredMock = vi.fn(() => true);

vi.mock('../../helpers/workersAi.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('../../helpers/workersAi.ts')>();
  return {
    ...actual,
    isWorkersAiConfigured: () => configuredMock(),
    embedTexts: (...args: unknown[]) => embedTextsMock(...args),
  };
});

// ─── The extractor ───────────────────────────────────────────────────────────
// Mocked so the unit suite never loads cheerio, and so `ok: false` is reachable
// on demand. Its real behaviour has its own tests under `content/extract`.

const extractTextMock = vi.fn();
vi.mock('../../content/extract/index.ts', () => ({
  extractText: (...args: unknown[]) => extractTextMock(...args),
}));

const {
  EXTRACT_VERSION,
  chunkDocument,
  classifyPath,
  deleteOrphans,
  indexOneFile,
  isFresh,
  planClassroomIndex,
  reconcileContentIndex,
  splitIntoPieces,
} = await import('../contentIndex.service.ts');
const { EMBEDDING_MODEL } = await import('../../helpers/workersAi.ts');

const CLASSROOM = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const PAGE_ID = 'page-1';
const PAGE_PATH = 'pages/lab-1/content.json';
const SHA = 'a'.repeat(40);

/** A deterministic vector, so a stored row can be compared without a network. */
const vectorFor = (text: string) =>
  Array.from({ length: 1024 }, (_, i) => ((text.length + i) % 17) / 17);

beforeEach(() => {
  vi.clearAllMocks();
  indexRows.length = 0;
  statements.length = 0;
  assetShas.clear();
  pageRows.length = 0;
  slideRows.length = 0;
  delete process.env.CLOUDFLARE_WORKERS_AI_EMBED_MAX_TOKENS;

  configuredMock.mockReturnValue(true);
  embedTextsMock.mockImplementation(async (texts: string[]) => ({
    ok: true,
    vectors: texts.map(vectorFor),
  }));
  extractTextMock.mockImplementation((_source: unknown, opts: { title?: string } = {}) => ({
    ok: true,
    text: [opts.title, 'Lab one covers recursion.'].filter(Boolean).join('\n'),
    notes: '',
    references: [],
  }));

  pageRows.push({
    id: PAGE_ID,
    title: 'Lab 1',
    content_path: 'pages/lab-1',
    classroom_id: CLASSROOM,
  });
  assetShas.set(assetKey(CLASSROOM, PAGE_PATH), SHA);

  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

const rowsFor = (kind: string, id: string) =>
  indexRows.filter(row => row.doc_kind === kind && row.doc_id === id);

// ─── The path mapper ─────────────────────────────────────────────────────────

describe('classifyPath', () => {
  it('maps the three document shapes and nothing else', () => {
    expect(classifyPath('pages/lab-1/content.json')).toMatchObject({
      indexable: true,
      target: { kind: 'page', extract: 'blocknote', docPath: 'pages/lab-1', legacy: false },
    });
    expect(classifyPath('pages/lab-1/index.html')).toMatchObject({
      indexable: true,
      target: { kind: 'page', extract: 'page-html', legacy: true },
    });
    expect(classifyPath('slides/lecture-1/index.html')).toMatchObject({
      indexable: true,
      target: { kind: 'slide', extract: 'deck-html', docPath: 'slides/lecture-1' },
    });
    expect(classifyPath('bot-context/faq.md')).toMatchObject({
      indexable: true,
      target: { kind: 'file', extract: 'plain-text', docPath: 'bot-context/faq.md' },
    });
  });

  it.each([
    // The one a prefix test would get wrong, and the reason the mapper counts
    // segments: every uploaded image lives under `pages/`.
    'pages/lab-1/assets/diagram.png',
    'pages/lab-1/cover.png',
    // deck.json is the SOURCE; index.html beside it is the document.
    'slides/lecture-1/deck.json',
    'slides/lecture-1/thumbnail.webp',
    '.classmoji/manifest.json',
    '.slidesthemes/dark/theme.css',
    // Instructor-authored does not mean prose.
    'bot-context/roster.csv',
    'bot-context/',
    'README.md',
  ])('refuses %s', path => {
    expect(classifyPath(path).indexable).toBe(false);
  });

  it('refuses a path that escapes the repo', () => {
    expect(classifyPath('pages/../../etc/passwd').indexable).toBe(false);
  });
});

// ─── The chunker ─────────────────────────────────────────────────────────────

describe('the chunker', () => {
  it('keeps a document that fits in one row', () => {
    expect(chunkDocument('Lab 1\nShort enough.', 'Lab 1')).toEqual(['Lab 1\nShort enough.']);
  });

  it('splits a document just over the cap at a paragraph boundary', () => {
    // 40 tokens × 3 chars/token = a 120-character budget.
    process.env.CLOUDFLARE_WORKERS_AI_EMBED_MAX_TOKENS = '40';

    const first = 'A'.repeat(70);
    const second = 'B'.repeat(70);
    const chunks = chunkDocument(`${first}\n\n${second}`, 'Lab 1');

    expect(chunks).toHaveLength(2);
    // The boundary is the blank line, NOT an arbitrary character offset: no
    // chunk holds a piece of the other paragraph.
    expect(chunks[0]).toBe(first);
    expect(chunks[1]).toBe(`Lab 1\n${second}`);
  });

  it('falls back to sentences when one paragraph is too long', () => {
    process.env.CLOUDFLARE_WORKERS_AI_EMBED_MAX_TOKENS = '40';
    const paragraph = `${'A'.repeat(80)}. ${'B'.repeat(80)}.`;
    const chunks = chunkDocument(paragraph, '');
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toBe(`${'A'.repeat(80)}.`);
  });

  it('never emits a piece over budget, even with nothing to split on', () => {
    const pieces = splitIntoPieces('X'.repeat(1000), 100);
    expect(pieces.length).toBeGreaterThan(1);
    expect(Math.max(...pieces.map(piece => piece.length))).toBeLessThanOrEqual(100);
  });
});

// ─── indexOneFile ────────────────────────────────────────────────────────────

describe('indexOneFile', () => {
  it('indexes a page save into one row, and embeds the title with the body', async () => {
    const result = await indexOneFile({
      classroomId: CLASSROOM,
      path: PAGE_PATH,
      sha: SHA,
      body: '{"blocks":[]}',
      docHint: { kind: 'page', id: PAGE_ID, title: 'Lab 1' },
    });

    expect(result).toEqual({ outcome: 'indexed', chunks: 1 });
    expect(embedTextsMock).toHaveBeenCalledTimes(1);
    expect(embedTextsMock.mock.calls[0][0]).toEqual(['Lab 1\nLab one covers recursion.']);

    expect(rowsFor('page', PAGE_ID)).toHaveLength(1);
    expect(rowsFor('page', PAGE_ID)[0]).toMatchObject({
      chunk_ix: 0,
      chunk_count: 1,
      source_path: PAGE_PATH,
      source_sha: SHA,
      extract_version: EXTRACT_VERSION,
      embed_model: EMBEDDING_MODEL,
      title: 'Lab 1',
    });
    expect(rowsFor('page', PAGE_ID)[0].embedding).not.toBeNull();
  });

  it('sets updated_at itself, because a raw upsert goes past @updatedAt', async () => {
    await indexOneFile({
      classroomId: CLASSROOM,
      path: PAGE_PATH,
      sha: SHA,
      body: '{"blocks":[]}',
      docHint: { kind: 'page', id: PAGE_ID, title: 'Lab 1' },
    });
    const insert = statements.find(sql => sql.includes('INSERT INTO content_index'));
    expect(insert).toMatch(/updated_at\s*=\s*NOW\(\)/);
  });

  it('uses the caller’s record rather than resolving the path', async () => {
    // Two pages share a content_path — legal, because it carries no unique
    // constraint — so a findFirst would pick one of them arbitrarily.
    pageRows.push({
      id: 'page-2',
      title: 'Lab 1 (copy)',
      content_path: 'pages/lab-1',
      classroom_id: CLASSROOM,
    });

    await indexOneFile({
      classroomId: CLASSROOM,
      path: PAGE_PATH,
      sha: SHA,
      body: '{"blocks":[]}',
      docHint: { kind: 'page', id: 'page-2', title: 'Lab 1 (copy)' },
    });

    expect(rowsFor('page', 'page-2')).toHaveLength(1);
    expect(rowsFor('page', PAGE_ID)).toHaveLength(0);
  });

  it('never embeds an asset', async () => {
    const result = await indexOneFile({
      classroomId: CLASSROOM,
      path: 'pages/lab-1/assets/diagram.png',
      sha: SHA,
      body: 'not text',
    });
    expect(result).toEqual({ outcome: 'skipped', reason: 'not_indexable' });
    expect(embedTextsMock).not.toHaveBeenCalled();
    expect(indexRows).toHaveLength(0);
  });

  it('prefers content.json: a legacy index.html beside one is skipped', async () => {
    assetShas.set(assetKey(CLASSROOM, 'pages/lab-1/content.json'), SHA);
    const result = await indexOneFile({
      classroomId: CLASSROOM,
      path: 'pages/lab-1/index.html',
      sha: 'b'.repeat(40),
      body: '<h1>old</h1>',
      docHint: { kind: 'page', id: PAGE_ID, title: 'Lab 1' },
    });
    expect(result).toEqual({ outcome: 'skipped', reason: 'legacy_superseded' });
    expect(embedTextsMock).not.toHaveBeenCalled();
  });

  it('indexes a legacy index.html when there is no content.json', async () => {
    assetShas.clear();
    assetShas.set(assetKey(CLASSROOM, 'pages/lab-1/index.html'), SHA);
    const result = await indexOneFile({
      classroomId: CLASSROOM,
      path: 'pages/lab-1/index.html',
      sha: SHA,
      body: '<h1>old</h1>',
      docHint: { kind: 'page', id: PAGE_ID, title: 'Lab 1' },
    });
    expect(result).toEqual({ outcome: 'indexed', chunks: 1 });
  });

  it('does not re-embed an unchanged document', async () => {
    const args = {
      classroomId: CLASSROOM,
      path: PAGE_PATH,
      sha: SHA,
      body: '{"blocks":[]}',
      docHint: { kind: 'page' as const, id: PAGE_ID, title: 'Lab 1' },
    };
    await indexOneFile(args);
    embedTextsMock.mockClear();

    expect(await indexOneFile(args)).toEqual({ outcome: 'skipped', reason: 'fresh' });
    expect(embedTextsMock).not.toHaveBeenCalled();
  });

  it('re-embeds when the sha moves', async () => {
    const base = {
      classroomId: CLASSROOM,
      path: PAGE_PATH,
      body: '{"blocks":[]}',
      docHint: { kind: 'page' as const, id: PAGE_ID, title: 'Lab 1' },
    };
    await indexOneFile({ ...base, sha: SHA });
    assetShas.set(assetKey(CLASSROOM, PAGE_PATH), 'c'.repeat(40));
    embedTextsMock.mockClear();

    expect(await indexOneFile({ ...base, sha: 'c'.repeat(40) })).toMatchObject({
      outcome: 'indexed',
    });
    expect(embedTextsMock).toHaveBeenCalledTimes(1);
    expect(rowsFor('page', PAGE_ID)[0].source_sha).toBe('c'.repeat(40));
  });

  it('re-indexes when the extractor version moves, even at the same sha', () => {
    // Expressed against the predicate rather than by faking a deploy: the
    // stamp is three fields and any of them moving has to count.
    const stored = [
      {
        chunk_ix: 0,
        chunk_count: 1,
        source_sha: SHA,
        extract_version: EXTRACT_VERSION - 1,
        embed_model: EMBEDDING_MODEL,
        embedding_null: false,
      },
    ];
    expect(
      isFresh(stored, {
        sourceSha: SHA,
        extractVersion: EXTRACT_VERSION,
        embedModel: EMBEDDING_MODEL,
      })
    ).toBe(false);
  });

  it('treats a half-written multi-chunk document as stale', () => {
    const stamp = {
      sourceSha: SHA,
      extractVersion: EXTRACT_VERSION,
      embedModel: EMBEDDING_MODEL,
    };
    const chunk = (chunk_ix: number, embedding_null = false) => ({
      chunk_ix,
      chunk_count: 3,
      source_sha: SHA,
      extract_version: EXTRACT_VERSION,
      embed_model: EMBEDDING_MODEL,
      embedding_null,
    });

    expect(isFresh([chunk(0), chunk(1), chunk(2)], stamp)).toBe(true);
    // Chunk 2 never landed.
    expect(isFresh([chunk(0), chunk(1)], stamp)).toBe(false);
    // Chunk 1's embedding call failed.
    expect(isFresh([chunk(0), chunk(1, true), chunk(2)], stamp)).toBe(false);
  });

  it('leaves the last good row alone when extraction fails', async () => {
    const args = {
      classroomId: CLASSROOM,
      path: PAGE_PATH,
      sha: SHA,
      body: '{"blocks":[]}',
      docHint: { kind: 'page' as const, id: PAGE_ID, title: 'Lab 1' },
    };
    await indexOneFile(args);
    const good = { ...rowsFor('page', PAGE_ID)[0] };

    extractTextMock.mockReturnValue({
      ok: false,
      text: '',
      notes: '',
      references: [],
      error: 'malformed content.json',
    });
    assetShas.set(assetKey(CLASSROOM, PAGE_PATH), 'd'.repeat(40));

    const result = await indexOneFile({ ...args, sha: 'd'.repeat(40), body: 'not json' });

    expect(result).toEqual({ outcome: 'failed', reason: 'extract' });
    // Not blanked, not deleted, not re-stamped with the new sha.
    expect(rowsFor('page', PAGE_ID)).toEqual([good]);
  });

  it('never writes empty text as a success', async () => {
    extractTextMock.mockReturnValue({ ok: true, text: '   ', notes: '', references: [] });
    const result = await indexOneFile({
      classroomId: CLASSROOM,
      path: PAGE_PATH,
      sha: SHA,
      body: '{"blocks":[]}',
      docHint: { kind: 'page', id: PAGE_ID, title: '' },
    });
    expect(result).toEqual({ outcome: 'skipped', reason: 'empty' });
    expect(indexRows).toHaveLength(0);
  });

  it('deletes the tail when a document shrinks', async () => {
    process.env.CLOUDFLARE_WORKERS_AI_EMBED_MAX_TOKENS = '40';
    const args = {
      classroomId: CLASSROOM,
      path: PAGE_PATH,
      docHint: { kind: 'page' as const, id: PAGE_ID, title: 'Lab 1' },
      body: '{"blocks":[]}',
    };

    extractTextMock.mockReturnValue({
      ok: true,
      text: ['A'.repeat(70), 'B'.repeat(70), 'C'.repeat(70)].join('\n\n'),
      notes: '',
      references: [],
    });
    expect(await indexOneFile({ ...args, sha: SHA })).toEqual({ outcome: 'indexed', chunks: 3 });
    expect(rowsFor('page', PAGE_ID)).toHaveLength(3);

    // The instructor deleted two thirds of the page.
    extractTextMock.mockReturnValue({
      ok: true,
      text: 'A'.repeat(70),
      notes: '',
      references: [],
    });
    const shrunkSha = 'e'.repeat(40);
    assetShas.set(assetKey(CLASSROOM, PAGE_PATH), shrunkSha);
    expect(await indexOneFile({ ...args, sha: shrunkSha })).toEqual({
      outcome: 'indexed',
      chunks: 1,
    });

    // Chunks 1 and 2 still held perfectly good vectors of text this page no
    // longer has, and they would have gone on ranking.
    expect(rowsFor('page', PAGE_ID)).toHaveLength(1);
    expect(rowsFor('page', PAGE_ID)[0].chunk_count).toBe(1);
  });

  it('aborts when a second save overtook the embedding', async () => {
    // The map moved while the (slow) embed call was in flight.
    embedTextsMock.mockImplementation(async (texts: string[]) => {
      assetShas.set(assetKey(CLASSROOM, PAGE_PATH), 'f'.repeat(40));
      return { ok: true, vectors: texts.map(vectorFor) };
    });

    const result = await indexOneFile({
      classroomId: CLASSROOM,
      path: PAGE_PATH,
      sha: SHA,
      body: '{"blocks":[]}',
      docHint: { kind: 'page', id: PAGE_ID, title: 'Lab 1' },
    });

    expect(result).toEqual({ outcome: 'skipped', reason: 'superseded' });
    // Nothing written: stamping these bytes with `SHA` would have made an old
    // document look fresh to every future reconcile.
    expect(indexRows).toHaveLength(0);
  });

  it('touches nothing when Workers AI is not configured', async () => {
    configuredMock.mockReturnValue(false);
    const result = await indexOneFile({
      classroomId: CLASSROOM,
      path: PAGE_PATH,
      sha: SHA,
      body: '{"blocks":[]}',
      docHint: { kind: 'page', id: PAGE_ID, title: 'Lab 1' },
    });
    expect(result).toEqual({ outcome: 'skipped', reason: 'not_configured' });
    expect(statements).toHaveLength(0);
    expect(embedTextsMock).not.toHaveBeenCalled();
  });

  it('reports an embedding fault instead of rejecting', async () => {
    embedTextsMock.mockRejectedValue(new Error('Workers AI was unreachable'));
    await expect(
      indexOneFile({
        classroomId: CLASSROOM,
        path: PAGE_PATH,
        sha: SHA,
        body: '{"blocks":[]}',
        docHint: { kind: 'page', id: PAGE_ID, title: 'Lab 1' },
      })
    ).resolves.toEqual({ outcome: 'failed', reason: 'error' });
  });

  it('never logs the body', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    embedTextsMock.mockRejectedValue(new Error('boom'));
    await indexOneFile({
      classroomId: CLASSROOM,
      path: PAGE_PATH,
      sha: SHA,
      body: 'SECRET-EXAM-ANSWER',
      docHint: { kind: 'page', id: PAGE_ID, title: 'Lab 1' },
    });
    const logged = warn.mock.calls.flat().map(String).join(' ');
    expect(logged).toContain(PAGE_PATH);
    expect(logged).toContain(CLASSROOM);
    expect(logged).not.toContain('SECRET-EXAM-ANSWER');
  });
});

// ─── The reconcile ───────────────────────────────────────────────────────────

describe('planClassroomIndex', () => {
  it('starts from the records, so a classroom with no index row has work', async () => {
    const plan = await planClassroomIndex(CLASSROOM);
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0]).toMatchObject({
      path: PAGE_PATH,
      sha: SHA,
      docHint: { kind: 'page', id: PAGE_ID, title: 'Lab 1' },
    });
  });

  it('compares against content.json when both shapes are in the map', async () => {
    // The dead legacy html still has a row and a different sha. Comparing
    // against it would make this page permanently stale.
    assetShas.set(assetKey(CLASSROOM, 'pages/lab-1/index.html'), 'b'.repeat(40));
    await indexOneFile({
      classroomId: CLASSROOM,
      path: PAGE_PATH,
      sha: SHA,
      body: '{"blocks":[]}',
      docHint: { kind: 'page', id: PAGE_ID, title: 'Lab 1' },
    });

    const plan = await planClassroomIndex(CLASSROOM);
    expect(plan.items).toHaveLength(0);
  });

  it('picks up bot-context prose and skips the rest of the folder', async () => {
    assetShas.set(assetKey(CLASSROOM, 'bot-context/faq.md'), 'b'.repeat(40));
    assetShas.set(assetKey(CLASSROOM, 'bot-context/roster.csv'), 'c'.repeat(40));

    const plan = await planClassroomIndex(CLASSROOM);
    const files = plan.items.filter(item => item.docHint.kind === 'file');
    expect(files.map(item => item.path)).toEqual(['bot-context/faq.md']);
    expect(files[0].docHint.id).toBe('bot-context/faq.md');
  });

  it('finds rows whose document is gone', async () => {
    await indexOneFile({
      classroomId: CLASSROOM,
      path: PAGE_PATH,
      sha: SHA,
      body: '{"blocks":[]}',
      docHint: { kind: 'page', id: PAGE_ID, title: 'Lab 1' },
    });
    pageRows.length = 0;

    const plan = await planClassroomIndex(CLASSROOM);
    expect(plan.orphans).toEqual([{ kind: 'page', id: PAGE_ID }]);
    expect(await deleteOrphans(CLASSROOM, plan.orphans)).toBe(1);
    expect(indexRows).toHaveLength(0);
  });

  it('counts a document with no blob in the map rather than inventing one', async () => {
    assetShas.clear();
    const plan = await planClassroomIndex(CLASSROOM);
    expect(plan.items).toHaveLength(0);
    expect(plan.missingAssets).toBe(1);
  });

  /**
   * `file` documents have no DB row — the asset map IS their record — so an
   * empty map and a repo with no files produce the identical empty live set.
   * Deleting on that would wipe every `bot-context/` row a classroom has, on
   * exactly the classrooms whose map failed to build.
   */
  describe('a `file` orphan against an empty asset map', () => {
    const FILE_PATH = 'bot-context/faq.md';
    const FILE_SHA = 'd'.repeat(40);

    /** An indexed `bot-context/` file, and then a map that no longer names it. */
    async function indexedFileThenEmptyMap(): Promise<void> {
      assetShas.set(assetKey(CLASSROOM, FILE_PATH), FILE_SHA);
      await indexOneFile({
        classroomId: CLASSROOM,
        path: FILE_PATH,
        sha: FILE_SHA,
        body: 'Office hours are Tuesdays.',
      });
      expect(rowsFor('file', FILE_PATH)).toHaveLength(1);
      assetShas.clear();
    }

    it('is HELD when nothing rebuilt the map', async () => {
      await indexedFileThenEmptyMap();

      const plan = await planClassroomIndex(CLASSROOM);
      expect(plan.orphans).toEqual([]);
      expect(plan.heldFileOrphans).toBe(1);
      expect(await deleteOrphans(CLASSROOM, plan.orphans)).toBe(0);
      expect(rowsFor('file', FILE_PATH)).toHaveLength(1);
    });

    it('is DELETED when a sync in this run rebuilt the map and it is still empty', async () => {
      await indexedFileThenEmptyMap();

      // The genuine "the repo has no files any more" case: something just
      // looked, and there is nothing there.
      const plan = await planClassroomIndex(CLASSROOM, { assetsSynced: true });
      expect(plan.orphans).toEqual([{ kind: 'file', id: FILE_PATH }]);
      expect(plan.heldFileOrphans).toBe(0);
      expect(await deleteOrphans(CLASSROOM, plan.orphans)).toBe(1);
      expect(rowsFor('file', FILE_PATH)).toHaveLength(0);
    });

    it('holds only the `file` half — a deleted page still sweeps', async () => {
      await indexOneFile({
        classroomId: CLASSROOM,
        path: PAGE_PATH,
        sha: SHA,
        body: '{"blocks":[]}',
        docHint: { kind: 'page', id: PAGE_ID, title: 'Lab 1' },
      });
      await indexedFileThenEmptyMap();
      // The page is gone from the DB, which the DB stated — no map required.
      pageRows.length = 0;

      const plan = await planClassroomIndex(CLASSROOM);
      expect(plan.orphans).toEqual([{ kind: 'page', id: PAGE_ID }]);
      expect(plan.heldFileOrphans).toBe(1);
    });

    it('holds nothing when the map simply has other files in it', async () => {
      await indexedFileThenEmptyMap();
      // A map that came back with SOMETHING is a map; the missing path is a
      // real deletion, not an outage.
      assetShas.set(assetKey(CLASSROOM, 'bot-context/syllabus.md'), 'e'.repeat(40));

      const plan = await planClassroomIndex(CLASSROOM);
      expect(plan.orphans).toEqual([{ kind: 'file', id: FILE_PATH }]);
      expect(plan.heldFileOrphans).toBe(0);
    });
  });
});

describe('reconcileContentIndex', () => {
  /** A byte source that answers from the asset map, as the real one does. */
  const fetchBody = vi.fn(async (_classroom: unknown, path: string) => ({
    text: '{"blocks":[]}',
    sha: assetShas.get(assetKey(CLASSROOM, path)) ?? null,
  }));

  beforeEach(() => {
    fetchBody.mockClear();
    vi.doMock('../contentAssets.service.ts', () => ({ ensureContentAssets: async () => null }));
  });

  it('indexes the backlog and reports what it did', async () => {
    const report = await reconcileContentIndex({ fetchBody, classroomIds: [CLASSROOM] });
    expect(report).toMatchObject({
      classrooms: 1,
      eligible: 1,
      indexed: 1,
      failed: 0,
      orphansDeleted: 0,
    });
    expect(rowsFor('page', PAGE_ID)).toHaveLength(1);
  });

  it('finds nothing to do on a second run', async () => {
    await reconcileContentIndex({ fetchBody, classroomIds: [CLASSROOM] });
    embedTextsMock.mockClear();

    const report = await reconcileContentIndex({ fetchBody, classroomIds: [CLASSROOM] });
    expect(report.eligible).toBe(0);
    expect(report.indexed).toBe(0);
    expect(embedTextsMock).not.toHaveBeenCalled();
  });

  it('refuses bytes whose sha is not the one the map names', async () => {
    // The CDN tier answers with a body and no object id at all.
    fetchBody.mockResolvedValueOnce({ text: '{"blocks":[]}', sha: null });

    const report = await reconcileContentIndex({ fetchBody, classroomIds: [CLASSROOM] });
    expect(report).toMatchObject({ failed: 1, indexed: 0 });
    expect(report.byReason.sha_mismatch).toBe(1);
    expect(indexRows).toHaveLength(0);
  });

  it('sweeps orphans even with no token, and says why nothing was indexed', async () => {
    await reconcileContentIndex({ fetchBody, classroomIds: [CLASSROOM] });
    pageRows.length = 0;
    pageRows.push({
      id: 'page-9',
      title: 'Lab 9',
      content_path: 'pages/lab-9',
      classroom_id: CLASSROOM,
    });
    assetShas.set(assetKey(CLASSROOM, 'pages/lab-9/content.json'), 'b'.repeat(40));
    configuredMock.mockReturnValue(false);
    embedTextsMock.mockClear();

    const report = await reconcileContentIndex({ fetchBody, classroomIds: [CLASSROOM] });
    expect(report.orphansDeleted).toBe(1);
    expect(report.byReason.not_configured).toBe(1);
    expect(embedTextsMock).not.toHaveBeenCalled();
  });

  it('keeps going when one classroom fails', async () => {
    const exploding = vi.fn(async (classroom: { id: string }, path: string) => {
      if (classroom.id === CLASSROOM) throw new Error('repo deleted');
      return { text: '{"blocks":[]}', sha: assetShas.get(assetKey(classroom.id, path)) ?? null };
    });
    const OTHER = 'other-classroom';
    pageRows.push({
      id: 'page-other',
      title: 'Other',
      content_path: 'pages/other',
      classroom_id: OTHER,
    });
    assetShas.set(assetKey(OTHER, 'pages/other/content.json'), 'b'.repeat(40));

    const report = await reconcileContentIndex({
      fetchBody: exploding,
      classroomIds: [CLASSROOM, OTHER],
    });

    expect(report.classrooms).toBe(2);
    expect(report.byReason.classroom_error).toBe(1);
    expect(rowsFor('page', 'page-other')).toHaveLength(1);
  });

  /**
   * The reconcile refreshes the map ITSELF rather than depending on the asset
   * sweep's timing, and the order is the whole point: a classroom nobody has
   * rendered has pages and an empty map, so planning before the sync would find
   * nothing to do on exactly the classrooms the index is missing entirely.
   */
  it('syncs the asset map BEFORE planning, and indexes what the sync returned', async () => {
    // No blob for anything, until the sync puts one there.
    assetShas.clear();
    const order: string[] = [];
    const NEW_SHA = 'f'.repeat(40);

    vi.doMock('../contentAssets.service.ts', () => ({
      ensureContentAssets: async (classroomId: string) => {
        order.push('sync');
        assetShas.set(assetKey(classroomId, PAGE_PATH), NEW_SHA);
        assetShas.set(assetKey(classroomId, 'bot-context/faq.md'), NEW_SHA);
        return { mode: 'full', upserted: 2, deleted: 0, truncated: false };
      },
    }));

    const watchedFetch = vi.fn(async (_classroom: unknown, path: string) => {
      order.push(`fetch:${path}`);
      return { text: '{"blocks":[]}', sha: assetShas.get(assetKey(CLASSROOM, path)) ?? null };
    });

    const report = await reconcileContentIndex({
      fetchBody: watchedFetch,
      classroomIds: [CLASSROOM],
    });

    // The sync ran first, and the plan it fed was built from its rows: two
    // documents that did not exist for the planner a moment earlier.
    expect(order[0]).toBe('sync');
    expect(report.eligible).toBe(2);
    expect(report.indexed).toBe(2);
    expect(rowsFor('page', PAGE_ID)[0].source_sha).toBe(NEW_SHA);
    expect(rowsFor('file', 'bot-context/faq.md')).toHaveLength(1);
  });

  describe('when the asset map is unavailable', () => {
    const FILE_PATH = 'bot-context/faq.md';
    const FILE_SHA = 'd'.repeat(40);

    /** One indexed `bot-context/` file, then a map that returns nothing. */
    async function indexedFileThenEmptyMap(): Promise<void> {
      assetShas.set(assetKey(CLASSROOM, FILE_PATH), FILE_SHA);
      await indexOneFile({
        classroomId: CLASSROOM,
        path: FILE_PATH,
        sha: FILE_SHA,
        body: 'Office hours are Tuesdays.',
      });
      assetShas.clear();
    }

    it('keeps the bot-context rows and says why', async () => {
      await indexedFileThenEmptyMap();
      // The default stub: `ensureContentAssets` returned null, which is what a
      // GitHub outage and a classroom that has never synced both look like.
      const report = await reconcileContentIndex({ fetchBody, classroomIds: [CLASSROOM] });

      expect(report.orphansDeleted).toBe(0);
      expect(report.byReason.assets_unavailable).toBe(1);
      expect(rowsFor('file', FILE_PATH)).toHaveLength(1);
    });

    it('sweeps them once a sync has actually rebuilt the map', async () => {
      await indexedFileThenEmptyMap();
      vi.doMock('../contentAssets.service.ts', () => ({
        ensureContentAssets: async () => ({
          mode: 'full',
          upserted: 0,
          deleted: 3,
          truncated: false,
        }),
      }));

      const report = await reconcileContentIndex({ fetchBody, classroomIds: [CLASSROOM] });

      expect(report.orphansDeleted).toBe(1);
      expect(report.byReason.assets_unavailable).toBeUndefined();
      expect(rowsFor('file', FILE_PATH)).toHaveLength(0);
    });
  });

  describe('the per-classroom report', () => {
    const OTHER = 'other-classroom';

    beforeEach(() => {
      pageRows.push({
        id: 'page-other',
        title: 'Other',
        content_path: 'pages/other',
        classroom_id: OTHER,
      });
      assetShas.set(assetKey(OTHER, 'pages/other/content.json'), 'b'.repeat(40));
    });

    it('carries one row per classroom, and they sum to the fleet totals', async () => {
      const report = await reconcileContentIndex({
        fetchBody,
        classroomIds: [CLASSROOM, OTHER],
      });

      expect(report.byClassroom).toHaveLength(report.classrooms);
      expect(report.byClassroom.map(row => row.classroomId)).toEqual([CLASSROOM, OTHER]);
      expect(report.byClassroom[0]).toMatchObject({
        classroomId: CLASSROOM,
        slug: `slug-${CLASSROOM}`,
        eligible: 1,
        indexed: 1,
      });
      const summed = report.byClassroom.reduce((total, row) => total + row.indexed, 0);
      expect(summed).toBe(report.indexed);
    });

    it('counts a dead classroom apart from a failed document, and names it', async () => {
      // CLASSROOM dies whole; OTHER indexes cleanly.
      const exploding = vi.fn(async (classroom: { id: string }, path: string) => {
        if (classroom.id === CLASSROOM) throw new Error('repo deleted');
        return { text: '{"blocks":[]}', sha: assetShas.get(assetKey(classroom.id, path)) ?? null };
      });

      const report = await reconcileContentIndex({
        fetchBody: exploding,
        classroomIds: [CLASSROOM, OTHER],
      });

      // The distinction the readiness gate needs: one classroom never got read,
      // and NO document was looked at and rejected.
      expect(report.classroomErrors).toBe(1);
      expect(report.failed).toBe(0);
      expect(report.byClassroom[0]).toMatchObject({
        classroomId: CLASSROOM,
        error: 'repo deleted',
      });
      expect(report.byClassroom[1].error).toBeUndefined();
      expect(report.byClassroom[1].indexed).toBe(1);
    });

    it('keeps a per-document failure in `failed`, on its own classroom’s row', async () => {
      // A body off the CDN tier, which names no sha: one document refused, the
      // classroom itself perfectly healthy.
      const cdn = vi.fn(async (classroom: { id: string }, path: string) =>
        classroom.id === CLASSROOM
          ? { text: '{"blocks":[]}', sha: null }
          : { text: '{"blocks":[]}', sha: assetShas.get(assetKey(classroom.id, path)) ?? null }
      );

      const report = await reconcileContentIndex({
        fetchBody: cdn,
        classroomIds: [CLASSROOM, OTHER],
      });

      expect(report.failed).toBe(1);
      expect(report.classroomErrors).toBe(0);
      expect(report.byClassroom[0]).toMatchObject({ failed: 1, indexed: 0 });
      expect(report.byClassroom[0].error).toBeUndefined();
      expect(report.byClassroom[1]).toMatchObject({ failed: 0, indexed: 1 });
    });
  });
});
