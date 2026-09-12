/**
 * Content read tools — `content_search`, `content_list`, `content_get`.
 *
 * The retrieval surface Ask Moji answers out of (plan §5.7, P2-7). Three read
 * tools: find by meaning, enumerate, read one in full.
 *
 * ── TWO CORPORA BEHIND THE SAME THREE TOOLS ────────────────────────────────
 * `scope: 'course'` (the default) is this classroom's pages, slide decks and
 * `bot-context/` notes — per classroom, permission-filtered, drafts included
 * for staff. `scope: 'docs'` is the Classmoji PRODUCT DOCUMENTATION at
 * classmoji.io: fleet-wide, public, identical for every caller, and answering
 * "how does this platform work" rather than "what does this course require".
 *
 * They are one tool rather than six because the model's decision is which
 * corpus to ask, not which tool to call — and because a second set of tools is
 * a second set of descriptions to keep in step. They are two code paths rather
 * than one table because everything below the surface differs: one has a
 * visibility predicate and a live fallback, the other has neither and could not
 * safely have either.
 *
 * NOTE that this input `scope` and each tool's `scope: 'read'` are unrelated.
 * The latter is the OAuth scope a bearer token must carry. Nothing about
 * `scope: 'docs'` widens who may call anything: all three tools stay
 * `roles: MEMBER` against the supplied classroom, so documentation is global
 * BEHIND a membership rather than anonymously readable.
 *
 * ── ONE PREDICATE, AND IT IS NOT HERE (decision D6) ────────────────────────
 * Nothing in this file decides who may see what. Every handler resolves the
 * viewer's role from `ctx.classroom` — which the registry established against a
 * real `ClassroomMembership` before any handler ran — and hands that role to
 * `packages/services/src/classmoji/contentSearch.service.ts`, which renders the
 * visibility rule as SQL for the queries and as `contentVisibility(role).allows`
 * for a row already in memory. The live fallback below calls that same
 * `allows`. There is deliberately no draft test, no role list and no staff
 * check written here: a tool that remembered the rule is a tool that can forget
 * it, and the rule was already implemented six different ways across this
 * codebase before this lane existed. `contentSearch.test.ts` asserts this file
 * contains no visibility-column literal of its own.
 *
 * ── The role tier ──────────────────────────────────────────────────────────
 * All three are `roles: MEMBER` — every classroom role including STUDENT. That
 * is not `roles: null`: null means "any authenticated caller, no classroom
 * needed", which would let a stranger read a course. MEMBER means the registry
 * resolves the classroom, refuses a non-member with `forbidden/NOT_A_MEMBER`,
 * and hands the handler the membership it found.
 *
 * ── What a caller gets back ────────────────────────────────────────────────
 * Only the SANITIZED extracted text the indexer stored (or, in the one fallback
 * below, the same extractor run live) — never raw repo bytes, never a deck's
 * speaker notes, never `pageLink`/`navGrid` labels, and for documentation never
 * the `.mdx` source. That sanitization is the extractor's job
 * (`@classmoji/services/content/extract`); this file's job is to never route
 * around it — which is also why `scope: 'docs'` has NO live fallback: a
 * fallback there would mean fetching a caller-supplied path from github.com on
 * demand. Note the divergence from `page_content_get`
 * (`pageContent.ts`), which still reads GitHub through `ContentService` with no
 * such filtering — out of scope for this lane, flagged in the PR.
 *
 * ── Instrumentation ────────────────────────────────────────────────────────
 * `content_search` writes one structured line per call: classroom, role, query
 * LENGTH (never the query text), the documents returned, and whether retrieval
 * was unavailable. That line is how we will later measure retrieval misses —
 * whether whole-document vectors are enough — without keeping a copy of what
 * students asked.
 */

import { z } from 'zod';
import getPrisma from '@classmoji/database';
import {
  ClassmojiService,
  ContentNotFoundError,
  DocsNotFoundError,
  contentVisibility,
  docsIndexIsEmpty,
  getContentText,
  getDocText,
  listContent,
  listDocs,
  searchContent,
  searchDocs,
  MAX_SEARCH_LIMIT,
  DEFAULT_LIST_LIMIT,
  MAX_LIST_LIMIT,
  type ContentDocKind,
  type ContentListEntry,
  type ContentSearchHit,
  type DocsListEntry,
  type DocsSearchHit,
} from '@classmoji/services';
import { docsUrl } from '@classmoji/utils';
import { WorkersAiError, embedTexts, isWorkersAiConfigured } from '@classmoji/services/workers-ai';
import { ToolError } from '../mcp/errors.ts';
import type { ToolContext, ToolDefinition } from '../mcp/registry.ts';
import { MEMBER } from '../resources/shape.ts';
import { ok, requireClassroomCtx, scopedNotFound } from './shared.ts';

// ─── Shared input pieces ────────────────────────────────────────────────────

const classroomArg = z.string().describe("Classroom reference as 'org/slug'");

const kindArg = z
  .enum(['page', 'slide', 'file'])
  .describe("Document kind: 'page', 'slide' (a deck), or 'file' (a bot-context/ note)");

/**
 * WHICH CORPUS to read. Not a permission.
 *
 * `scope: 'read'` on each tool below is the OAuth scope the bearer token must
 * carry; this `scope` argument names one of two bodies of text. They share a
 * word and nothing else, and conflating them is how a widening here would get
 * read as a widening there. Membership in the supplied `classroom` is still
 * required for both — what is global is the corpus, not the door.
 *
 *   'course' (default) — this classroom's pages, decks and bot-context notes.
 *                        Per classroom, permission-filtered, may include drafts.
 *   'docs'             — the Classmoji product documentation at classmoji.io.
 *                        Fleet-wide, public, identical for every caller.
 */
const scopeArg = z
  .enum(['course', 'docs'])
  .describe(
    "Which body of text to read: 'course' (default) for this classroom's own material, " +
      "or 'docs' for the Classmoji product documentation at classmoji.io"
  );

type ContentScope = 'course' | 'docs';

/**
 * `content_get`'s kind union, kept SEPARATE from {@link kindArg}.
 *
 * Widening the shared `kindArg` to include `'doc'` would silently broaden
 * `content_search` and `content_list` — both of which take `kind` as a FILTER
 * over course content — and with them the live-fallback's assumption that every
 * kind it is handed has a `pages`/`slides` row or is a repo path. A `'doc'`
 * reaching that code is a `findFirst` on a slug. Two unions is two lines; one
 * union is a silent broadening of three tools to fix one.
 */
const getKindArg = z
  .enum(['page', 'slide', 'file', 'doc'])
  .describe(
    "Document kind: 'page', 'slide' (a deck), 'file' (a bot-context/ note), or " +
      "'doc' (a Classmoji documentation page, from a scope: 'docs' search)"
  );

type ContentGetKind = ContentDocKind | 'doc';

/**
 * `kind` filters course content. It cannot filter documentation, which has no
 * kinds — so the pair is refused rather than one of them quietly ignored.
 *
 * SILENTLY DROPPING AN ARGUMENT IS HOW A MODEL CONCLUDES A FILTER WAS APPLIED.
 * Asked for "slides about tokens" and handed documentation pages with the
 * `kind` ignored, it reports them as slides.
 */
function assertScopeAndKind(scope: ContentScope, kind: ContentDocKind | undefined): void {
  if (scope === 'docs' && kind !== undefined) {
    throw new ToolError(
      'invalid_params',
      "`kind` filters course content and has no meaning for scope: 'docs' — " +
        'the documentation has no kinds. Drop `kind`, or drop `scope`.'
    );
  }
}

/**
 * The marker a zero-hit documentation answer carries when the index was never
 * built on this deployment.
 *
 * NOT "no search was run" — a search WAS run, against an empty table, and a
 * message that says otherwise is simply false. What the caller needs to know is
 * that the absence is an absence of INDEX, not of documentation.
 */
const DOCS_INDEX_EMPTY = 'docs_index_empty';
const DOCS_INDEX_EMPTY_MESSAGE =
  'The documentation index has not been built on this deployment — there is nothing to search ' +
  'yet. This is not an empty result set.';

/**
 * ONE refusal for every way `content_get` can fail to produce a document: no
 * such id, another classroom's id, an id this viewer may not see, and an id
 * with nothing readable behind it. Distinguishing them would turn the tool into
 * a probe — a student could enumerate unpublished ids by watching which ones
 * answered differently.
 */
const contentNotFound = (): ToolError => scopedNotFound('Content');

// ─── content_search ─────────────────────────────────────────────────────────

interface ContentSearchArgs {
  classroom: string;
  query: string;
  scope?: ContentScope;
  kind?: ContentDocKind;
  limit?: number;
}

/**
 * Why a search could not run, as a value a model can branch on.
 *
 * The point of the field is that "retrieval is down" and "the course has
 * nothing about that" are different answers and must not arrive as the same
 * empty list. A model that cannot tell them apart will confidently report the
 * second when the truth is the first.
 */
export type SearchUnavailable =
  | 'embedding_not_configured'
  | 'embedding_failed'
  /**
   * The documentation index is empty ON THIS DEPLOYMENT. Distinct from the two
   * above: the embedding worked and the query ran — there is simply nothing in
   * the table yet, because the backfill has not been run here. Reported as
   * `unavailable` rather than as an empty result for the same reason as the
   * others: "the docs do not cover that" and "documentation search has not been
   * switched on" are different answers, and a model handed the same empty list
   * for both will confidently give the first.
   */
  | 'docs_index_empty';

type EmbeddedQuery = { ok: true; vector: number[] } | { ok: false; unavailable: SearchUnavailable };

/**
 * Turn the query into a vector, or say why not.
 *
 * Never throws: an embedding failure is an answerable state of this tool, not
 * an internal error, because the caller can act on it (retry, ask differently,
 * fall back to `content_list`) in a way it cannot act on a stack trace.
 */
async function embedQuery(query: string): Promise<EmbeddedQuery> {
  if (!isWorkersAiConfigured()) return { ok: false, unavailable: 'embedding_not_configured' };

  try {
    const result = await embedTexts([query]);
    if (!result.ok) {
      // A refusal, not a fault — `over_cap` is the only member today, and the
      // zod cap on `query` should make it unreachable from here.
      console.warn(`[mcp] content_search embedding refused: ${result.reason}`);
      return { ok: false, unavailable: 'embedding_failed' };
    }
    const [vector] = result.vectors;
    if (!vector) return { ok: false, unavailable: 'embedding_failed' };
    return { ok: true, vector };
  } catch (error) {
    const code = error instanceof WorkersAiError ? error.code : null;
    console.warn(`[mcp] content_search embedding failed (${code ?? 'unknown'}):`, error);
    // `not_configured` can still reach here if the credentials vanish between
    // the guard above and the call; report it as the configuration problem it
    // is rather than as a transient fault a retry would fix.
    return {
      ok: false,
      unavailable: code === 'not_configured' ? 'embedding_not_configured' : 'embedding_failed',
    };
  }
}

/** A hit as the model sees it. `isDraft` is present only when staff. */
function presentHit(hit: ContentSearchHit) {
  return {
    kind: hit.docKind,
    id: hit.docId,
    title: hit.title,
    /** Which chunk of a long document matched; 0 for a whole-document row. */
    chunk: hit.chunkIx,
    snippet: hit.snippet,
    /** Cosine similarity, rounded — four places is well past what ranking uses. */
    score: Math.round(hit.score * 1e4) / 1e4,
    // The service nulls this for anyone who is not staff. Omitting the key
    // rather than sending null keeps "this viewer is not told" distinct from
    // "this document is published".
    ...(typeof hit.isDraft === 'boolean' ? { isDraft: hit.isDraft } : {}),
  };
}

/** A documentation hit as the model sees it. */
function presentDocsHit(hit: DocsSearchHit) {
  return {
    // `kind: 'doc'` is what content_get takes back, and what the prompt keys
    // the `platform_docs` reference type off.
    kind: 'doc' as const,
    // The SLUG is the id. It is also the URL path, which is why there is no
    // separate mapping and no way for the citation and the link to disagree.
    id: hit.slug,
    title: hit.title,
    ...(hit.section ? { section: hit.section } : {}),
    ...(hit.description ? { description: hit.description } : {}),
    url: docsUrl(hit.slug),
    chunk: hit.chunkIx,
    snippet: hit.snippet,
    score: Math.round(hit.score * 1e4) / 1e4,
  };
}

/** A documentation listing row. */
function presentDocsEntry(entry: DocsListEntry) {
  return {
    kind: 'doc' as const,
    id: entry.slug,
    title: entry.title,
    ...(entry.section ? { section: entry.section } : {}),
    ...(entry.description ? { description: entry.description } : {}),
    url: entry.url,
    updated_at: new Date(entry.updatedAt).toISOString(),
    /** Listing reads the index, so anything listed is searchable. */
    indexed: true,
  };
}

/**
 * The retrieval-quality log line (plan §5.6, "instrumentation, from day one").
 *
 * Ids and counts only. The query itself is reduced to its length: what we need
 * to answer later is "did retrieval return anything, and did the model use it",
 * and neither question needs a transcript of what a student typed.
 */
function logContentSearch(entry: {
  classroomId: string;
  role: string;
  scope: ContentScope;
  queryChars: number;
  kind?: ContentDocKind;
  limit?: number;
  /**
   * ALREADY NORMALIZED to `{ kind, id }`, not `ContentSearchHit[]`.
   *
   * The two corpora return different row shapes (`docKind`/`docId` against
   * `slug`), and a logger that took one of them would either need a second
   * overload or would quietly log `undefined:undefined` for the other. The
   * caller has the hit in hand and knows which it is; normalizing there is one
   * line and cannot be wrong for half the calls.
   */
  hits: Array<{ kind: string; id: string }>;
  unavailable: SearchUnavailable | null;
}): void {
  console.log(
    `[mcp] content_search ${JSON.stringify({
      classroom_id: entry.classroomId,
      role: entry.role,
      // Which corpus was searched — the one dimension retrieval quality now has
      // to be read along, since a docs miss and a course miss have different
      // fixes.
      scope: entry.scope,
      query_chars: entry.queryChars,
      kind: entry.kind ?? null,
      limit: entry.limit ?? null,
      result_count: entry.hits.length,
      results: entry.hits.map(hit => `${hit.kind}:${hit.id}`),
      unavailable: entry.unavailable,
    })}`
  );
}

export const contentSearchTool: ToolDefinition<ContentSearchArgs> = {
  name: 'content_search',
  title: 'Search course content and Classmoji docs',
  description:
    'Semantic search over one of two bodies of text, chosen with `scope`. ' +
    "`scope: 'course'` (the default) searches THIS classroom's pages, slide decks and " +
    'bot-context notes: staff also reach unpublished material, students reach published ' +
    'material only. ' +
    "`scope: 'docs'` searches the Classmoji PRODUCT DOCUMENTATION at classmoji.io — how the " +
    'platform works, the same for every classroom — and returns `kind: "doc"` hits whose `id` is ' +
    'the page slug and whose `url` is a real link you may cite. Use it for "how does X work in ' +
    'Classmoji", and `course` for anything about this particular course. ' +
    'Results are ranked by meaning rather than keywords, so ask the question the way a person ' +
    'would. Read a result in full with content_get before answering from it. If the response ' +
    'carries an `unavailable` field, search itself could not run or the index is not built — ' +
    'that is NOT the same as "nothing found", and it must not be reported to the user as an ' +
    'absence of material.',
  scope: 'read',
  roles: MEMBER,
  inputSchema: {
    classroom: classroomArg,
    query: z
      .string()
      .min(2)
      .max(500)
      .describe('What to look for, in plain language (a question works well)'),
    scope: scopeArg.optional(),
    kind: kindArg.optional(),
    limit: z
      .number()
      .int()
      .positive()
      .max(MAX_SEARCH_LIMIT)
      .optional()
      .describe(`Max documents to return (default 5, max ${MAX_SEARCH_LIMIT})`),
  },
  handler: async (args, ctx) => {
    const classroom = requireClassroomCtx(ctx);
    const scope: ContentScope = args.scope ?? 'course';
    assertScopeAndKind(scope, args.kind);

    const log = (
      hits: Array<{ kind: string; id: string }>,
      unavailable: SearchUnavailable | null
    ): void =>
      logContentSearch({
        classroomId: classroom.classroomId,
        role: classroom.role,
        scope,
        queryChars: args.query.length,
        kind: args.kind,
        limit: args.limit,
        hits,
        unavailable,
      });

    // ONE embedding path for both corpora: the same client, the same refusal
    // classes, the same `embedding_*` markers. A docs search that failed to
    // embed has to be as distinguishable from an empty one as a course search
    // is, and a second code path here would be a second place to forget that.
    const embedded = await embedQuery(args.query);
    if (!embedded.ok) {
      log([], embedded.unavailable);
      return ok({
        count: 0,
        hits: [],
        unavailable: embedded.unavailable,
        message:
          embedded.unavailable === 'embedding_not_configured'
            ? 'Content search is not configured on this deployment — no search was run. This is not an empty result set.'
            : 'The embedding service could not answer — no search was run. This is not an empty result set.',
      });
    }

    if (scope === 'docs') {
      const hits = await searchDocs({
        queryVector: embedded.vector,
        ...(args.limit ? { limit: args.limit } : {}),
      });

      // Zero hits over a corpus that exists means the documentation genuinely
      // does not cover it. Zero hits over a corpus that was never built means
      // something else entirely, and only the index can tell them apart — so
      // it is asked ONLY when there is an absence to explain.
      if (hits.length === 0 && (await docsIndexIsEmpty())) {
        log([], DOCS_INDEX_EMPTY);
        return ok({
          count: 0,
          hits: [],
          unavailable: DOCS_INDEX_EMPTY,
          message: DOCS_INDEX_EMPTY_MESSAGE,
        });
      }

      const presented = hits.map(presentDocsHit);
      log(presented, null);
      return ok({ count: presented.length, hits: presented });
    }

    const hits = await searchContent({
      classroomId: classroom.classroomId,
      role: classroom.role,
      queryVector: embedded.vector,
      ...(args.kind ? { kind: args.kind } : {}),
      ...(args.limit ? { limit: args.limit } : {}),
    });

    log(
      hits.map(hit => ({ kind: hit.docKind, id: hit.docId })),
      null
    );

    return ok({ count: hits.length, hits: hits.map(presentHit) });
  },
};

// ─── content_list ───────────────────────────────────────────────────────────

interface ContentListArgs {
  classroom: string;
  scope?: ContentScope;
  kind?: ContentDocKind;
  limit?: number;
  offset?: number;
}

// The listing window. The service clamps whatever arrives to the same bounds;
// the zod schema names them so the model is refused at the same threshold the
// service clamps at, never somewhere else.
const LIST_DEFAULT_LIMIT = DEFAULT_LIST_LIMIT;
const LIST_MAX_LIMIT = MAX_LIST_LIMIT;

/** A listing row. `isDraft` is present only when staff; `indexed` is coverage. */
function presentEntry(entry: ContentListEntry) {
  return {
    kind: entry.docKind,
    id: entry.docId,
    title: entry.title,
    slug: entry.slug,
    updated_at: new Date(entry.updatedAt).toISOString(),
    /** False means content_search cannot reach it yet — content_get still can. */
    indexed: entry.indexed,
    ...(typeof entry.isDraft === 'boolean' ? { isDraft: entry.isDraft } : {}),
  };
}

export const contentListTool: ToolDefinition<ContentListArgs> = {
  name: 'content_list',
  title: 'List course content and Classmoji docs',
  description:
    'Enumerates one of two bodies of text, chosen with `scope`. ' +
    "`scope: 'course'` (the default) lists every page, slide deck and bot-context note in THIS " +
    'classroom the caller may see, whether or not it has been indexed for search; staff also ' +
    'see unpublished material, and each row reports `indexed` — false means content_search ' +
    'cannot reach that document yet, though content_get still can. ' +
    '`scope: \'docs\'` lists the Classmoji product documentation at classmoji.io as `kind: "doc"` ' +
    'rows with a real `url`; documentation exists only in the index, so a row that is listed is ' +
    'a row search can reach, and an empty listing with an `unavailable` marker means the index ' +
    'has not been built here rather than that there are no docs. ' +
    'Use this to find something by name when a search comes back empty. The listing is paged: ' +
    `at most \`limit\` rows come back (default ${DEFAULT_LIST_LIMIT}, max ${MAX_LIST_LIMIT}) in a ` +
    'stable order. If `truncated` is true this is NOT the whole catalogue — call again with ' +
    '`offset` set to the returned `next_offset` to continue, and do not tell the user something ' +
    'is absent on the strength of one page.',
  scope: 'read',
  roles: MEMBER,
  inputSchema: {
    classroom: classroomArg,
    scope: scopeArg.optional(),
    kind: kindArg.optional(),
    limit: z
      .number()
      .int()
      .positive()
      .max(LIST_MAX_LIMIT)
      .optional()
      .describe(`Max rows to return (default ${LIST_DEFAULT_LIMIT}, max ${LIST_MAX_LIMIT})`),
    offset: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe('Rows to skip — pass the `next_offset` from a truncated listing'),
  },
  handler: async (args, ctx) => {
    const classroom = requireClassroomCtx(ctx);
    const scope: ContentScope = args.scope ?? 'course';
    assertScopeAndKind(scope, args.kind);

    if (scope === 'docs') {
      const page = await listDocs({
        ...(args.limit ? { limit: args.limit } : {}),
        ...(args.offset ? { offset: args.offset } : {}),
      });

      // The same distinction search draws, drawn here too: an empty catalogue
      // and a catalogue that was never built are different facts, and a model
      // handed a bare `[]` for both will report the first.
      if (page.items.length === 0 && (await docsIndexIsEmpty())) {
        return ok({
          count: 0,
          items: [],
          truncated: false,
          unavailable: DOCS_INDEX_EMPTY,
          message: DOCS_INDEX_EMPTY_MESSAGE,
        });
      }

      return ok({
        count: page.items.length,
        items: page.items.map(presentDocsEntry),
        truncated: page.truncated,
        ...(page.nextOffset !== null ? { next_offset: page.nextOffset } : {}),
      });
    }

    const page = await listContent({
      classroomId: classroom.classroomId,
      role: classroom.role,
      ...(args.kind ? { kind: args.kind } : {}),
      ...(args.limit ? { limit: args.limit } : {}),
      ...(args.offset ? { offset: args.offset } : {}),
    });
    return ok({
      count: page.items.length,
      items: page.items.map(presentEntry),
      truncated: page.truncated,
      // Present only when there IS a next page, so its absence is unambiguous.
      ...(page.nextOffset !== null ? { next_offset: page.nextOffset } : {}),
    });
  },
};

// ─── content_get, and its live fallback ─────────────────────────────────────

interface ContentGetArgs {
  classroom: string;
  kind: ContentGetKind;
  id: string;
}

interface LiveDocument {
  title: string;
  sourcePath: string;
  text: string;
}

/**
 * The record a live read needs, loaded by a query that names the classroom.
 *
 * The whole row is fetched rather than a `select` list on purpose: the
 * visibility columns are named in ONE place (the service's rule table), and a
 * `select` here would have to restate them — the first step toward this file
 * owning a copy of the predicate. The classroom chain rides along because the
 * delivery layer needs the content repo and the key version to sign a read.
 */
const LIVE_RECORD_QUERY = {
  include: { classroom: { include: { git_organization: true } } },
} as const;

/**
 * The canonical source file for a document, in preference order.
 *
 * The same order the indexer's planner uses: `content.json` is a page's real
 * body and `index.html` is its legacy one, live only until a page is migrated.
 * A deck's `index.html` is generated from `deck.json` on every save and is what
 * a reader sees, so it — not the source — is what gets extracted.
 */
const sourceCandidates = (kind: 'page' | 'slide', contentPath: string): string[] =>
  kind === 'page'
    ? [`${contentPath}/content.json`, `${contentPath}/index.html`]
    : [`${contentPath}/index.html`];

/**
 * Read one document from the content repo and extract it, for a viewer already
 * established as allowed to see it.
 *
 * WHY THIS EXISTS. A classroom's index is filled by a save-time hook and a
 * nightly reconcile, and both can be behind: the hook only fires for
 * delivery-enabled classrooms, and a page written five minutes ago has not met
 * the reconcile yet. Without this, `content_get` would answer "not found" for a
 * document the caller can plainly see in the web app — the worst kind of wrong
 * answer, because it looks like an authorization decision and is not.
 *
 * WHAT IT IS NOT. It is not a way around the index or around the extractor: the
 * bytes go through the SAME extractor the indexer uses, so a caller gets the
 * same sanitized text (no speaker notes, no link labels) and never the raw
 * fetched bytes. `'file'` documents have no record behind them at all — the
 * index IS their record — so there is nothing to fall back to and this returns
 * null for them.
 *
 * The extractor is loaded with a dynamic import because it parses HTML with
 * cheerio, which `packages/services/src/slides/index.ts` records must not be
 * pulled into a process's startup graph. A tool that is called occasionally can
 * pay for it when it is called.
 *
 * @returns the document, or `null` when there is nothing this viewer may read —
 *   indistinguishable, by design, from "no such id".
 */
async function readLiveDocument(
  kind: ContentDocKind,
  docId: string,
  ctx: ToolContext
): Promise<LiveDocument | null> {
  // No DB row, so no record to authorize against and no canonical path to read.
  if (kind === 'file') return null;

  const classroom = requireClassroomCtx(ctx);
  const prisma = getPrisma();

  const record =
    kind === 'page'
      ? await prisma.page.findFirst({
          where: { id: docId, classroom_id: classroom.classroomId },
          ...LIVE_RECORD_QUERY,
        })
      : await prisma.slide.findFirst({
          where: { id: docId, classroom_id: classroom.classroomId },
          ...LIVE_RECORD_QUERY,
        });
  if (!record) return null;

  // THE predicate — the same function the search and list statements are built
  // from, applied to the row we just loaded. Not a second implementation of it.
  if (!contentVisibility(classroom.role).allows(record)) return null;

  const deliveryClassroom = record.classroom;
  if (!deliveryClassroom?.git_organization?.login) {
    // A classroom with no git organization cannot be read from at all. Past the
    // visibility check, so this is a configuration fault rather than a refusal.
    throw new ToolError('internal', 'Classroom git organization is not configured');
  }

  const { extractText } = await import('@classmoji/services/content/extract');

  for (const path of sourceCandidates(kind, record.content_path)) {
    const body = await ClassmojiService.contentDelivery.fetchContentText(
      { classroom: deliveryClassroom },
      path,
      { label: 'content_get' }
    );
    if (!body) continue;

    const extracted = extractText(
      path.endsWith('.json')
        ? { kind: 'blocknote', json: body.text }
        : kind === 'slide'
          ? { kind: 'deck-html', html: body.text }
          : { kind: 'page-html', html: body.text },
      { title: record.title }
    );
    // `ok: false` means the bytes could not be understood. An empty string then
    // means "unreadable", not "this document is empty", and must not be served
    // as though it were the document.
    if (!extracted.ok) continue;

    // `.text` only — never `.notes` (instructor-facing speaker notes) and never
    // `.references` (labels copied from other documents, whose own draft state
    // this one says nothing about).
    return { title: record.title, sourcePath: path, text: extracted.text };
  }

  throw new ToolError(
    'internal',
    'This document is not indexed yet and its content could not be read from the content repository'
  );
}

export const contentGetTool: ToolDefinition<ContentGetArgs> = {
  name: 'content_get',
  title: 'Read course content or a Classmoji doc',
  description:
    'Returns the full plain text of one document — the same text content_search ranks, so an ' +
    'id and kind from a search or listing result can be passed straight back in. ' +
    "For `kind: 'page' | 'slide' | 'file'` that is this classroom's own material (deck speaker " +
    'notes are never included). ' +
    "For `kind: 'doc'` it is a Classmoji product documentation page from classmoji.io: pass the " +
    'page slug as `id`, and the response carries the canonical `url` you may cite. ' +
    'Use it after content_search or content_list to read a document a snippet only hinted at.',
  scope: 'read',
  roles: MEMBER,
  inputSchema: {
    classroom: classroomArg,
    kind: getKindArg,
    id: z
      .string()
      .min(1)
      .max(400)
      .describe(
        "Document id from content_search or content_list (a repo path for kind 'file', a page " +
          "slug such as 'docs/instructors/roster' for kind 'doc')"
      ),
  },
  handler: async (args, ctx) => {
    const classroom = requireClassroomCtx(ctx);

    if (args.kind === 'doc') {
      try {
        const document = await getDocText(args.id);
        return ok({
          kind: 'doc',
          id: document.slug,
          title: document.title,
          ...(document.description ? { description: document.description } : {}),
          ...(document.section ? { section: document.section } : {}),
          url: document.url,
          indexed: true,
          chunk_count: document.chunkCount,
          text: document.text,
        });
      } catch (error) {
        if (!(error instanceof DocsNotFoundError)) throw error;
        // Deliberately NOT `scopedNotFound('Content')`. That refusal is uniform
        // on purpose, because distinguishing "no such id" from "another
        // classroom's id" would turn course lookups into a probe a student
        // could enumerate drafts with. Documentation is public and global:
        // there is nothing to enumerate and no boundary to defend, so the
        // refusal can say what actually happened.
        //
        // There is also NO LIVE FALLBACK here. The course lane falls back to
        // reading the content repo because its index can legitimately lag a
        // page somebody just saved. Documentation only exists in the index, so
        // a fallback would mean fetching an arbitrary caller-supplied path from
        // github.com on demand.
        throw new ToolError('not_found', 'Documentation page not found');
      }
    }

    try {
      const document = await getContentText({
        classroomId: classroom.classroomId,
        role: classroom.role,
        docKind: args.kind,
        docId: args.id,
      });
      return ok({
        kind: document.docKind,
        id: document.docId,
        title: document.title,
        source_path: document.sourcePath,
        indexed: true,
        chunk_count: document.chunkCount,
        text: document.text,
        ...(typeof document.isDraft === 'boolean' ? { isDraft: document.isDraft } : {}),
      });
    } catch (error) {
      if (!(error instanceof ContentNotFoundError)) throw error;

      // Not in the index. That is a coverage answer, not an authorization one,
      // so ask the records — under the same predicate — before refusing.
      const live = await readLiveDocument(args.kind, args.id, ctx);
      if (!live) throw contentNotFound();

      return ok({
        kind: args.kind,
        id: args.id,
        title: live.title,
        source_path: live.sourcePath,
        /** Read live from the content repo: search cannot reach it yet. */
        indexed: false,
        text: live.text,
      });
    }
  },
};
