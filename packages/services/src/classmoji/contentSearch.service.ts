import { Prisma } from '@prisma/client';
import type { Role } from '@prisma/client';
import getPrisma from '@classmoji/database';

/**
 * Permission-joined reads over `content_index` (plan §5.6, P2-6).
 *
 * ── What this module is ────────────────────────────────────────────────────
 * The single place where "may this viewer see this document?" is turned into
 * both a SQL fragment and a TypeScript predicate. Three read entry points sit
 * on top of it — `searchContent` (vector search), `listContent` (enumeration)
 * and `getContentText` (one document's sanitized text) — and none of them
 * implements a rule of its own. Each forwards a role; the rule lives here.
 *
 * ── The rule (decision D6) ─────────────────────────────────────────────────
 *   visible ⟺ (NOT is_draft OR viewer is staff) AND (is_public OR viewer is a member)
 *
 * Read off the live per-page view gate in the pages app,
 * `apps/pages/app/routes/$classroomSlug.$pageId/route.server.ts` (the
 * `canViewDrafts` test and the `!page.is_public && !userRole` test), and
 * matching decks in `packages/auth/src/server.ts`. `site.service.ts`'s
 * `isPageVisibleOnSite` is deliberately STRICTER (drafts never serve on the
 * public site, not even to an owner) — that is the public-host rule, not this
 * one.
 *
 * Module publish state is NOT a gate. A page reachable only through an
 * unpublished module is still a published page; module publish is a navigation
 * concern, and joining `module_items` here would hide content the pages app
 * itself serves.
 *
 * ── Why the conjunction order matters ──────────────────────────────────────
 * `is_draft = true AND is_public = true` is representable (the admin UI derives
 * a single status and never writes that pair, but the columns are independent)
 * and both live implementations resolve it to HIDDEN. Written as
 * `is_public OR NOT is_draft` it would resolve to visible. The terms below are
 * a CONJUNCTION for exactly that reason; keep it that way under any refactor.
 *
 * ── Tenancy ────────────────────────────────────────────────────────────────
 * Every statement filters `classroom_id` on the index row AND restates it on
 * the joined `pages` / `slides` row. An index row is derived data; it must
 * never be the thing that decides which classroom a document belongs to.
 */

// ─── Viewer ────────────────────────────────────────────────────────────────

/** `null` means "not a member of this classroom" — an anonymous or outside viewer. */
export type ContentViewerRole = Role | null;

/** The three kinds of row `content_index` holds. */
export type ContentDocKind = 'page' | 'slide' | 'file';

/** Roles that prepare course material together, and so see each other's drafts. */
export const CONTENT_STAFF_ROLES: readonly Role[] = ['OWNER', 'TEACHER', 'ASSISTANT'];

/** The pages-app draft tier. Students are members; they are not staff. */
export const canSeeDrafts = (role: ContentViewerRole): boolean =>
  role !== null && CONTENT_STAFF_ROLES.includes(role);

/**
 * Any classroom membership at all, including STUDENT.
 *
 * Named `isMemberRole`, not `isMember`, because `classroomMembership.service`
 * already exports an async `isMember(classroomId, userId)` that goes to the
 * database. This one only reads a role the caller's gate already resolved.
 */
export const isMemberRole = (role: ContentViewerRole): boolean => role !== null;

/** The two viewer facts the rule is written in terms of. */
export interface ViewerFlags {
  readonly canSeeDrafts: boolean;
  readonly isMember: boolean;
}

// ─── The rule, written once ────────────────────────────────────────────────

interface VisibilityTerm {
  /** A boolean column present on both `pages` and `slides`. */
  readonly column: 'is_draft' | 'is_public';
  /** The column value that satisfies this term on its own. */
  readonly satisfiedBy: boolean;
  /** The viewer flag that waives the term when the column does not satisfy it. */
  readonly waiver: keyof ViewerFlags;
}

/**
 * THE RULE. Both renderings below — SQL and TypeScript — are generated from
 * this list and nothing else, so there is no second copy to fall out of step.
 * A document is visible when EVERY term holds; a term holds when the column
 * already satisfies it, or the viewer's flag waives it.
 *
 * Adding a gate means adding a row here, and both renderings pick it up.
 */
const VISIBILITY_TERMS: readonly VisibilityTerm[] = [
  // Unfinished work is staff-only.
  { column: 'is_draft', satisfiedBy: false, waiver: 'canSeeDrafts' },
  // Anything not marked public needs a membership row.
  { column: 'is_public', satisfiedBy: true, waiver: 'isMember' },
];

/**
 * POLICY — `file` rows are visible to every MEMBER of the classroom.
 *
 * A `file` row is indexed repo text with no `Page` or `Slide` behind it, which
 * in practice means `bot-context/`: notes an instructor writes specifically so
 * the assistant can answer from them. There is no `is_draft` / `is_public` pair
 * to test, so the rule reduces to one of the two waivers, and the owner's call
 * (D8) was to keep `bot-context/` searchable rather than exclude it.
 *
 * To make it staff-only instead, change this one constant to 'canSeeDrafts'.
 * Both the SQL branch and the TypeScript branch read it.
 */
const FILE_VISIBILITY_WAIVER: keyof ViewerFlags = 'isMember';

/** The `is_draft` / `is_public` pair every visibility decision reads. */
export interface ContentVisibilityFlags {
  is_draft: boolean;
  is_public: boolean;
}

/** Both renderings of the rule for one viewer, plus the facts they came from. */
export interface ContentVisibility extends ViewerFlags {
  /** The TypeScript predicate, for a row already in memory. */
  allows(doc: ContentVisibilityFlags): boolean;
  /** The SQL predicate for a `pages` / `slides` row under `alias`. */
  sql(alias: string): Prisma.Sql;
  /** Whether this viewer may see `file` rows at all. */
  readonly allowsFiles: boolean;
  /** The same answer as a SQL fragment, so a statement need not branch in JS. */
  readonly filesSql: Prisma.Sql;
}

/** Identifiers reaching `Prisma.raw` are constants, not input — assert it anyway. */
const SAFE_IDENTIFIER = /^[a-z][a-z0-9_]*$/;
const identifier = (value: string): Prisma.Sql => {
  if (!SAFE_IDENTIFIER.test(value)) throw new Error(`unsafe SQL identifier: ${value}`);
  return Prisma.raw(value);
};

/**
 * The one authorization builder. Give it the role the caller's gate already
 * resolved; take back the rule in whichever form the call site needs.
 *
 * The role is never an argument a model or a client supplies — the MCP registry
 * resolves membership and role before any handler runs, and the webapp resolves
 * it from the session.
 */
export function contentVisibility(role: ContentViewerRole): ContentVisibility {
  const flags: ViewerFlags = { canSeeDrafts: canSeeDrafts(role), isMember: isMemberRole(role) };

  const allows = (doc: ContentVisibilityFlags): boolean =>
    VISIBILITY_TERMS.every(term => doc[term.column] === term.satisfiedBy || flags[term.waiver]);

  const sql = (alias: string): Prisma.Sql => {
    const table = identifier(alias);
    return Prisma.join(
      VISIBILITY_TERMS.map(term => {
        const column = identifier(term.column);
        const waived = Prisma.sql`${flags[term.waiver]}::boolean`;
        return term.satisfiedBy
          ? Prisma.sql`(${table}.${column} OR ${waived})`
          : Prisma.sql`(NOT ${table}.${column} OR ${waived})`;
      }),
      ' AND '
    );
  };

  return {
    ...flags,
    allows,
    sql,
    allowsFiles: flags[FILE_VISIBILITY_WAIVER],
    filesSql: Prisma.sql`${flags[FILE_VISIBILITY_WAIVER]}::boolean`,
  };
}

// ─── Vectors ───────────────────────────────────────────────────────────────

/** `vector(1024)`, fixed by the column and by @cf/qwen/qwen3-embedding-0.6b. */
export const EMBEDDING_DIMENSIONS = 1024;

/**
 * A query vector as a pgvector literal.
 *
 * Every element is checked to be a finite number before it is formatted, so the
 * string this returns cannot contain anything but digits, signs, dots, `e`,
 * commas and brackets. It is still passed as a BOUND PARAMETER (`$n::vector`),
 * never concatenated into the statement — the validation is the second lock,
 * not the first.
 */
export function toVectorLiteral(vector: readonly number[]): string {
  if (!Array.isArray(vector) || vector.length !== EMBEDDING_DIMENSIONS) {
    throw new Error(
      `query vector must have ${EMBEDDING_DIMENSIONS} dimensions, got ${
        Array.isArray(vector) ? vector.length : typeof vector
      }`
    );
  }
  const parts = vector.map((value, index) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error(`query vector element ${index} is not a finite number`);
    }
    return String(value);
  });
  return `[${parts.join(',')}]`;
}

// ─── Shared statement pieces ───────────────────────────────────────────────

/** How much of a chunk's text a search hit carries back. Bounded on purpose. */
export const SNIPPET_CHARS = 400;

/** Result count bounds, matching the `content_search` tool schema. */
export const DEFAULT_SEARCH_LIMIT = 5;
export const MAX_SEARCH_LIMIT = 20;

const DOC_KINDS: readonly ContentDocKind[] = ['page', 'slide', 'file'];

const assertClassroomId = (classroomId: string): void => {
  if (typeof classroomId !== 'string' || classroomId.length === 0) {
    throw new Error('classroomId is required');
  }
};

const assertKind = (kind: ContentDocKind | undefined): void => {
  if (kind !== undefined && !DOC_KINDS.includes(kind)) {
    throw new Error(`unknown doc kind: ${String(kind)}`);
  }
};

/**
 * The three-branch disjunction every statement here shares.
 *
 * `p.id IS NOT NULL` / `s.id IS NOT NULL` are what make an orphan index row
 * (the record was deleted and the cascade has not caught up, or the row names a
 * record in another classroom) unreachable rather than merely stale. The
 * permission test and the branch that selects the row live in the SAME boolean,
 * so there is no "search, then filter" step a refactor could reorder.
 */
const visibleRowsSql = (visibility: ContentVisibility): Prisma.Sql => Prisma.sql`(
       (ci.doc_kind = 'page'  AND p.id IS NOT NULL AND ${visibility.sql('p')})
    OR (ci.doc_kind = 'slide' AND s.id IS NOT NULL AND ${visibility.sql('s')})
    OR (ci.doc_kind = 'file'  AND ${visibility.filesSql})
  )`;

/** The live-record joins, both restated on `classroom_id`. */
const liveRecordJoinsSql = (classroomId: string): Prisma.Sql => Prisma.sql`
      LEFT JOIN pages  p ON ci.doc_kind = 'page'  AND p.id = ci.doc_id AND p.classroom_id = ${classroomId}
      LEFT JOIN slides s ON ci.doc_kind = 'slide' AND s.id = ci.doc_id AND s.classroom_id = ${classroomId}`;

/**
 * `is_draft` is a STAFF-ONLY field on every result shape.
 *
 * A student who could read it would learn a draft exists even when the row
 * itself is filtered out; null for everyone else closes that channel.
 */
const draftColumnSql = (visibility: ContentVisibility, expression: Prisma.Sql): Prisma.Sql =>
  Prisma.sql`CASE WHEN ${visibility.canSeeDrafts}::boolean THEN ${expression} ELSE NULL END`;

// ─── searchContent ─────────────────────────────────────────────────────────

export interface ContentSearchHit {
  docKind: ContentDocKind;
  docId: string;
  /** Which chunk matched — 0 for a whole-document row. */
  chunkIx: number;
  title: string;
  /** A bounded slice of the matching chunk, never the whole document. */
  snippet: string;
  /** Cosine similarity in [-1, 1]; 1 is identical. */
  score: number;
  /** Staff only. Always null for a student or a non-member. */
  isDraft: boolean | null;
}

export interface SearchContentArgs {
  classroomId: string;
  role: ContentViewerRole;
  /** The embedded query, `EMBEDDING_DIMENSIONS` long. */
  queryVector: readonly number[];
  kind?: ContentDocKind;
  limit?: number;
}

/**
 * Semantic search over one classroom's indexed content.
 *
 * There is no approximate index by design: the corpus is a few hundred rows per
 * classroom, so an exact `ORDER BY embedding <=> $q` over rows already narrowed
 * by `classroom_id` is both cheap and exactly right. `<=>` is cosine distance,
 * matching how the vectors were produced.
 *
 * `DISTINCT ON (doc_kind, doc_id)` collapses a chunked document to its single
 * best chunk BEFORE the limit applies, so one long deck cannot crowd out every
 * other document; the outer query then re-sorts those bests by distance.
 *
 * A viewer with no membership is not an error here — they simply match only
 * published, public documents, and no `file` rows. The MCP refuses a non-member
 * long before a handler runs; this module is the second lock, not the first.
 */
export async function searchContent({
  classroomId,
  role,
  queryVector,
  kind,
  limit = DEFAULT_SEARCH_LIMIT,
}: SearchContentArgs): Promise<ContentSearchHit[]> {
  assertClassroomId(classroomId);
  assertKind(kind);

  const visibility = contentVisibility(role);
  const literal = toVectorLiteral(queryVector);
  const cappedLimit = Math.min(Math.max(Math.trunc(limit) || 0, 1), MAX_SEARCH_LIMIT);
  const kindFilter = kind
    ? Prisma.sql`
        AND ci.doc_kind = ${kind}`
    : Prisma.empty;

  return getPrisma().$queryRaw<ContentSearchHit[]>`
    WITH q AS (SELECT ${literal}::vector AS v)
    SELECT best.doc_kind AS "docKind",
           best.doc_id   AS "docId",
           best.chunk_ix AS "chunkIx",
           best.title    AS "title",
           best.snippet  AS "snippet",
           best.score    AS "score",
           best.is_draft AS "isDraft"
    FROM (
      SELECT DISTINCT ON (ci.doc_kind, ci.doc_id)
             ci.doc_kind,
             ci.doc_id,
             ci.chunk_ix,
             ci.title,
             LEFT(ci.text, ${SNIPPET_CHARS}::int) AS snippet,
             1 - (ci.embedding <=> q.v)      AS score,
             (ci.embedding <=> q.v)          AS distance,
             ${draftColumnSql(
               visibility,
               Prisma.sql`CASE ci.doc_kind WHEN 'page' THEN p.is_draft WHEN 'slide' THEN s.is_draft ELSE NULL END`
             )} AS is_draft
      FROM content_index ci
      CROSS JOIN q${liveRecordJoinsSql(classroomId)}
      WHERE ci.classroom_id = ${classroomId}
        AND ci.embedding IS NOT NULL${kindFilter}
        AND ${visibleRowsSql(visibility)}
      ORDER BY ci.doc_kind, ci.doc_id, ci.embedding <=> q.v, ci.chunk_ix
    ) AS best
    ORDER BY best.distance ASC, best.doc_kind, best.doc_id
    LIMIT ${cappedLimit}`;
}

// ─── listContent ───────────────────────────────────────────────────────────

export interface ContentListEntry {
  docKind: ContentDocKind;
  docId: string;
  title: string;
  /** Pages may have none; `file` rows are addressed by path, so never. */
  slug: string | null;
  /** Staff only. Always null for a student or a non-member. */
  isDraft: boolean | null;
  updatedAt: Date;
  /** Whether this document currently has a searchable (embedded) index row. */
  indexed: boolean;
}

export interface ListContentArgs {
  classroomId: string;
  role: ContentViewerRole;
  kind?: ContentDocKind;
}

/**
 * Everything in this classroom this viewer may see, whether or not it is indexed.
 *
 * Deliberately NOT the search statement with the vector removed. Listing reads
 * the LIVE `pages` and `slides` rows, so a classroom that has never been indexed
 * — or one whose indexer is failing — still enumerates correctly, and `indexed`
 * says which documents search can currently reach. It shares the one visibility
 * builder with search, so the two cannot disagree about who may see what; they
 * only disagree about coverage, which is the point.
 *
 * `file` entries are the exception: they have no live record, so the index is
 * the only place they exist.
 */
export async function listContent({
  classroomId,
  role,
  kind,
}: ListContentArgs): Promise<ContentListEntry[]> {
  assertClassroomId(classroomId);
  assertKind(kind);

  const visibility = contentVisibility(role);

  const pageBranch = Prisma.sql`
      SELECT 'page'::text AS doc_kind,
             p.id         AS doc_id,
             p.title      AS title,
             p.slug       AS slug,
             ${draftColumnSql(visibility, Prisma.sql`p.is_draft`)} AS is_draft,
             p.updated_at AS updated_at,
             EXISTS (
               SELECT 1 FROM content_index ci
               WHERE ci.classroom_id = p.classroom_id
                 AND ci.doc_kind = 'page' AND ci.doc_id = p.id
                 AND ci.embedding IS NOT NULL
             ) AS indexed
      FROM pages p
      WHERE p.classroom_id = ${classroomId} AND ${visibility.sql('p')}`;

  const slideBranch = Prisma.sql`
      SELECT 'slide'::text AS doc_kind,
             s.id          AS doc_id,
             s.title       AS title,
             s.slug        AS slug,
             ${draftColumnSql(visibility, Prisma.sql`s.is_draft`)} AS is_draft,
             s.updated_at  AS updated_at,
             EXISTS (
               SELECT 1 FROM content_index ci
               WHERE ci.classroom_id = s.classroom_id
                 AND ci.doc_kind = 'slide' AND ci.doc_id = s.id
                 AND ci.embedding IS NOT NULL
             ) AS indexed
      FROM slides s
      WHERE s.classroom_id = ${classroomId} AND ${visibility.sql('s')}`;

  // One entry per file even when the extractor chunked it; the first chunk
  // carries the title, and `indexed` reports whether that chunk got a vector.
  const fileBranch = Prisma.sql`
      SELECT * FROM (
        SELECT DISTINCT ON (ci.doc_id)
               'file'::text  AS doc_kind,
               ci.doc_id     AS doc_id,
               ci.title      AS title,
               NULL::text    AS slug,
               NULL::boolean AS is_draft,
               ci.updated_at AS updated_at,
               (ci.embedding IS NOT NULL) AS indexed
        FROM content_index ci
        WHERE ci.classroom_id = ${classroomId}
          AND ci.doc_kind = 'file'
          AND ${visibility.filesSql}
        ORDER BY ci.doc_id, ci.chunk_ix
      ) AS files`;

  const branches = { page: pageBranch, slide: slideBranch, file: fileBranch };
  const selected = kind ? [branches[kind]] : [branches.page, branches.slide, branches.file];

  return getPrisma().$queryRaw<ContentListEntry[]>`
    SELECT entry.doc_kind   AS "docKind",
           entry.doc_id     AS "docId",
           entry.title      AS "title",
           entry.slug       AS "slug",
           entry.is_draft   AS "isDraft",
           entry.updated_at AS "updatedAt",
           entry.indexed    AS "indexed"
    FROM (${Prisma.join(selected, ' UNION ALL ')}) AS entry
    ORDER BY entry.doc_kind, lower(entry.title), entry.doc_id`;
}

// ─── getContentText ────────────────────────────────────────────────────────

/**
 * The one refusal `getContentText` raises.
 *
 * It is the SAME error for "no such document", "a document in another
 * classroom" and "a document you may not see". Distinguishing them would turn
 * this call into a probe: a student could enumerate draft ids by watching which
 * ones answered differently.
 */
export class ContentNotFoundError extends Error {
  readonly code = 'CONTENT_NOT_FOUND';

  constructor() {
    super('Content not found in this classroom.');
    this.name = 'ContentNotFoundError';
  }
}

export interface ContentDocumentText {
  docKind: ContentDocKind;
  docId: string;
  title: string;
  /** The repo-relative file the text was extracted from. */
  sourcePath: string;
  /** Every chunk, concatenated in `chunk_ix` order. */
  text: string;
  chunkCount: number;
  /** Staff only. Always null for a student or a non-member. */
  isDraft: boolean | null;
}

export interface GetContentTextArgs {
  classroomId: string;
  role: ContentViewerRole;
  docKind: ContentDocKind;
  docId: string;
}

/**
 * One document's extracted text, after the same visibility check as search.
 *
 * This returns the INDEXED text — what the extractor produced and sanitized —
 * not the bytes a fetch would return. Callers therefore never hand a model raw
 * repo content, and a document the indexer has not reached yet reads as
 * not-found rather than as an unfiltered fetch.
 */
export async function getContentText({
  classroomId,
  role,
  docKind,
  docId,
}: GetContentTextArgs): Promise<ContentDocumentText> {
  assertClassroomId(classroomId);
  assertKind(docKind);
  if (typeof docId !== 'string' || docId.length === 0) throw new ContentNotFoundError();

  const visibility = contentVisibility(role);

  const rows = await getPrisma().$queryRaw<ContentDocumentText[]>`
    SELECT ci.doc_kind AS "docKind",
           ci.doc_id   AS "docId",
           (array_agg(ci.title       ORDER BY ci.chunk_ix))[1] AS "title",
           (array_agg(ci.source_path ORDER BY ci.chunk_ix))[1] AS "sourcePath",
           string_agg(ci.text, chr(10) || chr(10) ORDER BY ci.chunk_ix) AS "text",
           count(*)::int AS "chunkCount",
           ${draftColumnSql(
             visibility,
             Prisma.sql`bool_or(COALESCE(p.is_draft, s.is_draft))`
           )} AS "isDraft"
    FROM content_index ci${liveRecordJoinsSql(classroomId)}
    WHERE ci.classroom_id = ${classroomId}
      AND ci.doc_kind = ${docKind}
      AND ci.doc_id = ${docId}
      AND ${visibleRowsSql(visibility)}
    GROUP BY ci.doc_kind, ci.doc_id`;

  const [document] = rows;
  if (!document) throw new ContentNotFoundError();
  return document;
}
