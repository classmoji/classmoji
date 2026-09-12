/**
 * The docs reconcile, over a stubbed `DocsReader` and a recording Prisma.
 *
 * WHAT THIS FILE IS FOR
 * ---------------------
 * The reconcile's dangerous half is not "did it index a page" — it is what it
 * does when the world answers wrongly. HTTP 200 with `truncated: true` is a
 * 200. An empty tree is a 200. And the sweep is
 * `DELETE … WHERE slug <> ALL($1)`, which on an empty array matches EVERY row.
 * So most of what is below is about refusals: the tree shapes that must end the
 * run with zero writes and zero deletes, and the per-page failures that must
 * leave the last good rows alone.
 *
 * WHAT IS NOT PROVEN HERE, DELIBERATELY
 * -------------------------------------
 * A recording Prisma agrees with whatever SQL it is handed, so nothing in this
 * file can show that a statement is CORRECT — only that it was or was not
 * issued. Rollback, the shrink-tail delete and the sweep's semantics are pinned
 * against a real Postgres in `docsIndex.integration.test.ts`, which runs on a
 * disposable database built from the migrations.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ─── A recording Prisma ─────────────────────────────────────────────────────

interface RecordedCall {
  kind: 'queryRaw' | 'executeRaw';
  sql: string;
  params: unknown[];
}

const calls: RecordedCall[] = [];
/** Rows the next `$queryRaw` should answer with, keyed by a fragment of the SQL. */
let storedRows: Record<string, unknown[]> = {};
let lockGranted = true;

const sqlOf = (strings: TemplateStringsArray | { strings?: string[] }): string =>
  Array.isArray(strings) ? strings.join('?') : String(strings);

const record = (kind: RecordedCall['kind'], strings: TemplateStringsArray, params: unknown[]) => {
  const sql = sqlOf(strings);
  calls.push({ kind, sql, params });
  return sql;
};

const prismaStub = {
  $queryRaw: vi.fn((strings: TemplateStringsArray, ...params: unknown[]) => {
    const sql = record('queryRaw', strings, params);
    if (sql.includes('pg_try_advisory_lock')) {
      return Promise.resolve([{ locked: lockGranted }]);
    }
    if (sql.includes('pg_advisory_unlock')) return Promise.resolve([{ unlocked: true }]);
    if (sql.includes('FROM docs_index')) {
      const slug = String(params[0]);
      return Promise.resolve(storedRows[slug] ?? []);
    }
    return Promise.resolve([]);
  }),
  $executeRaw: vi.fn((strings: TemplateStringsArray, ...params: unknown[]) => {
    record('executeRaw', strings, params);
    return Promise.resolve(0);
  }),
  $transaction: vi.fn(async (run: (tx: unknown) => Promise<unknown>) => run(prismaStub)),
};

vi.mock('@classmoji/database', () => ({
  default: () => prismaStub,
  getPrisma: () => prismaStub,
}));

/**
 * The lock's OWN connection.
 *
 * `pg_try_advisory_lock` is session-scoped and the shared client is a pool, so
 * the service opens one dedicated `PrismaClient` for the lock and closes it
 * when the run ends. These stubs stand in for that session, and count how many
 * were opened and disconnected — which is how "the lock did not ride the pool"
 * is asserted rather than assumed.
 */
const lockSessions: Array<{ disconnected: boolean }> = [];

vi.mock('@prisma/client', () => ({
  PrismaClient: class {
    readonly handle = { disconnected: false };
    constructor() {
      lockSessions.push(this.handle);
    }
    $queryRaw(strings: TemplateStringsArray, ...params: unknown[]) {
      const sql = record('queryRaw', strings, params);
      if (sql.includes('pg_try_advisory_lock')) return Promise.resolve([{ locked: lockGranted }]);
      return Promise.resolve([{ unlocked: true }]);
    }
    $disconnect() {
      this.handle.disconnected = true;
      return Promise.resolve();
    }
  },
}));

const embedTextsMock = vi.fn();
const isConfiguredMock = vi.fn(() => true);

vi.mock('../../helpers/workersAi.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('../../helpers/workersAi.ts')>();
  return {
    ...actual,
    isWorkersAiConfigured: () => isConfiguredMock(),
    embedTexts: (...args: unknown[]) => embedTextsMock(...args),
  };
});

const {
  createGitHubDocsReader,
  DOCS_EXTRACT_VERSION,
  DOCS_INDEX_LOCK_KEY,
  DocsBodyError,
  reconcileDocsIndex,
  sectionForPath,
  slugForPath,
} = await import('../docsIndex.service.ts');
const { EMBEDDING_MODEL, EMBEDDING_DIMENSIONS } = await import('../../helpers/workersAi.ts');

// ─── Fixtures ───────────────────────────────────────────────────────────────

/** The 25 real paths, relative to `apps/site/src/content/docs`. */
const REAL_PATHS = [
  'docs/index.mdx',
  'docs/video-tutorials.mdx',
  'docs/instructors/autograding.mdx',
  'docs/instructors/class-sites.mdx',
  'docs/instructors/create-classroom.mdx',
  'docs/instructors/custom-domains.mdx',
  'docs/instructors/grading.mdx',
  'docs/instructors/import-github-classroom.mdx',
  'docs/instructors/index.mdx',
  'docs/instructors/mcp-server.mdx',
  'docs/instructors/modules-and-assignments.mdx',
  'docs/instructors/modules.mdx',
  'docs/instructors/pages.mdx',
  'docs/instructors/roster.mdx',
  'docs/instructors/tokens.mdx',
  'docs/introduction/fundamentals.mdx',
  'docs/introduction/getting-started.mdx',
  'docs/open-source/local-development/index.mdx',
  'docs/self-hosting/docker.mdx',
  'docs/self-hosting/environment-variables.mdx',
  'docs/students/index.mdx',
  'docs/students/join-a-classroom.mdx',
  'docs/students/submit-assignments.mdx',
  'docs/students/use-tokens.mdx',
  'docs/students/view-grades.mdx',
] as const;

const COMMIT = 'c'.repeat(40);
const shaFor = (path: string): string =>
  path
    .split('')
    .reduce((acc, ch) => (acc * 31 + ch.charCodeAt(0)) % 0xffffffff, 7)
    .toString(16)
    .padStart(40, '0')
    .slice(0, 40);

const blob = (path: string, sha = shaFor(path)) => ({ path, type: 'blob', sha });

const mdxFor = (title: string, body = 'Some prose about the thing.'): string =>
  `---\ntitle: ${title}\ndescription: A page\n---\n\n${body}\n`;

interface StubOptions {
  entries?: unknown[];
  truncated?: boolean;
  headThrows?: boolean;
  treeThrows?: boolean;
  bodies?: Record<string, string | null | Error>;
}

const bodyCalls: string[] = [];

function stubReader(options: StubOptions = {}) {
  return {
    head: async () => {
      if (options.headThrows) throw new Error('head unavailable');
      return COMMIT;
    },
    tree: async () => {
      if (options.treeThrows) throw new Error('tree unavailable');
      return {
        entries: (options.entries ?? REAL_PATHS.map(path => blob(path))) as never,
        truncated: options.truncated ?? false,
      };
    },
    body: async (_commit: string, relPath: string) => {
      bodyCalls.push(relPath);
      const configured = options.bodies?.[relPath];
      if (configured instanceof Error) throw configured;
      if (configured === null) return null;
      return configured ?? mdxFor(`Page ${relPath}`);
    },
  };
}

/** A stored row that looks exactly as fresh as the tree says it should. */
const freshRows = (path: string, chunkCount = 1) =>
  Array.from({ length: chunkCount }, (_, chunk_ix) => ({
    chunk_ix,
    chunk_count: chunkCount,
    source_sha: shaFor(path),
    extract_version: DOCS_EXTRACT_VERSION,
    embed_model: EMBEDDING_MODEL,
    embedding_null: false,
  }));

const vector = (): number[] => Array.from({ length: EMBEDDING_DIMENSIONS }, () => 0.1);

const inserts = () => calls.filter(call => call.sql.includes('INSERT INTO docs_index'));
const sweeps = () => calls.filter(call => call.sql.includes('slug <> ALL'));
const shrinkDeletes = () => calls.filter(call => call.sql.includes('chunk_ix >='));

beforeEach(() => {
  calls.length = 0;
  bodyCalls.length = 0;
  lockSessions.length = 0;
  storedRows = {};
  lockGranted = true;
  isConfiguredMock.mockReturnValue(true);
  embedTextsMock.mockReset();
  embedTextsMock.mockImplementation(async (texts: string[]) => ({
    ok: true,
    vectors: texts.map(() => vector()),
  }));
  prismaStub.$queryRaw.mockClear();
  prismaStub.$executeRaw.mockClear();
});

// ─── Slugs ──────────────────────────────────────────────────────────────────

describe('the slug IS the URL path', () => {
  it.each([
    ['docs/index.mdx', 'docs', null],
    ['docs/video-tutorials.mdx', 'docs/video-tutorials', null],
    ['docs/instructors/roster.mdx', 'docs/instructors/roster', 'instructors'],
    ['docs/instructors/index.mdx', 'docs/instructors', 'instructors'],
    ['docs/students/view-grades.mdx', 'docs/students/view-grades', 'students'],
    ['docs/self-hosting/docker.mdx', 'docs/self-hosting/docker', 'self-hosting'],
    [
      'docs/open-source/local-development/index.mdx',
      'docs/open-source/local-development',
      'open-source',
    ],
    ['docs/introduction/fundamentals.mdx', 'docs/introduction/fundamentals', 'introduction'],
  ])('%s → %s (section %s)', (path, slug, section) => {
    expect(slugForPath(path)).toBe(slug);
    expect(sectionForPath(path)).toBe(section);
  });

  it('produces 25 distinct slugs for the 25 real paths', () => {
    const slugs = REAL_PATHS.map(slugForPath);
    expect(new Set(slugs).size).toBe(25);
    // The two most easily confused: a directory index and a sibling page.
    expect(slugs).toContain('docs/instructors');
    expect(slugs).toContain('docs/instructors/roster');
  });
});

// ─── Freshness ──────────────────────────────────────────────────────────────

describe('an unchanged corpus costs nothing', () => {
  it('fetches NO bodies when every sha already matches', async () => {
    for (const path of REAL_PATHS) storedRows[slugForPath(path)] = freshRows(path);

    const report = await reconcileDocsIndex({ reader: stubReader() });

    expect(report.error).toBeUndefined();
    expect(report.halted).toBeUndefined();
    expect(report.eligible).toBe(25);
    expect(report.indexed).toBe(0);
    expect(report.skipped).toBe(25);
    expect(report.byReason.fresh).toBe(25);
    // The whole point of reading the sha out of the tree: an unchanged page
    // never has its body fetched, so a nightly run is two REST calls.
    expect(bodyCalls).toHaveLength(0);
    expect(embedTextsMock).not.toHaveBeenCalled();
    expect(inserts()).toHaveLength(0);
  });

  it('re-indexes exactly the one page whose sha moved', async () => {
    for (const path of REAL_PATHS) storedRows[slugForPath(path)] = freshRows(path);
    storedRows['docs/instructors/roster'] = freshRows('docs/instructors/roster').map(row => ({
      ...row,
      source_sha: 'd'.repeat(40),
    }));

    const report = await reconcileDocsIndex({ reader: stubReader() });

    expect(report.indexed).toBe(1);
    expect(report.skipped).toBe(24);
    expect(bodyCalls).toEqual(['docs/instructors/roster.mdx']);
    expect(embedTextsMock).toHaveBeenCalledTimes(1);
    expect(report.bySlug.find(row => row.slug === 'docs/instructors/roster')).toMatchObject({
      outcome: 'indexed',
      chunks: 1,
    });
  });

  it('re-indexes EVERYTHING when the extractor version moves, shas unchanged', async () => {
    // The recovery path for an extractor bug: bump the constant, and the next
    // run rebuilds the corpus without anybody touching a sha.
    for (const path of REAL_PATHS) {
      storedRows[slugForPath(path)] = freshRows(path).map(row => ({
        ...row,
        extract_version: DOCS_EXTRACT_VERSION - 1,
      }));
    }

    const report = await reconcileDocsIndex({ reader: stubReader() });

    expect(report.indexed).toBe(25);
    expect(report.skipped).toBe(0);
    expect(bodyCalls).toHaveLength(25);
  });

  it('re-indexes when the embedding model moves', async () => {
    for (const path of REAL_PATHS) {
      storedRows[slugForPath(path)] = freshRows(path).map(row => ({
        ...row,
        embed_model: '@cf/some/other-model',
      }));
    }
    const report = await reconcileDocsIndex({ reader: stubReader() });
    expect(report.indexed).toBe(25);
  });
});

// ─── Tree validation: the branches that must not delete ─────────────────────

describe('a tree it cannot trust ends the run with NO writes and NO deletes', () => {
  const expectRefused = (report: Awaited<ReturnType<typeof reconcileDocsIndex>>, why: string) => {
    expect(report.halted).toBe('tree_invalid');
    expect(report.error).toBe(why);
    expect(report.indexed).toBe(0);
    expect(inserts()).toHaveLength(0);
    // THE assertion. `slug <> ALL('{}'::text[])` matches every row, so a sweep
    // issued on a tree we could not validate empties the corpus.
    expect(sweeps()).toHaveLength(0);
    expect(shrinkDeletes()).toHaveLength(0);
  };

  it('refuses a TRUNCATED tree — which arrives as an HTTP 200', async () => {
    const report = await reconcileDocsIndex({ reader: stubReader({ truncated: true }) });
    expectRefused(report, 'tree_truncated');
  });

  it('treats a missing `truncated` field as truncated, not as complete', async () => {
    const reader = stubReader();
    reader.tree = async () => ({
      entries: REAL_PATHS.map(p => blob(p)) as never,
      truncated: undefined as never,
    });
    const report = await reconcileDocsIndex({ reader });
    expectRefused(report, 'tree_truncated');
  });

  it('refuses an EMPTY tree rather than reading it as "delete everything"', async () => {
    const report = await reconcileDocsIndex({ reader: stubReader({ entries: [] }) });
    expectRefused(report, 'tree_empty');
  });

  it('refuses a tree with no .mdx in it at all', async () => {
    const report = await reconcileDocsIndex({
      reader: stubReader({
        entries: [
          blob('docs/img-students.png'),
          { path: 'docs', type: 'tree', sha: shaFor('docs') },
        ],
      }),
    });
    expectRefused(report, 'tree_empty');
  });

  it('refuses two entries that normalize to the SAME slug', async () => {
    // `docs/foo.mdx` and `docs/foo/index.mdx` are both `docs/foo`, and whichever
    // wrote last would decide what that page says.
    const report = await reconcileDocsIndex({
      reader: stubReader({ entries: [blob('docs/foo.mdx'), blob('docs/foo/index.mdx')] }),
    });
    expectRefused(report, 'tree_duplicate_slug');
  });

  it('refuses an entry with a malformed sha', async () => {
    const report = await reconcileDocsIndex({
      reader: stubReader({ entries: [blob('docs/a.mdx', 'not-a-sha')] }),
    });
    expectRefused(report, 'tree_malformed');
  });

  it('refuses an entry that is not an object at all', async () => {
    const report = await reconcileDocsIndex({ reader: stubReader({ entries: ['docs/a.mdx'] }) });
    expectRefused(report, 'tree_malformed');
  });

  it('refuses a path that tries to escape the collection root', async () => {
    for (const path of ['../../../etc/passwd.mdx', '/etc/passwd.mdx', 'docs/../../secret.mdx']) {
      calls.length = 0;
      const report = await reconcileDocsIndex({ reader: stubReader({ entries: [blob(path)] }) });
      expectRefused(report, 'tree_unsafe_path');
    }
  });

  it('ignores the .png files and directories beside the pages', async () => {
    const report = await reconcileDocsIndex({
      reader: stubReader({
        entries: [
          blob('docs/index.mdx'),
          blob('docs/img-students.png'),
          { path: 'docs/instructors', type: 'tree', sha: shaFor('docs/instructors') },
        ],
      }),
    });
    expect(report.halted).toBeUndefined();
    expect(report.pages).toBe(3);
    expect(report.eligible).toBe(1);
  });
});

describe('a GitHub read that fails abandons the run whole', () => {
  it('reports tree_unavailable and deletes nothing when head() throws', async () => {
    const report = await reconcileDocsIndex({ reader: stubReader({ headThrows: true }) });
    expect(report.halted).toBe('tree_unavailable');
    expect(report.error).toContain('head unavailable');
    expect(report.commit).toBeNull();
    expect(sweeps()).toHaveLength(0);
  });

  it('reports tree_unavailable and deletes nothing when tree() throws', async () => {
    const report = await reconcileDocsIndex({ reader: stubReader({ treeThrows: true }) });
    expect(report.halted).toBe('tree_unavailable');
    expect(sweeps()).toHaveLength(0);
    expect(inserts()).toHaveLength(0);
  });
});

// ─── Per-page failures keep the last good rows ──────────────────────────────

describe('a page that fails keeps whatever it already had', () => {
  const twoPages = [blob('docs/index.mdx'), blob('docs/instructors/roster.mdx')];

  it('classifies a 404 body as http_404 and still indexes the others', async () => {
    const report = await reconcileDocsIndex({
      reader: stubReader({ entries: twoPages, bodies: { 'docs/instructors/roster.mdx': null } }),
    });

    expect(report.indexed).toBe(1);
    expect(report.failed).toBe(1);
    expect(report.byReason.http_404).toBe(1);
    expect(report.bySlug.find(r => r.slug === 'docs/instructors/roster')).toMatchObject({
      outcome: 'failed',
      reason: 'http_404',
    });
    // No row for the failed page was written, and none was removed.
    expect(inserts()).toHaveLength(1);
    expect(shrinkDeletes()).toHaveLength(1);
  });

  it('classifies a rate-limited body read, and keeps going', async () => {
    const report = await reconcileDocsIndex({
      reader: stubReader({
        entries: twoPages,
        bodies: { 'docs/index.mdx': new DocsBodyError('rate_limited') },
      }),
    });
    expect(report.byReason.rate_limited).toBe(1);
    expect(report.indexed).toBe(1);
  });

  it('classifies a timeout', async () => {
    const report = await reconcileDocsIndex({
      reader: stubReader({
        entries: twoPages,
        bodies: { 'docs/index.mdx': new DocsBodyError('timeout') },
      }),
    });
    expect(report.byReason.timeout).toBe(1);
  });

  it('writes NOTHING for a page the extractor refuses', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const report = await reconcileDocsIndex({
      reader: stubReader({
        entries: twoPages,
        // No frontmatter: the extractor refuses, and the last good rows stay.
        bodies: { 'docs/index.mdx': 'Just prose, no frontmatter.\n' },
      }),
    });
    warn.mockRestore();

    expect(report.byReason.extract).toBe(1);
    expect(report.failed).toBe(1);
    const written = inserts().map(call => call.params[0]);
    expect(written).toEqual(['docs/instructors/roster']);
    // Not even the shrink delete: a failed extract must not touch the page.
    expect(shrinkDeletes().map(call => call.params[0])).toEqual(['docs/instructors/roster']);
  });

  it('counts an embedding refusal without writing a partial page', async () => {
    embedTextsMock.mockResolvedValue({
      ok: false,
      reason: 'over_cap',
      estimatedTokens: 1,
      limit: 1,
      index: 0,
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const report = await reconcileDocsIndex({ reader: stubReader({ entries: twoPages }) });
    warn.mockRestore();

    expect(report.failed).toBe(2);
    expect(report.byReason.over_cap).toBe(2);
    expect(inserts()).toHaveLength(0);
  });
});

// ─── The sweep ──────────────────────────────────────────────────────────────

describe('the sweep', () => {
  it('runs once, last, with the run’s slugs as a BOUND array', async () => {
    for (const path of REAL_PATHS) storedRows[slugForPath(path)] = freshRows(path);
    await reconcileDocsIndex({ reader: stubReader() });

    const sweep = sweeps();
    expect(sweep).toHaveLength(1);
    expect(sweep[0].sql).toContain('::text[]');
    const bound = sweep[0].params[0] as string[];
    expect(Array.isArray(bound)).toBe(true);
    expect(bound).toHaveLength(25);
    expect(bound).toContain('docs/instructors/roster');
    // LAST WRITE of the run: sweeping before the writes would delete a page
    // that this very run is about to re-create.
    //
    // Asserted as "nothing after it writes", not as an offset from the end of
    // `calls`. `calls.at(-2)` said the same thing right up until the run grew a
    // read after the sweep (`belowSearchMin`), at which point it was an
    // assertion about the advisory unlock and nobody would have known.
    const sweepAt = calls.findIndex(call => call.sql.includes('slug <> ALL'));
    expect(sweepAt).toBeGreaterThanOrEqual(0);
    const after = calls.slice(sweepAt + 1).map(call => call.sql);
    expect(after.some(sql => /INSERT INTO|DELETE FROM|UPDATE /.test(sql))).toBe(false);
    // And what IS allowed to follow it: the short-page report, then the unlock.
    expect(after.map(sql => sql.replace(/\s+/g, ' ').trim().slice(0, 24))).toEqual([
      'SELECT slug FROM docs_in',
      'SELECT pg_advisory_unloc',
    ]);
  });
});

// ─── Serialization ──────────────────────────────────────────────────────────

describe('serialization', () => {
  it('does NOTHING at all when the advisory lock is already held', async () => {
    lockGranted = false;
    const reader = stubReader();
    const headSpy = vi.spyOn(reader, 'head');

    const report = await reconcileDocsIndex({ reader });

    expect(report.halted).toBe('lock_held');
    expect(report.commit).toBeNull();
    // The lock is taken BEFORE the commit is resolved: taking it afterwards
    // still lets two runs pin different commits and then serialize their
    // sweeps, which is the interleaving that deletes a live page.
    expect(headSpy).not.toHaveBeenCalled();
    expect(inserts()).toHaveLength(0);
    expect(sweeps()).toHaveLength(0);
  });

  it('takes and releases the lock on the key both callers use', async () => {
    for (const path of REAL_PATHS) storedRows[slugForPath(path)] = freshRows(path);
    await reconcileDocsIndex({ reader: stubReader() });

    const take = calls.find(call => call.sql.includes('pg_try_advisory_lock'));
    const release = calls.find(call => call.sql.includes('pg_advisory_unlock'));
    expect(take?.params[0]).toBe(DOCS_INDEX_LOCK_KEY);
    expect(release?.params[0]).toBe(DOCS_INDEX_LOCK_KEY);
  });

  it('releases the lock even when the run refuses the tree', async () => {
    await reconcileDocsIndex({ reader: stubReader({ truncated: true }) });
    expect(calls.some(call => call.sql.includes('pg_advisory_unlock'))).toBe(true);
  });

  it('holds the lock on its OWN connection, and closes it when the run ends', async () => {
    // `pg_try_advisory_lock` is SESSION-scoped and the shared client is a POOL:
    // a lock taken on one pooled connection and unlocked on another leaks, the
    // unlock silently returns false, and every later run lands on a different
    // connection and is refused with `lock_held`. The job then serializes
    // against ITSELF and quietly stops indexing. One dedicated session is what
    // makes the lock mean what it says.
    for (const path of REAL_PATHS) storedRows[slugForPath(path)] = freshRows(path);
    await reconcileDocsIndex({ reader: stubReader() });

    expect(lockSessions).toHaveLength(1);
    expect(lockSessions[0].disconnected).toBe(true);
    // And the pooled client was never asked to take or release it.
    expect(
      prismaStub.$queryRaw.mock.calls.some(call =>
        String(Array.isArray(call[0]) ? call[0].join('') : '').includes('advisory')
      )
    ).toBe(false);
  });

  it('closes the lock connection even when the lock was NOT granted', async () => {
    lockGranted = false;
    await reconcileDocsIndex({ reader: stubReader() });
    expect(lockSessions).toHaveLength(1);
    expect(lockSessions[0].disconnected).toBe(true);
  });
});

// ─── Configuration ──────────────────────────────────────────────────────────

describe('an unconfigured deployment writes nothing and takes no lock', () => {
  it('halts before any database work', async () => {
    isConfiguredMock.mockReturnValue(false);
    const reader = stubReader();
    const headSpy = vi.spyOn(reader, 'head');

    const report = await reconcileDocsIndex({ reader });

    expect(report.halted).toBe('not_configured');
    expect(report.error).toBeUndefined();
    expect(calls).toHaveLength(0);
    expect(headSpy).not.toHaveBeenCalled();
  });
});

// ─── The report ─────────────────────────────────────────────────────────────

describe('the report is the readiness signal', () => {
  it('names the commit everything was read at', async () => {
    for (const path of REAL_PATHS) storedRows[slugForPath(path)] = freshRows(path);
    const report = await reconcileDocsIndex({ reader: stubReader() });
    expect(report.commit).toBe(COMMIT);
  });

  it('carries one row per eligible page, with its outcome', async () => {
    const report = await reconcileDocsIndex({ reader: stubReader() });
    expect(report.bySlug).toHaveLength(25);
    expect(new Set(report.bySlug.map(row => row.slug)).size).toBe(25);
    expect(report.indexed + report.skipped + report.failed).toBe(25);
  });
});

// ─── isFresh, the shared rule ───────────────────────────────────────────────

describe('isFresh rejects an EXTRA chunk, not just a missing one', () => {
  it('is stale when a leftover tail sits beside a one-chunk document', async () => {
    const { isFresh } = await import('../contentIndex.service.ts');
    const stamp = { sourceSha: 'a'.repeat(40), extractVersion: 1, embedModel: 'm' };
    const row = (chunk_ix: number) => ({
      chunk_ix,
      chunk_count: 1,
      source_sha: stamp.sourceSha,
      extract_version: 1,
      embed_model: 'm',
      embedding_null: false,
    });

    // Both rows declare `chunk_count: 1`, every index in 0..0 is present, and
    // every stamp matches — yet chunk 1 is a stale leftover still answering
    // out of the previous version's text.
    expect(isFresh([row(0), row(1)], stamp)).toBe(false);
    expect(isFresh([row(0)], stamp)).toBe(true);
  });

  it('is still stale for the cases it already caught', async () => {
    const { isFresh } = await import('../contentIndex.service.ts');
    const stamp = { sourceSha: 'a'.repeat(40), extractVersion: 1, embedModel: 'm' };
    const base = {
      chunk_count: 2,
      source_sha: stamp.sourceSha,
      extract_version: 1,
      embed_model: 'm',
      embedding_null: false,
    };
    expect(isFresh([], stamp)).toBe(false);
    expect(isFresh([{ ...base, chunk_ix: 0 }], stamp)).toBe(false); // chunk 1 missing
    expect(
      isFresh(
        [
          { ...base, chunk_ix: 0 },
          { ...base, chunk_ix: 1, embedding_null: true },
        ],
        stamp
      )
    ).toBe(false);
    expect(
      isFresh(
        [
          { ...base, chunk_ix: 0 },
          { ...base, chunk_ix: 1 },
        ],
        stamp
      )
    ).toBe(true);
  });
});

// ─── The GitHub reader ──────────────────────────────────────────────────────

/**
 * The default reader, against a STUBBED `fetch`.
 *
 * Never the network. These assertions are about what the reader does with an
 * answer — a truncated tree, a 429 carrying a `Retry-After`, a 404 — and a test
 * that depended on github.com being reachable would be a test that goes red for
 * reasons that have nothing to do with this code.
 */
describe('createGitHubDocsReader', () => {
  const realFetch = globalThis.fetch;
  let fetchMock: ReturnType<typeof vi.fn>;

  const jsonResponse = (body: unknown, init: ResponseInit = {}): Response =>
    new Response(JSON.stringify(body), { status: 200, ...init });

  beforeEach(() => {
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.useRealTimers();
  });

  it('resolves the head commit and pins everything else to it', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ sha: COMMIT }));
    const reader = createGitHubDocsReader();
    await expect(reader.head()).resolves.toBe(COMMIT);
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      'https://api.github.com/repos/classmoji/classmoji/commits/main'
    );
  });

  it('refuses a head response with no usable sha rather than inventing one', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ sha: 'not-a-sha' }));
    await expect(createGitHubDocsReader().head()).rejects.toThrow(/no sha/);
  });

  it('asks for the tree AT THE COMMIT, rooted at the docs directory', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ tree: [blob('docs/index.mdx')], truncated: false })
    );
    const result = await createGitHubDocsReader().tree(COMMIT);
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain(`/git/trees/${COMMIT}:`);
    expect(url).toContain(encodeURIComponent('apps/site/src/content/docs'));
    expect(url).toContain('recursive=1');
    expect(result.truncated).toBe(false);
  });

  it('reports a tree whose `truncated` is anything but false AS truncated', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ tree: [] }));
    await expect(createGitHubDocsReader().tree(COMMIT)).resolves.toMatchObject({
      truncated: true,
    });
  });

  it('reads a body from raw.githubusercontent AT THE COMMIT, never from a branch', async () => {
    fetchMock.mockResolvedValueOnce(new Response('body', { status: 200 }));
    await createGitHubDocsReader().body(COMMIT, 'docs/instructors/roster.mdx');
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      `https://raw.githubusercontent.com/classmoji/classmoji/${COMMIT}/apps/site/src/content/docs/docs/instructors/roster.mdx`
    );
  });

  it('turns a 404 body into null, which the reconcile counts as http_404', async () => {
    fetchMock.mockResolvedValueOnce(new Response('', { status: 404 }));
    await expect(createGitHubDocsReader().body(COMMIT, 'docs/gone.mdx')).resolves.toBeNull();
    // ONE call: a 404 is an answer, not a fault, and retrying it wastes budget.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('classifies a rate-limited body read so the report can name it', async () => {
    fetchMock.mockResolvedValue(new Response('', { status: 429, headers: { 'retry-after': '0' } }));
    await expect(createGitHubDocsReader().body(COMMIT, 'docs/a.mdx')).rejects.toMatchObject({
      reason: 'rate_limited',
    });
  });

  it('HONOURS Retry-After rather than retrying straight away', async () => {
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(new Response('', { status: 429, headers: { 'retry-after': '5' } }))
      .mockResolvedValueOnce(jsonResponse({ sha: COMMIT }));

    const pending = createGitHubDocsReader().head();
    // Let the first attempt settle, then check nothing has been retried yet.
    await vi.advanceTimersByTimeAsync(4_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_500);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await expect(pending).resolves.toBe(COMMIT);
  });

  it('gives up after a bounded number of attempts rather than looping', async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValue(new Response('', { status: 500 }));

    // The rejection handler is attached BEFORE the timers advance, so the
    // rejection is never momentarily unhandled.
    const pending = expect(createGitHubDocsReader().head()).rejects.toThrow(/HTTP 500/);
    await vi.advanceTimersByTimeAsync(120_000);
    await pending;
    // `trigger.config.js` sets maxAttempts: 1, so these in-run retries are the
    // only retries there are — and they must still terminate.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('does not retry a non-retryable status', async () => {
    fetchMock.mockResolvedValue(new Response('', { status: 401 }));
    await expect(createGitHubDocsReader().head()).rejects.toThrow(/HTTP 401/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
