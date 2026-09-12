/**
 * docsIndex.service.ts — the product documentation → `docs_index` rows.
 *
 * THE ONLY WRITER OF THAT TABLE. One `.mdx` page under
 * `apps/site/src/content/docs` in the public monorepo becomes one or more rows
 * carrying its extracted text and its Workers AI vector, so `content_search`
 * with `scope: 'docs'` can answer "how do I add a TA?" out of
 * `classmoji.io/docs/instructors/roster` instead of guessing.
 *
 * ── What this reads, and what it is allowed to do with it ──────────────────
 * Three unauthenticated GitHub reads against a PUBLIC repo: the head commit of
 * `main`, a recursive tree at that commit rooted at the docs directory, and one
 * raw body per stale page. Nothing here holds a credential, and nothing it
 * fetches is executed — the extractor parses, and the text it produces is
 * EVIDENCE a model may quote, never an instruction anything follows.
 *
 * Bodies are pinned to the COMMIT, not to `main`, so a push landing mid-run
 * cannot serve bytes under a sha they do not have. What the index therefore
 * holds is the latest `main`, which may be AHEAD of the deployed site by up to
 * the nightly interval: `apps/site` deploys on its own `needs: changes` gate,
 * not with this. That is accepted and made visible — the commit sha is logged
 * and returned in the report.
 *
 * ── Two locks, because the failure they prevent is data loss ───────────────
 * The run ends with a SWEEP: every slug not in this run's tree is deleted. Two
 * runs overlapping is therefore not merely wasteful, it is destructive — a slow
 * run for commit A finishing after a run for commit B deletes the pages B
 * introduced, and the next nightly puts them back, so the damage is a day of
 * wrong answers that heals itself before anybody looks.
 *
 *   1. `packages/tasks` puts BOTH task ids on one `concurrencyLimit: 1` queue.
 *   2. This function takes a Postgres advisory lock BEFORE resolving the
 *      commit, and releases it in a `finally`.
 *
 * The second exists because the first only covers Trigger.dev: a script, a
 * local run or a future caller reaches this function directly.
 *
 * ── Fail closed, everywhere it matters ─────────────────────────────────────
 * HTTP 200 is not authority to delete. `truncated: true` is a 200. An empty
 * tree is a 200. And `slug <> ALL('{}'::text[])` matches EVERY row, so an empty
 * tree taken at face value empties the corpus. So: the tree is validated before
 * anything is written, any validation failure ends the run with NO writes and
 * NO deletes, and there is no operational delete-everything path in v1 —
 * emptying the corpus deliberately is a manual `DELETE`, done knowingly.
 *
 * Per page, the rule is the same one the course indexer uses: a page that
 * cannot be fetched, or cannot be extracted, KEEPS ITS LAST GOOD ROWS. An
 * unreadable page is a reason to go on answering out of the previous version,
 * not to blank it out of the corpus.
 *
 * ── Startup graph ──────────────────────────────────────────────────────────
 * This module is reached from `ClassmojiService`, which every app imports at
 * boot. `extractMdxText` is therefore loaded with a dynamic `await import()` of
 * the extract barrel — the same reason `contentIndex.service.ts` does it: that
 * barrel statically imports `./html.ts`, which pulls in cheerio. Only the
 * VERSION constant is imported statically, and only from `mdx.ts` directly,
 * which has no dependencies at all.
 */

import getPrisma from '@classmoji/database';
import { PrismaClient } from '@prisma/client';
import { MDX_EXTRACT_VERSION } from '../content/extract/mdx.ts';
import type { ExtractedMdx } from '../content/extract/mdx.ts';
import {
  EMBEDDING_MODEL,
  MAX_BATCH_SIZE,
  embedTexts,
  isWorkersAiConfigured,
} from '../helpers/workersAi.ts';
import { chunkDocument, isFresh, type StoredChunk } from './contentIndex.service.ts';
import { toVectorLiteral } from './contentSearch.service.ts';
import { DOCS_SEARCH_MIN_CHARS } from './docsSearch.service.ts';

/** Where the documentation lives. Public, and read without credentials. */
export const DOCS_REPO = {
  owner: 'classmoji',
  repo: 'classmoji',
  ref: 'main',
  path: 'apps/site/src/content/docs',
} as const;

/**
 * The extractor version, RE-EXPORTED rather than redeclared.
 *
 * Two constants that must agree is a bug waiting for the day they do not: a
 * second `DOCS_EXTRACT_VERSION = 1` next to a bumped `MDX_EXTRACT_VERSION = 2`
 * would leave every row stamped 1 looking fresh forever, and the recovery path
 * for an extractor mistake would silently stop working.
 */
export { MDX_EXTRACT_VERSION as DOCS_EXTRACT_VERSION } from '../content/extract/mdx.ts';

/**
 * The advisory-lock key.
 *
 * Session-scoped (`pg_try_advisory_lock`), taken before the head commit is
 * resolved and released in a `finally`. An arbitrary but FIXED number: every
 * caller has to pick the same one for the lock to mean anything.
 */
export const DOCS_INDEX_LOCK_KEY = 2026091201;

/** How many pages may be fetched and embedded at once. */
const DEFAULT_CONCURRENCY = 4;
export const MAX_CONCURRENCY = 8;

/** Per-request budget for the GitHub reads. */
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_REQUEST_ATTEMPTS = 3;
/** Ceiling on how long a `Retry-After` may park a run. */
const MAX_BACKOFF_MS = 30_000;

// ─── The reader ─────────────────────────────────────────────────────────────

/** One entry of the recursive tree, as GitHub returns it. */
export interface DocsTreeEntry {
  path: string;
  type: string;
  sha: string;
}

/**
 * Everything this service needs from GitHub, as an interface.
 *
 * Injectable so the unit suite can drive every branch — a truncated tree, a
 * duplicate slug, a 404 body, a 429 with a `Retry-After` — without a network,
 * and so the contract tests never depend on github.com being reachable or on
 * the docs being in any particular state today.
 */
export interface DocsReader {
  /** The sha `main` currently points at. */
  head(): Promise<string>;
  /** The recursive tree under {@link DOCS_REPO.path} at `commit`. */
  tree(commit: string): Promise<{ entries: DocsTreeEntry[]; truncated: boolean }>;
  /** One file's bytes at `commit`, or null when it is not there (404). */
  body(commit: string, relPath: string): Promise<string | null>;
}

/** How a body read failed, in the terms the report buckets by. */
export type DocsBodyFailure = 'timeout' | 'rate_limited' | 'http_error' | 'network';

/**
 * A body read that failed in a way worth telling apart in the report.
 *
 * The field is assigned explicitly rather than declared as a constructor
 * PARAMETER PROPERTY (`constructor(readonly reason: …)`). Five apps in this
 * monorepo — mcp, hook-station, admin, slides, pages — run TypeScript through
 * `node --experimental-strip-types`, which erases types but cannot SYNTHESIZE
 * the assignment a parameter property implies, and refuses the file outright
 * with `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`. Since this module hangs off
 * `ClassmojiService`, which those apps import at boot, a parameter property
 * here is a process that will not start — and neither `tsc`, vitest nor the
 * vite build would have said so.
 */
export class DocsBodyError extends Error {
  readonly reason: DocsBodyFailure;

  constructor(reason: DocsBodyFailure) {
    super(`docs body read failed: ${reason}`);
    this.name = 'DocsBodyError';
    this.reason = reason;
  }
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/**
 * How long to wait before retrying, from the response's own headers.
 *
 * `Retry-After` is seconds or an HTTP date; `x-ratelimit-reset` is a unix
 * second. Honouring them is the difference between backing off and hammering a
 * limit that is already refusing us. Capped, because a rate limit that resets
 * in an hour is a run to abandon, not one to sit inside `maxDuration: 900`.
 */
function retryDelayMs(response: Response, attempt: number): number {
  const after = response.headers.get('retry-after');
  if (after) {
    const seconds = Number(after);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, MAX_BACKOFF_MS);
    const when = Date.parse(after);
    if (Number.isFinite(when)) return Math.min(Math.max(when - Date.now(), 0), MAX_BACKOFF_MS);
  }
  const reset = Number(response.headers.get('x-ratelimit-reset'));
  if (Number.isFinite(reset) && reset > 0) {
    return Math.min(Math.max(reset * 1000 - Date.now(), 0), MAX_BACKOFF_MS);
  }
  // No guidance: plain exponential backoff.
  return Math.min(500 * 2 ** attempt, MAX_BACKOFF_MS);
}

const isRetryableStatus = (status: number): boolean =>
  status === 403 || status === 408 || status === 429 || status >= 500;

/**
 * One GET, with bounded retries.
 *
 * `trigger.config.js` sets `maxAttempts: 1`, so a task that throws is never
 * retried by Trigger and a task that RETURNS an error report does not trigger
 * one either. These in-run retries are therefore the only retries there are,
 * which is why they exist at all rather than being left to the scheduler.
 */
async function getWithRetry(url: string, accept: string): Promise<Response> {
  let lastError: unknown = null;

  for (let attempt = 0; attempt < MAX_REQUEST_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { accept, 'user-agent': 'classmoji-docs-index' },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (response.ok || response.status === 404) return response;
      if (!isRetryableStatus(response.status) || attempt === MAX_REQUEST_ATTEMPTS - 1) {
        return response;
      }
      await sleep(retryDelayMs(response, attempt));
    } catch (error) {
      lastError = error;
      if (attempt === MAX_REQUEST_ATTEMPTS - 1) break;
      await sleep(Math.min(500 * 2 ** attempt, MAX_BACKOFF_MS));
    }
  }

  throw lastError instanceof Error ? lastError : new Error('docs read failed');
}

const isTimeout = (error: unknown): boolean =>
  error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');

/**
 * The real reader: two REST calls in the normal case, plus one raw fetch per
 * stale page.
 *
 * The tree-ish form `…/git/trees/<commit>:<url-encoded dir>?recursive=1` returns
 * paths RELATIVE to that directory and a per-blob `sha`, which is exactly the
 * freshness key — so nothing has to be fetched to find out whether it changed.
 *
 * A private docs repo would replace this with authenticated contents/blob reads
 * under a `Contents: read` permission. That is documented, not built: public
 * raw URLs are not assumed to keep working, and a credential here would widen
 * what the indexer can see.
 */
export function createGitHubDocsReader(): DocsReader {
  const api = 'https://api.github.com';
  const { owner, repo, ref, path } = DOCS_REPO;

  return {
    async head(): Promise<string> {
      const response = await getWithRetry(
        `${api}/repos/${owner}/${repo}/commits/${ref}`,
        'application/vnd.github+json'
      );
      if (!response.ok) throw new Error(`head commit: HTTP ${response.status}`);
      const payload = (await response.json()) as { sha?: unknown };
      if (typeof payload.sha !== 'string' || !/^[0-9a-f]{40}$/i.test(payload.sha)) {
        throw new Error('head commit: response carried no sha');
      }
      return payload.sha;
    },

    async tree(commit: string) {
      const response = await getWithRetry(
        `${api}/repos/${owner}/${repo}/git/trees/${commit}:${encodeURIComponent(path)}?recursive=1`,
        'application/vnd.github+json'
      );
      if (!response.ok) throw new Error(`tree: HTTP ${response.status}`);
      const payload = (await response.json()) as { tree?: unknown; truncated?: unknown };
      if (!Array.isArray(payload.tree)) throw new Error('tree: response carried no tree');
      return {
        entries: payload.tree as DocsTreeEntry[],
        // Anything but an explicit `false` is treated as truncated, so a shape
        // change cannot quietly turn "we did not see everything" into a sweep.
        truncated: payload.truncated !== false,
      };
    },

    async body(commit: string, relPath: string): Promise<string | null> {
      try {
        const response = await getWithRetry(
          `https://raw.githubusercontent.com/${owner}/${repo}/${commit}/${path}/${relPath}`,
          'text/plain'
        );
        if (response.status === 404) return null;
        if (response.status === 429 || response.status === 403) {
          throw new DocsBodyError('rate_limited');
        }
        if (!response.ok) throw new DocsBodyError('http_error');
        return await response.text();
      } catch (error) {
        if (error instanceof DocsBodyError) throw error;
        throw new DocsBodyError(isTimeout(error) ? 'timeout' : 'network');
      }
    },
  };
}

// ─── Paths → slugs ──────────────────────────────────────────────────────────

/**
 * The repo path (relative to the collection root) → the URL path.
 *
 * `docs/instructors/roster.mdx` → `docs/instructors/roster`
 * `docs/index.mdx`              → `docs`
 * `docs/open-source/local-development/index.mdx` → `docs/open-source/local-development`
 *
 * The slug IS the id a search hit returns AND the path under classmoji.io, so
 * there is no mapping table and no way for the two to disagree.
 */
export function slugForPath(relPath: string): string {
  const withoutExtension = relPath.replace(/\.mdx$/, '');
  return withoutExtension.endsWith('/index')
    ? withoutExtension.slice(0, -'/index'.length)
    : withoutExtension;
}

/**
 * The top-level docs section, or null for a page sitting directly under the root.
 *
 * The paths all begin `docs/`, so the section is the SECOND segment of the
 * directory: `docs/instructors/roster.mdx` → `instructors`, while
 * `docs/index.mdx` and `docs/video-tutorials.mdx` have no section at all.
 */
export function sectionForPath(relPath: string): string | null {
  const directory = relPath.includes('/') ? relPath.slice(0, relPath.lastIndexOf('/')) : '';
  return directory.split('/')[1] ?? null;
}

// ─── Tree validation ────────────────────────────────────────────────────────

/** A page the run has decided to consider. */
interface EligiblePage {
  relPath: string;
  slug: string;
  section: string | null;
  sha: string;
}

const SHA = /^[0-9a-f]{40}$/i;

/**
 * Turn a tree into the eligible page list, or refuse the whole run.
 *
 * ONLY `.mdx` blobs under the collection root are eligible — the `.png` files
 * and the directories beside them are not documentation pages. Everything else
 * about an eligible entry is checked, and any violation ends the run: a
 * malformed entry means the response is not the shape this code was written
 * against, and continuing means sweeping on a list we do not understand.
 *
 * An EMPTY eligible list is a failure, not an instruction. `slug <> ALL('{}')`
 * matches every row, so "the tree came back with nothing in it" and "delete the
 * entire corpus" would otherwise be the same statement.
 */
function validateTree(
  entries: unknown,
  truncated: boolean
): { pages: EligiblePage[] } | { error: string } {
  // `!== false`, not `truncated === true`: a reader that forgot the field, or a
  // response whose shape changed, must read as "we did not see everything"
  // rather than as permission to sweep. The GitHub reader already normalizes
  // this; restating it here means a second reader cannot get it wrong.
  if (truncated !== false) return { error: 'tree_truncated' };
  if (!Array.isArray(entries)) return { error: 'tree_malformed' };

  const pages: EligiblePage[] = [];
  const seen = new Map<string, string>();

  for (const raw of entries) {
    if (!raw || typeof raw !== 'object') return { error: 'tree_malformed' };
    const entry = raw as Partial<DocsTreeEntry>;
    if (typeof entry.path !== 'string' || typeof entry.type !== 'string') {
      return { error: 'tree_malformed' };
    }
    if (entry.type !== 'blob' || !entry.path.endsWith('.mdx')) continue;

    const relPath = entry.path;
    if (
      relPath.startsWith('/') ||
      relPath.includes('\\') ||
      relPath.split('/').some(segment => segment === '..' || segment === '')
    ) {
      return { error: 'tree_unsafe_path' };
    }
    if (typeof entry.sha !== 'string' || !SHA.test(entry.sha)) return { error: 'tree_malformed' };

    const slug = slugForPath(relPath);
    // `docs/foo.mdx` and `docs/foo/index.mdx` both normalize to `docs/foo`, and
    // whichever wrote last would decide what that page says. Refuse rather than
    // pick.
    const existing = seen.get(slug);
    if (existing) return { error: 'tree_duplicate_slug' };
    seen.set(slug, relPath);

    pages.push({ relPath, slug, section: sectionForPath(relPath), sha: entry.sha });
  }

  if (pages.length === 0) return { error: 'tree_empty' };
  return { pages };
}

// ─── The report ─────────────────────────────────────────────────────────────

export type DocsPageOutcome = 'indexed' | 'skipped' | 'failed';

export interface DocsReconcileRow {
  slug: string;
  outcome: DocsPageOutcome;
  reason?: string;
  chunks?: number;
}

/** Why a run did no work at all. Absent when the run completed. */
export type DocsReconcileHalt =
  | 'lock_held'
  | 'not_configured'
  | 'tree_invalid'
  | 'tree_unavailable';

export interface DocsReconcileReport {
  /** The commit everything in this run was read at. Null when it never resolved. */
  commit: string | null;
  /** Entries in the tree, before eligibility. */
  pages: number;
  /** `.mdx` pages the run considered. */
  eligible: number;
  indexed: number;
  skipped: number;
  failed: number;
  /** Rows the sweep removed because their page is gone from the tree. */
  deleted: number;
  byReason: Record<string, number>;
  bySlug: DocsReconcileRow[];
  /**
   * Slugs indexed but UNREACHABLE BY SEARCH, because every chunk they have is
   * shorter than `DOCS_SEARCH_MIN_CHARS`.
   *
   * The two section-index pages are expected to be here — that is the whole
   * point of the threshold. Anything ELSE appearing is the signal: a real page
   * that got short, or a page whose extraction quietly collapsed to a title, is
   * otherwise a page that stops answering questions with nothing anywhere
   * saying so. `content_list` and `content_get` still reach every one of them.
   *
   * Read from the TABLE after the sweep, not from the chunks this run happened
   * to build: on a steady-state run every page is `skipped: fresh` and never
   * re-chunked, and a list assembled from those would come back empty on
   * exactly the runs where it matters.
   */
  belowSearchMin: string[];
  /**
   * Set when the run stopped before doing any work.
   *
   * READINESS IS `!halted && !error && failed === 0`, not `!error` alone:
   * `lock_held` and `not_configured` are not errors — the first is the
   * serialization working and the second is an environment with no Workers AI
   * credentials — but neither is a run that indexed anything.
   */
  halted?: DocsReconcileHalt;
  /** A run-level failure. Absent on a healthy run. */
  error?: string;
}

export interface ReconcileDocsOptions {
  /** Defaults to {@link createGitHubDocsReader}. */
  reader?: DocsReader;
  /** Pages in flight at once, `[1, MAX_CONCURRENCY]`. */
  concurrency?: number;
}

const emptyReport = (): DocsReconcileReport => ({
  commit: null,
  pages: 0,
  eligible: 0,
  indexed: 0,
  skipped: 0,
  failed: 0,
  deleted: 0,
  byReason: {},
  bySlug: [],
  belowSearchMin: [],
});

// ─── Storage ────────────────────────────────────────────────────────────────

async function storedChunks(slug: string): Promise<StoredChunk[]> {
  return getPrisma().$queryRaw<StoredChunk[]>`
    SELECT chunk_ix, chunk_count, source_sha, extract_version, embed_model,
           (embedding IS NULL) AS embedding_null
    FROM docs_index
    WHERE slug = ${slug}
    ORDER BY chunk_ix
  `;
}

/** Embed every chunk, in batches the client will accept. */
async function embedChunks(
  chunks: string[]
): Promise<{ ok: true; vectors: number[][] } | { ok: false; reason: string }> {
  const vectors: number[][] = [];
  for (let at = 0; at < chunks.length; at += MAX_BATCH_SIZE) {
    const result = await embedTexts(chunks.slice(at, at + MAX_BATCH_SIZE));
    // `chunkDocument` guarantees every piece is under the cap, so a refusal is
    // a bug here rather than a document problem, and a retry reaches the same
    // answer.
    if (!result.ok) return { ok: false, reason: result.reason };
    vectors.push(...result.vectors);
  }
  return { ok: true, vectors };
}

/**
 * Write one page's chunks, and remove the tail a shrink left behind.
 *
 * One transaction, so a page is never half-replaced. `updated_at` is set by
 * hand: `@updatedAt` is a Prisma CLIENT feature and a raw upsert goes straight
 * past it, which would leave the column frozen at insert time.
 */
async function writePage(
  page: EligiblePage,
  extracted: ExtractedMdx,
  chunks: string[],
  vectors: number[][]
): Promise<void> {
  const chunkCount = chunks.length;

  await getPrisma().$transaction(async tx => {
    for (const [index, text] of chunks.entries()) {
      const vector = toVectorLiteral(vectors[index]);
      await tx.$executeRaw`
        INSERT INTO docs_index
          (slug, chunk_ix, chunk_count, title, description, section, text,
           source_sha, extract_version, embed_model, embedding, updated_at)
        VALUES
          (${page.slug}, ${index}::int, ${chunkCount}::int, ${extracted.title},
           ${extracted.description}, ${page.section}, ${text},
           ${page.sha}, ${MDX_EXTRACT_VERSION}::int, ${EMBEDDING_MODEL},
           ${vector}::vector, NOW())
        ON CONFLICT (slug, chunk_ix) DO UPDATE SET
          chunk_count     = EXCLUDED.chunk_count,
          title           = EXCLUDED.title,
          description     = EXCLUDED.description,
          section         = EXCLUDED.section,
          text            = EXCLUDED.text,
          source_sha      = EXCLUDED.source_sha,
          extract_version = EXCLUDED.extract_version,
          embed_model     = EXCLUDED.embed_model,
          embedding       = EXCLUDED.embedding,
          updated_at      = NOW()
      `;
    }

    // A page that SHRANK leaves its old tail behind, and chunk 7 of the
    // previous version is a perfectly good row with a perfectly good vector
    // that goes on answering out of text this page no longer has.
    await tx.$executeRaw`
      DELETE FROM docs_index WHERE slug = ${page.slug} AND chunk_ix >= ${chunkCount}::int
    `;
  });
}

// ─── The lock ───────────────────────────────────────────────────────────────

/**
 * Hold the docs-reconcile lock for the length of a run.
 *
 * ── WHY THIS OPENS ITS OWN CONNECTION ──────────────────────────────────────
 * `pg_try_advisory_lock` is SESSION-scoped, and the shared Prisma client is a
 * connection POOL: the `SELECT pg_try_advisory_lock(…)` and the matching
 * `pg_advisory_unlock(…)` are two separate statements that the pool is free to
 * run on two different connections.
 *
 * When it does, the unlock is a no-op — it returns false and Postgres logs a
 * warning nobody reads — and the lock stays held on the first connection for as
 * long as that connection lives. From then on, every reconcile that lands on a
 * DIFFERENT pooled connection is refused with `lock_held`, and the nightly job
 * quietly stops indexing. That is a lock working perfectly against the wrong
 * thing: it serializes the job against ITSELF.
 *
 * A transaction-scoped lock (`pg_advisory_xact_lock`) is not the answer either,
 * because the lock has to be held across 25 HTTP fetches and their embeddings —
 * minutes — and that is not a transaction anybody should open.
 *
 * So the lock gets ONE connection of its own, opened when the run starts and
 * closed when it ends. One extra connection, once a night, for a guarantee that
 * is otherwise not a guarantee at all.
 */
interface DocsLock {
  release(): Promise<void>;
}

async function acquireDocsLock(): Promise<DocsLock | null> {
  // Reads DATABASE_URL at construction, exactly as `@classmoji/database` does,
  // so a caller that redirected the environment is followed here too.
  const session = new PrismaClient();
  try {
    const rows = await session.$queryRaw<Array<{ locked: boolean }>>`
      SELECT pg_try_advisory_lock(${DOCS_INDEX_LOCK_KEY}::bigint) AS locked
    `;
    if (rows[0]?.locked !== true) {
      await session.$disconnect();
      return null;
    }
  } catch (error) {
    await session.$disconnect().catch(() => {});
    throw error;
  }

  return {
    release: async () => {
      try {
        await session.$queryRaw`SELECT pg_advisory_unlock(${DOCS_INDEX_LOCK_KEY}::bigint)`;
      } catch {
        // Disconnecting drops the session, which drops the lock with it.
      } finally {
        await session.$disconnect().catch(() => {});
      }
    },
  };
}

// ─── Concurrency ────────────────────────────────────────────────────────────

async function mapWithLimit<T, R>(
  items: T[],
  limit: number,
  run: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const at = next;
      next += 1;
      if (at >= items.length) return;
      results[at] = await run(items[at]);
    }
  };

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// ─── The reconcile ──────────────────────────────────────────────────────────

/**
 * Bring `docs_index` level with the documentation on `main`.
 *
 * NEVER THROWS. Everything it decides comes back in the report, because "is the
 * docs index ready" has to be answerable without reading a log for individual
 * lines — and because the caller is a Trigger task whose `maxAttempts: 1` means
 * a thrown error is simply lost.
 */
export async function reconcileDocsIndex(
  opts: ReconcileDocsOptions = {}
): Promise<DocsReconcileReport> {
  const report = emptyReport();
  const bump = (reason: string): void => {
    report.byReason[reason] = (report.byReason[reason] ?? 0) + 1;
  };

  // Before any DB work and before any lock: an environment with no Workers AI
  // credentials is a normal state for most deployments, and it writes nothing.
  if (!isWorkersAiConfigured()) {
    report.halted = 'not_configured';
    return report;
  }

  const prisma = getPrisma();
  const reader = opts.reader ?? createGitHubDocsReader();
  const concurrency = Math.min(
    Math.max(Math.trunc(opts.concurrency ?? DEFAULT_CONCURRENCY) || DEFAULT_CONCURRENCY, 1),
    MAX_CONCURRENCY
  );

  // THE LOCK, taken before the commit is resolved. Taking it afterwards would
  // still let two runs resolve different commits and then serialize their
  // sweeps, which is the exact interleaving that deletes a live page.
  let lock: DocsLock | null;
  try {
    lock = await acquireDocsLock();
  } catch (error) {
    report.error = `lock: ${error instanceof Error ? error.message : String(error)}`;
    return report;
  }

  if (!lock) {
    report.halted = 'lock_held';
    return report;
  }

  try {
    let commit: string;
    let tree: { entries: DocsTreeEntry[]; truncated: boolean };
    try {
      commit = await reader.head();
      tree = await reader.tree(commit);
    } catch (error) {
      // Either REST call failing after its retries abandons the run WHOLE. It
      // is not a per-page problem and there is nothing safe to sweep against.
      report.halted = 'tree_unavailable';
      report.error = error instanceof Error ? error.message : String(error);
      return report;
    }

    report.commit = commit;
    report.pages = Array.isArray(tree.entries) ? tree.entries.length : 0;

    const validated = validateTree(tree.entries, tree.truncated);
    if ('error' in validated) {
      // NO WRITES AND NO DELETES. This is the branch that stands between a
      // truncated or malformed response and an emptied corpus.
      report.halted = 'tree_invalid';
      report.error = validated.error;
      return report;
    }

    const pages = validated.pages;
    report.eligible = pages.length;

    const rows = await mapWithLimit(pages, concurrency, page => indexPage(reader, commit, page));
    for (const row of rows) {
      report.bySlug.push(row);
      if (row.outcome === 'indexed') report.indexed += 1;
      else if (row.outcome === 'skipped') report.skipped += 1;
      else report.failed += 1;
      bump(row.reason ?? row.outcome);
    }

    // The sweep, LAST and only on a validated non-empty list. The array is a
    // bound parameter; nothing about a slug reaches the statement as text.
    const slugs = pages.map(page => page.slug);
    report.deleted = await prisma.$executeRaw`
      DELETE FROM docs_index WHERE slug <> ALL(${slugs}::text[])
    `;

    // After the sweep, so it describes the corpus a search will actually see.
    // `max(length(text))` and not `min`: a page is only unsearchable when EVERY
    // chunk is below the line, because `searchDocs` filters chunks and a page
    // with one long chunk is still reachable through it.
    const short = await prisma.$queryRaw<Array<{ slug: string }>>`
      SELECT slug
      FROM docs_index
      GROUP BY slug
      HAVING max(length(text)) < ${DOCS_SEARCH_MIN_CHARS}::int
      ORDER BY slug
    `;
    report.belowSearchMin = short.map(row => row.slug);

    return report;
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error);
    return report;
  } finally {
    await lock.release();
  }
}

/**
 * One page: is it stale, can it be read, can it be extracted, embed and write.
 *
 * Every failure keeps the page's LAST GOOD ROWS. The alternative — deleting on
 * a failed read — turns a transient 429 into a documentation page that stops
 * being findable until tomorrow morning.
 */
async function indexPage(
  reader: DocsReader,
  commit: string,
  page: EligiblePage
): Promise<DocsReconcileRow> {
  try {
    const stamp = {
      sourceSha: page.sha,
      extractVersion: MDX_EXTRACT_VERSION,
      embedModel: EMBEDDING_MODEL,
    };
    // The tree already carried the blob sha, so an unchanged page costs one
    // cheap query and NO body fetch at all.
    if (isFresh(await storedChunks(page.slug), stamp)) {
      return { slug: page.slug, outcome: 'skipped', reason: 'fresh' };
    }

    let body: string | null;
    try {
      body = await reader.body(commit, page.relPath);
    } catch (error) {
      const reason = error instanceof DocsBodyError ? error.reason : 'network';
      return { slug: page.slug, outcome: 'failed', reason };
    }
    if (body === null) return { slug: page.slug, outcome: 'failed', reason: 'http_404' };

    // Dynamic: the extract barrel reaches cheerio, and this module is on every
    // app's startup graph. See the file docblock.
    const { extractMdxText } = await import('../content/extract/index.ts');
    const extracted = extractMdxText(body);
    if (!extracted.ok) {
      console.warn(`[docsIndex] Extraction failed for ${page.relPath}: ${extracted.error}`);
      return { slug: page.slug, outcome: 'failed', reason: 'extract' };
    }

    const chunks = chunkDocument(extracted.text, extracted.title);
    if (chunks.length === 0) return { slug: page.slug, outcome: 'skipped', reason: 'empty' };

    const embedded = await embedChunks(chunks);
    if (!embedded.ok) {
      console.warn(`[docsIndex] Embedding refused ${page.relPath}: ${embedded.reason}`);
      return { slug: page.slug, outcome: 'failed', reason: embedded.reason };
    }

    await writePage(page, extracted, chunks, embedded.vectors);
    return { slug: page.slug, outcome: 'indexed', chunks: chunks.length };
  } catch (error) {
    console.warn(
      `[docsIndex] Could not index ${page.relPath}:`,
      error instanceof Error ? error.message : String(error)
    );
    return { slug: page.slug, outcome: 'failed', reason: 'error' };
  }
}
