/**
 * Course-content read tools — `content_search`, `content_list`, `content_get`.
 *
 * The retrieval surface Ask Moji answers out of (plan §5.7, P2-7). Three read
 * tools over one classroom's pages, slide decks and `bot-context/` notes: find
 * by meaning, enumerate, read one in full.
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
 * speaker notes, never `pageLink`/`navGrid` labels. That sanitization is the
 * extractor's job (`@classmoji/services/content/extract`); this file's job is
 * to never route around it. Note the divergence from `page_content_get`
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
  contentVisibility,
  getContentText,
  listContent,
  searchContent,
  MAX_SEARCH_LIMIT,
  DEFAULT_LIST_LIMIT,
  MAX_LIST_LIMIT,
  type ContentDocKind,
  type ContentListEntry,
  type ContentSearchHit,
} from '@classmoji/services';
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
export type SearchUnavailable = 'embedding_not_configured' | 'embedding_failed';

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
  queryChars: number;
  kind?: ContentDocKind;
  limit?: number;
  hits: ContentSearchHit[];
  unavailable: SearchUnavailable | null;
}): void {
  console.log(
    `[mcp] content_search ${JSON.stringify({
      classroom_id: entry.classroomId,
      role: entry.role,
      query_chars: entry.queryChars,
      kind: entry.kind ?? null,
      limit: entry.limit ?? null,
      result_count: entry.hits.length,
      results: entry.hits.map(hit => `${hit.docKind}:${hit.docId}`),
      unavailable: entry.unavailable,
    })}`
  );
}

export const contentSearchTool: ToolDefinition<ContentSearchArgs> = {
  name: 'content_search',
  title: 'Search course content',
  description:
    "Semantic search over this classroom's pages, slide decks and bot-context notes. Returns " +
    'document ids, titles and snippets ranked by meaning rather than keywords — ask the question ' +
    'the way a student would. Staff also reach unpublished material; students reach published ' +
    'material only. Use content_get to read a result in full. If the response carries an ' +
    '`unavailable` field, search itself could not run — that is NOT the same as "nothing found", ' +
    'and it must not be reported to the user as an absence of course material.',
  scope: 'read',
  roles: MEMBER,
  inputSchema: {
    classroom: classroomArg,
    query: z
      .string()
      .min(2)
      .max(500)
      .describe('What to look for, in plain language (a question works well)'),
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

    const embedded = await embedQuery(args.query);
    if (!embedded.ok) {
      logContentSearch({
        classroomId: classroom.classroomId,
        role: classroom.role,
        queryChars: args.query.length,
        kind: args.kind,
        limit: args.limit,
        hits: [],
        unavailable: embedded.unavailable,
      });
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

    const hits = await searchContent({
      classroomId: classroom.classroomId,
      role: classroom.role,
      queryVector: embedded.vector,
      ...(args.kind ? { kind: args.kind } : {}),
      ...(args.limit ? { limit: args.limit } : {}),
    });

    logContentSearch({
      classroomId: classroom.classroomId,
      role: classroom.role,
      queryChars: args.query.length,
      kind: args.kind,
      limit: args.limit,
      hits,
      unavailable: null,
    });

    return ok({ count: hits.length, hits: hits.map(presentHit) });
  },
};

// ─── content_list ───────────────────────────────────────────────────────────

interface ContentListArgs {
  classroom: string;
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
  title: 'List course content',
  description:
    'Enumerates every page, slide deck and bot-context note in this classroom that the caller may ' +
    'see, whether or not it has been indexed for search. Staff also see unpublished material. ' +
    'Each row reports `indexed`: false means content_search cannot reach that document yet, ' +
    'though content_get still can. Use this to find a document by name when a search comes back ' +
    `empty. The listing is paged: at most \`limit\` rows come back (default ${LIST_DEFAULT_LIMIT}, ` +
    `max ${LIST_MAX_LIMIT}) in a stable order. If \`truncated\` is true this is NOT the whole ` +
    'catalogue — call again with `offset` set to the returned `next_offset` to continue, and do ' +
    'not tell the user a document is absent on the strength of one page.',
  scope: 'read',
  roles: MEMBER,
  inputSchema: {
    classroom: classroomArg,
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
  kind: ContentDocKind;
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
  title: 'Read course content',
  description:
    'Returns the full plain text of one page, slide deck or bot-context note — the same text ' +
    'content_search ranks, so ids from a search result can be passed straight in. Use it after ' +
    'content_search or content_list to read a document a snippet only hinted at. Deck speaker ' +
    'notes are never included.',
  scope: 'read',
  roles: MEMBER,
  inputSchema: {
    classroom: classroomArg,
    kind: kindArg,
    id: z
      .string()
      .min(1)
      .max(400)
      .describe("Document id from content_search or content_list (a repo path for kind 'file')"),
  },
  handler: async (args, ctx) => {
    const classroom = requireClassroomCtx(ctx);

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
