/**
 * docsSearch.service.ts — reads over `docs_index`.
 *
 * The documentation half of the retrieval surface: `searchDocs` (vector
 * search), `listDocs` (enumeration), `getDocText` (one page in full), and
 * `docsIndexIsEmpty` (the one question a zero-hit answer has to be able to
 * distinguish).
 *
 * ── NO VISIBILITY RULE HERE, AND THAT IS THE POINT ─────────────────────────
 * `contentSearch.service.ts` next door exists mostly to render one draft/publish
 * predicate as SQL and as a TypeScript test, because course content is
 * per-classroom and per-viewer. None of that applies here: the documentation is
 * a public website. Every row is visible to every caller, there is no
 * `classroom_id` to filter on and no record to join back to.
 *
 * That does NOT make the tools anonymous. The MCP tools these back are still
 * `roles: MEMBER` against a supplied classroom — you have to be in a course to
 * ask Ask Moji anything. What is global is the CORPUS, not the door.
 *
 * ── Barrel constraint, inherited from the module next door ─────────────────
 * This module is flat-exported from `packages/services/src/index.ts`, which is
 * on the startup path of every app in the monorepo. It must therefore NEVER
 * statically import `./content/extract` (cheerio) or `./helpers/workersAi`. It
 * needs neither: it takes an already-embedded query vector from its caller and
 * reads `text` straight back out of the index, so both stay on the WRITE side.
 */

import getPrisma from '@classmoji/database';
import { docsUrl } from '@classmoji/utils';
import { toVectorLiteral } from './contentSearch.service.ts';

/** Result bounds for `searchDocs`, matching the `content_search` tool schema. */
export const DEFAULT_DOCS_SEARCH_LIMIT = 5;
export const MAX_DOCS_SEARCH_LIMIT = 20;

/**
 * Row bounds for `listDocs`, which are ITS OWN and not search's.
 *
 * Search is ranked, so five results is a sensible answer. A listing is an
 * enumeration, and a caller asking "what documentation is there?" wants the
 * table of contents, not the first five entries of it — the whole corpus is 25
 * pages, so the default comfortably covers it in one call. Clamping a listing
 * to the search cap of 20 would truncate the catalogue by five pages and set
 * `truncated`, which reads as "there is much more" rather than "there are five
 * more".
 */
export const DEFAULT_DOCS_LIST_LIMIT = 100;
export const MAX_DOCS_LIST_LIMIT = 200;

/** How much of a chunk a hit carries back. Same budget as the course lane. */
export const DOCS_SNIPPET_CHARS = 400;

const cappedCount = (value: number | undefined, fallback: number, max: number): number =>
  Math.min(Math.max(Math.trunc(value ?? fallback) || 0, 1), max);

// ─── searchDocs ─────────────────────────────────────────────────────────────

export interface DocsSearchHit {
  /** The URL path under classmoji.io. Also the id `getDocText` takes. */
  slug: string;
  /** Which chunk matched — 0 for a whole-page row. */
  chunkIx: number;
  title: string;
  description: string | null;
  section: string | null;
  /** A bounded slice of the matching chunk, never the whole page. */
  snippet: string;
  /** Cosine similarity in [-1, 1]; 1 is identical. */
  score: number;
}

export interface SearchDocsArgs {
  /** The embedded query, 1024 long. */
  queryVector: readonly number[];
  limit?: number;
}

/**
 * Semantic search over the documentation.
 *
 * ── The two ORDER BYs are not interchangeable ──────────────────────────────
 * `DISTINCT ON (slug)` collapses a chunked page to its single best chunk BEFORE
 * the limit applies, so one long page cannot crowd out every other page. But
 * Postgres REQUIRES the inner `ORDER BY` to lead with the `DISTINCT ON`
 * expressions: `ORDER BY embedding <=> q.v` alone is not merely differently
 * ordered, it is a syntax error ("SELECT DISTINCT ON expressions must match
 * initial ORDER BY expressions"). Hence `ORDER BY slug, distance, chunk_ix`
 * inside — which picks each page's nearest chunk, ties broken by the earlier
 * chunk — and `ORDER BY distance, slug` outside, which is where the actual
 * ranking happens.
 *
 * `WHERE embedding IS NOT NULL` keeps a row written before its embedding call
 * succeeded from sorting first by accident.
 *
 * There is no approximate index and no score floor. 25 rows make an exact scan
 * the cheapest correct plan, and a relevance threshold needs calibration data
 * nobody has — abstention is handled in the prompt, where the model can see the
 * document it is abstaining from.
 */
export async function searchDocs({
  queryVector,
  limit = DEFAULT_DOCS_SEARCH_LIMIT,
}: SearchDocsArgs): Promise<DocsSearchHit[]> {
  const literal = toVectorLiteral(queryVector);
  const cappedLimit = cappedCount(limit, DEFAULT_DOCS_SEARCH_LIMIT, MAX_DOCS_SEARCH_LIMIT);

  return getPrisma().$queryRaw<DocsSearchHit[]>`
    WITH q AS (SELECT ${literal}::vector AS v)
    SELECT best.slug        AS "slug",
           best.chunk_ix    AS "chunkIx",
           best.title       AS "title",
           best.description AS "description",
           best.section     AS "section",
           best.snippet     AS "snippet",
           best.score       AS "score"
    FROM (
      SELECT DISTINCT ON (di.slug)
             di.slug,
             di.chunk_ix,
             di.title,
             di.description,
             di.section,
             LEFT(di.text, ${DOCS_SNIPPET_CHARS}::int) AS snippet,
             1 - (di.embedding <=> q.v) AS score,
             (di.embedding <=> q.v)     AS distance
      FROM docs_index di
      CROSS JOIN q
      WHERE di.embedding IS NOT NULL
      ORDER BY di.slug, di.embedding <=> q.v, di.chunk_ix
    ) AS best
    ORDER BY best.distance ASC, best.slug
    LIMIT ${cappedLimit}`;
}

// ─── listDocs ───────────────────────────────────────────────────────────────

export interface DocsListEntry {
  slug: string;
  title: string;
  description: string | null;
  section: string | null;
  /** The canonical page URL, built from the one shared origin. */
  url: string | null;
  updatedAt: Date;
}

export interface ListDocsArgs {
  /** Rows to return. Clamped to `[1, MAX_DOCS_LIST_LIMIT]`. */
  limit?: number;
  /** Rows to skip. Negative and fractional values floor to 0. */
  offset?: number;
}

export interface DocsListPage {
  items: DocsListEntry[];
  /** True when more rows matched than were returned. */
  truncated: boolean;
  /** The `offset` that continues this listing, or null when it is complete. */
  nextOffset: number | null;
}

/**
 * The documentation's table of contents.
 *
 * ONE ROW PER PAGE, not per chunk. `DISTINCT ON (slug) … ORDER BY slug,
 * chunk_ix` takes each page's first chunk, which is the one carrying the title;
 * without it a three-chunk page would appear three times and a model would
 * report the corpus as half again as large as it is.
 *
 * The presentation order is then `section NULLS FIRST, lower(title), slug` —
 * the root pages (`docs`, `docs/video-tutorials`) first, then each section's
 * pages alphabetically. That order is TOTAL, which is what makes `OFFSET` safe
 * to page on: no two rows tie, so the window cannot shift under a caller
 * mid-listing unless the corpus itself changes.
 *
 * `limit + 1` rows are asked for and at most `limit` returned: one extra row is
 * the cheapest possible answer to "is there more?", and a caller handed exactly
 * `limit` rows otherwise cannot tell a complete catalogue from a truncated one.
 *
 * Unlike `listContent`, this reads the INDEX rather than a live record table,
 * because the index is the only place these pages exist on this side of the
 * wire. A page that has not been indexed yet is therefore simply absent — and
 * `docsIndexIsEmpty` is how a caller tells "nothing indexed yet" from "nothing
 * there".
 */
export async function listDocs({ limit, offset }: ListDocsArgs = {}): Promise<DocsListPage> {
  const cappedLimit = cappedCount(limit, DEFAULT_DOCS_LIST_LIMIT, MAX_DOCS_LIST_LIMIT);
  const cappedOffset = Math.max(Math.trunc(offset ?? 0) || 0, 0);

  const rows = await getPrisma().$queryRaw<Array<Omit<DocsListEntry, 'url'>>>`
    SELECT page.slug        AS "slug",
           page.title       AS "title",
           page.description AS "description",
           page.section     AS "section",
           page.updated_at  AS "updatedAt"
    FROM (
      SELECT DISTINCT ON (di.slug)
             di.slug, di.title, di.description, di.section, di.updated_at
      FROM docs_index di
      ORDER BY di.slug, di.chunk_ix
    ) AS page
    ORDER BY page.section ASC NULLS FIRST, lower(page.title), page.slug
    LIMIT ${cappedLimit + 1} OFFSET ${cappedOffset}`;

  const truncated = rows.length > cappedLimit;
  // The probe row is never handed out — it exists only to have been counted.
  const items = (truncated ? rows.slice(0, cappedLimit) : rows).map(row => ({
    ...row,
    url: docsUrl(row.slug),
  }));

  return {
    items,
    truncated,
    nextOffset: truncated ? cappedOffset + cappedLimit : null,
  };
}

// ─── getDocText ─────────────────────────────────────────────────────────────

/**
 * No such documentation page.
 *
 * Deliberately NOT the same refusal as `ContentNotFoundError`. That one is
 * uniform across "no such id", "another classroom's id" and "an id you may not
 * see", because distinguishing them would turn `content_get` into a probe a
 * student could enumerate drafts with. Documentation is public: there is
 * nothing to enumerate and no cross-classroom boundary to defend, so this can
 * say plainly what happened.
 */
export class DocsNotFoundError extends Error {
  readonly code = 'DOC_NOT_FOUND';

  constructor() {
    super('Documentation page not found.');
    this.name = 'DocsNotFoundError';
  }
}

export interface DocsDocumentText {
  slug: string;
  title: string;
  description: string | null;
  section: string | null;
  /** The canonical page URL. */
  url: string | null;
  /** Every chunk, concatenated in `chunk_ix` order. */
  text: string;
  chunkCount: number;
  updatedAt: Date;
}

/**
 * One documentation page's full extracted text.
 *
 * ONE SIGNATURE: a bare slug in, the page out, `DocsNotFoundError` when there
 * is none. No options object and no viewer, because there is nothing to vary.
 *
 * `string_agg(text, … ORDER BY chunk_ix)` is what reassembles a chunked page in
 * reading order; without the ORDER BY inside the aggregate, Postgres is free to
 * concatenate the chunks in whatever order the scan produced, and a model
 * reading a shuffled document answers confidently out of a paragraph that has
 * lost its context.
 *
 * This returns the INDEXED text — what the extractor produced — never the raw
 * `.mdx`, so no caller is ever handed component syntax or frontmatter markers.
 */
export async function getDocText(slug: string): Promise<DocsDocumentText> {
  if (typeof slug !== 'string' || slug.length === 0) throw new DocsNotFoundError();

  const rows = await getPrisma().$queryRaw<Array<Omit<DocsDocumentText, 'url'>>>`
    SELECT di.slug AS "slug",
           (array_agg(di.title       ORDER BY di.chunk_ix))[1] AS "title",
           (array_agg(di.description ORDER BY di.chunk_ix))[1] AS "description",
           (array_agg(di.section     ORDER BY di.chunk_ix))[1] AS "section",
           string_agg(di.text, chr(10) || chr(10) ORDER BY di.chunk_ix) AS "text",
           count(*)::int   AS "chunkCount",
           max(di.updated_at) AS "updatedAt"
    FROM docs_index di
    WHERE di.slug = ${slug}
    GROUP BY di.slug`;

  const [document] = rows;
  if (!document) throw new DocsNotFoundError();
  return { ...document, url: docsUrl(document.slug) };
}

// ─── docsIndexIsEmpty ───────────────────────────────────────────────────────

/**
 * Has this deployment ever built the documentation index?
 *
 * THE ANSWER IS THE BOOLEAN THE STATEMENT RETURNS, not a property of the result
 * array. Two tempting wrong shapes:
 *
 *   - `rows.length === 0` on `SELECT … FROM docs_index LIMIT 1` inverted, or
 *     any variant that tests whether a row came BACK: `SELECT NOT EXISTS (…)`
 *     always returns exactly one row, so testing the array is always `false`;
 *   - `SELECT count(*) = 0`: counts rows, not USABLE rows. A table full of
 *     rows whose embedding is null is not empty by that measure, and is
 *     completely unsearchable.
 *
 * `NOT EXISTS (SELECT 1 … WHERE embedding IS NOT NULL)` answers the question
 * the caller is actually asking: can a search find anything at all? It is the
 * difference between telling a user "the docs say nothing about that" and
 * telling them "documentation search has not been switched on here".
 */
export async function docsIndexIsEmpty(): Promise<boolean> {
  const rows = await getPrisma().$queryRaw<Array<{ empty: boolean }>>`
    SELECT NOT EXISTS (SELECT 1 FROM docs_index WHERE embedding IS NOT NULL) AS empty`;
  return rows[0]?.empty === true;
}
