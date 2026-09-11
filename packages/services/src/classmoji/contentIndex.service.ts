/**
 * contentIndex.service.ts — course content → `content_index` rows.
 *
 * One document (a page, a deck, or an instructor note under `bot-context/`)
 * becomes one or more rows carrying the extracted text and its Workers AI
 * vector, so `content_search` can find it by meaning. This file is the ONLY
 * writer of that table.
 *
 * ── Where it is called from, and why not where the plan said ────────────────
 * The obvious hook was `warmContentText`, which already reads the bytes on the
 * way out of a save. It is the wrong place: `warmContentText` returns at its
 * first line unless `content_delivery_enabled` is true for the classroom, and
 * that column is on for about seven classrooms. A hook there would index almost
 * nothing on save and leave the nightly reconcile as the only writer for the
 * rest of the fleet.
 *
 * So the hooks sit in the SAVE paths instead, where the just-committed bytes
 * and the sha the commit returned are both already in hand, and they are gated
 * on nothing about delivery:
 *
 *   - `pageContent.service.ts`  `recordPageFile` (ordinary page save)
 *   - `pageContent.service.ts`  `acceptPreview` (preview merge on main)
 *   - `slides/slideContent.service.ts`  `recordDeckFiles` (deck save)
 *   - `slides/deckPreview.service.ts`   accept (artifact regenerated on main)
 *   - `page.service.ts`         `createWithContent`, AFTER the row exists
 *   - `contentImport.service.ts` both import loops, AFTER the rows exist
 *
 * Every one of them is fire-and-forget (`void`), exactly like the warm and the
 * thumbnail enqueue beside it: `indexOneFile` NEVER REJECTS, so a `void` call
 * cannot turn an embedding failure into a failed save, and a failed index is a
 * stale index that the nightly reconcile repairs.
 *
 * Preview-branch saves are still excluded — "ungated" means no delivery-rollout
 * gate, not indexing content nobody has accepted. The save paths already skip
 * `recordPageFile` / `recordDeckFiles` for a preview branch, so the hooks
 * inherit that for free.
 *
 * ── cheerio, and why the extractor is a dynamic import ──────────────────────
 * `@classmoji/services/content/extract` parses HTML with cheerio, and cheerio
 * must not load through the root barrel — the webapp, mcp, hook-station and
 * tasks all import that barrel at startup. This module IS in the barrel (the
 * save paths reach it through `ClassmojiService.contentIndex`), so the
 * extractor is loaded with a dynamic `import()` inside the indexing path and
 * nowhere else. Same reasoning applies to `contentDelivery.service.ts`, which
 * the reconcile's default byte source reaches the same way — a static import
 * would make this file a cycle partner of the save paths that import it.
 *
 * ── The two invariants a write has to hold ──────────────────────────────────
 * 1. A row must never be BEHIND the repo without saying so. `source_sha`,
 *    `extract_version` and `embed_model` are stamped on every chunk, and any
 *    of the three moving re-indexes the document.
 * 2. A row must never claim a sha it does not hold. Embedding is a network call
 *    of seconds, and a second save can land inside it — so the write re-reads
 *    the asset map's current sha inside its transaction and aborts rather than
 *    publishing an older document under a newer sha's name.
 */

import { Prisma } from '@prisma/client';
import getPrisma from '@classmoji/database';

// The read side owns the vocabulary the two halves have to agree on — the kind
// union and pgvector's literal form. Imported rather than restated: a writer and
// a reader that each keep their own copy of "what a doc_kind is" agree right up
// until one of them gains a member.
import { toVectorLiteral, type ContentDocKind } from './contentSearch.service.ts';

import {
  EMBEDDING_MODEL,
  MAX_BATCH_SIZE,
  embedTexts,
  estimateTokens,
  isWorkersAiConfigured,
  maxInputChars,
  maxInputTokens,
} from '../helpers/workersAi.ts';

/**
 * The extractor's shape. Bumped when extraction changes what `text` looks like
 * for the same bytes; a stored row whose stamp is lower is re-indexed on the
 * next reconcile even though its sha has not moved.
 */
export const EXTRACT_VERSION = 1;

/** `content_index.doc_kind`. `'file'` keys on the repo path, not a DB row. */
export type { ContentDocKind };

/**
 * What happened, in a form the reconcile can add up.
 *
 * `skipped` is the ordinary outcome, not a warning: an unchanged document, an
 * asset, a preview, an unconfigured environment. `failed` means the document
 * SHOULD be indexed and is not.
 */
export type IndexOutcome = 'indexed' | 'skipped' | 'failed';

export interface IndexResult {
  outcome: IndexOutcome;
  /** Machine-readable; the reconcile buckets on it. Absent only on a clean index. */
  reason?: string;
  /** Rows written. Present only when `outcome` is `indexed`. */
  chunks?: number;
}

/**
 * The record the caller already knows about.
 *
 * A save path has the row in hand, and handing it over is not just an
 * optimization: resolving a page from its path is a `findFirst`, because
 * `content_path` carries no unique constraint, so two rows sharing a path would
 * make the lookup pick one arbitrarily and index the wrong document's title.
 */
export interface DocHint {
  kind: ContentDocKind;
  /** `Page.id` / `Slide.id`; for `'file'`, the repo path. */
  id: string;
  title?: string;
}

/** Which extractor a path's bytes need. */
type ExtractKind = 'blocknote' | 'page-html' | 'deck-html' | 'plain-text';

export interface PathTarget {
  kind: ContentDocKind;
  extract: ExtractKind;
  /** The normalized repo-relative path itself — what `source_path` stores. */
  sourcePath: string;
  /**
   * The folder that identifies the record — `pages/<slug>` or `slides/<slug>`.
   * For `'file'` it is the path itself, which is also the `doc_id`.
   */
  docPath: string;
  /**
   * True for `pages/<slug>/index.html`, which is a page's LEGACY body. It is
   * indexed only when the page has no `content.json`; see `indexOneFile`.
   */
  legacy: boolean;
}

export type PathClassification =
  | { indexable: true; target: PathTarget }
  | { indexable: false; reason: string };

/** Instructor-authored notes the syllabus bot reads. D8: indexed, not excluded. */
const FILE_PREFIX = 'bot-context/';

/**
 * Which `bot-context/` files are prose.
 *
 * An allowlist rather than a denylist: the folder is instructor-authored and
 * can hold anything they dragged in, and embedding a CSV or a PDF's bytes
 * produces a vector that ranks against real questions while saying nothing.
 */
const FILE_EXTRACT_BY_EXTENSION: Record<string, ExtractKind> = {
  md: 'plain-text',
  markdown: 'plain-text',
  txt: 'plain-text',
  text: 'plain-text',
  html: 'page-html',
  htm: 'page-html',
};

/**
 * Repo-relative, no `..`, no leading slash. A path that cannot be normalized is
 * not indexable rather than throwing — this runs on a save tail.
 */
function normalizePath(raw: string): string | null {
  const path = String(raw ?? '')
    .trim()
    .replace(/^\.?\//, '');
  if (!path) return null;
  if (path.split('/').some(segment => segment === '..' || segment === '.')) return null;
  return path;
}

/**
 * Path → document, or a reason it is not one.
 *
 * Deliberately exact on segment counts. `pages/lab-1/assets/diagram.png` starts
 * with `pages/` and ends in a file, and a prefix test would happily embed every
 * uploaded image; `pages/<slug>/content.json` is three segments and nothing
 * else is.
 */
export function classifyPath(rawPath: string): PathClassification {
  const path = normalizePath(rawPath);
  if (!path) return { indexable: false, reason: 'bad_path' };

  if (path.startsWith(FILE_PREFIX)) {
    const rest = path.slice(FILE_PREFIX.length);
    if (!rest || rest.endsWith('/')) return { indexable: false, reason: 'not_indexable' };
    const dot = rest.lastIndexOf('.');
    const extension = dot > 0 ? rest.slice(dot + 1).toLowerCase() : '';
    const extract = FILE_EXTRACT_BY_EXTENSION[extension];
    if (!extract) return { indexable: false, reason: 'not_indexable' };
    return {
      indexable: true,
      target: { kind: 'file', extract, sourcePath: path, docPath: path, legacy: false },
    };
  }

  const segments = path.split('/');
  if (segments.length !== 3) return { indexable: false, reason: 'not_indexable' };
  const [root, slug, file] = segments;
  if (!slug || slug.startsWith('.')) return { indexable: false, reason: 'not_indexable' };
  const docPath = `${root}/${slug}`;
  const base = { sourcePath: path, docPath };

  if (root === 'pages') {
    if (file === 'content.json') {
      return {
        indexable: true,
        target: { ...base, kind: 'page', extract: 'blocknote', legacy: false },
      };
    }
    if (file === 'index.html') {
      return {
        indexable: true,
        target: { ...base, kind: 'page', extract: 'page-html', legacy: true },
      };
    }
    return { indexable: false, reason: 'not_indexable' };
  }

  if (root === 'slides') {
    if (file === 'index.html') {
      return {
        indexable: true,
        target: { ...base, kind: 'slide', extract: 'deck-html', legacy: false },
      };
    }
    // deck.json is the SOURCE; index.html is generated from it on every save and
    // is what a reader sees. Indexing both would double every deck.
    return { indexable: false, reason: 'not_indexable' };
  }

  return { indexable: false, reason: 'not_indexable' };
}

/** A `'file'` document has no DB row to carry a title, so its name is one. */
function titleForFile(path: string): string {
  const base = path.split('/').pop() ?? path;
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

/**
 * Split `text` into pieces no longer than `budget` characters.
 *
 * Paragraphs first, because a paragraph is the smallest unit that still reads
 * as an idea and a vector of half a sentence retrieves nothing. Sentences when
 * one paragraph is itself too long. A hard cut only when a single "sentence"
 * overruns the budget — a minified script, a base64 blob, a wall of CJK with no
 * terminators — and it exists so this function CANNOT return an over-budget
 * piece, which is what lets `indexOneFile` treat an `over_cap` refusal as a bug
 * rather than a retry.
 */
export function splitIntoPieces(text: string, budget: number): string[] {
  if (budget <= 0) return [];
  if (text.length <= budget) return text.length ? [text] : [];

  const pieces: string[] = [];
  let current = '';

  const flush = () => {
    if (current.trim()) pieces.push(current);
    current = '';
  };

  const push = (unit: string, separator: string) => {
    if (!unit) return;
    const joined = current ? current + separator + unit : unit;
    if (joined.length <= budget) {
      current = joined;
      return;
    }
    flush();
    if (unit.length <= budget) {
      current = unit;
      return;
    }
    // Too big even on its own: hard-cut what is left of it.
    for (let at = 0; at < unit.length; at += budget) {
      const slice = unit.slice(at, at + budget);
      if (slice.length === budget) pieces.push(slice);
      else current = slice;
    }
  };

  for (const paragraph of text.split(/\n{2,}/)) {
    if (!paragraph.trim()) continue;
    if (paragraph.length <= budget) {
      push(paragraph, '\n\n');
      continue;
    }
    // Sentence boundaries, keeping the terminator with the sentence it ends.
    for (const sentence of paragraph.split(/(?<=[.!?])\s+/)) {
      if (sentence.trim()) push(sentence, ' ');
    }
  }

  flush();
  return pieces;
}

/**
 * The document's text as it will be embedded, one string per row.
 *
 * The title leads chunk 0 already (the extractor prepends it), and it is
 * prepended again to every later chunk: a chunk that says "office hours move to
 * Thursday" with no idea which course page it came from is a worse answer than
 * one that does, and the cost is a line of text per row.
 */
export function chunkDocument(docText: string, title: string): string[] {
  const capTokens = maxInputTokens();
  if (!docText.trim()) return [];
  if (estimateTokens(docText) <= capTokens) return [docText];

  const prefix = title ? `${title}\n` : '';
  const budget = maxInputChars() - prefix.length;
  if (budget <= 0) return [];

  const pieces = splitIntoPieces(docText, budget);
  return pieces.map((piece, index) => (index === 0 ? piece : prefix + piece));
}

interface ResolvedDoc {
  kind: ContentDocKind;
  id: string;
  title: string;
}

async function resolveDoc(
  classroomId: string,
  target: PathTarget,
  hint: DocHint | undefined
): Promise<ResolvedDoc | null> {
  if (target.kind === 'file') {
    return { kind: 'file', id: target.docPath, title: hint?.title ?? titleForFile(target.docPath) };
  }

  // The caller's own row wins. A path lookup is a findFirst (content_path has
  // no unique constraint) and can pick the wrong one of two rows sharing a path.
  if (hint && hint.kind === target.kind && hint.id) {
    if (hint.title) return { kind: hint.kind, id: hint.id, title: hint.title };
    const row =
      target.kind === 'page'
        ? await getPrisma().page.findUnique({ where: { id: hint.id }, select: { title: true } })
        : await getPrisma().slide.findUnique({ where: { id: hint.id }, select: { title: true } });
    if (!row) return null;
    return { kind: hint.kind, id: hint.id, title: row.title };
  }

  const where = { classroom_id: classroomId, content_path: target.docPath };
  const row =
    target.kind === 'page'
      ? await getPrisma().page.findFirst({ where, select: { id: true, title: true } })
      : await getPrisma().slide.findFirst({ where, select: { id: true, title: true } });
  if (!row) return null;
  return { kind: target.kind, id: row.id, title: row.title };
}

interface StoredChunk {
  chunk_ix: number;
  chunk_count: number;
  source_sha: string;
  extract_version: number;
  embed_model: string;
  embedding_null: boolean;
}

async function storedChunks(
  classroomId: string,
  kind: ContentDocKind,
  docId: string
): Promise<StoredChunk[]> {
  return getPrisma().$queryRaw<StoredChunk[]>`
    SELECT chunk_ix, chunk_count, source_sha, extract_version, embed_model,
           (embedding IS NULL) AS embedding_null
    FROM content_index
    WHERE classroom_id = ${classroomId} AND doc_kind = ${kind} AND doc_id = ${docId}
    ORDER BY chunk_ix
  `;
}

/**
 * Is what is stored already this document, completely?
 *
 * All four have to hold: the stamps match, every chunk 0..n-1 is present, every
 * one of them has a vector, and they agree on how many there are. A partial
 * index — the write that died between chunk 3 and chunk 4 — reads as stale, not
 * as fresh, which is what makes the reconcile able to finish it.
 */
export function isFresh(
  rows: StoredChunk[],
  stamp: { sourceSha: string; extractVersion: number; embedModel: string }
): boolean {
  const zero = rows.find(row => row.chunk_ix === 0);
  if (!zero) return false;
  if (
    zero.source_sha !== stamp.sourceSha ||
    zero.extract_version !== stamp.extractVersion ||
    zero.embed_model !== stamp.embedModel
  ) {
    return false;
  }
  const expected = zero.chunk_count;
  if (!Number.isInteger(expected) || expected < 1) return false;

  const seen = new Set<number>();
  for (const row of rows) {
    if (row.embedding_null) return false;
    if (row.chunk_count !== expected) return false;
    if (
      row.source_sha !== stamp.sourceSha ||
      row.extract_version !== stamp.extractVersion ||
      row.embed_model !== stamp.embedModel
    ) {
      return false;
    }
    seen.add(row.chunk_ix);
  }
  for (let ix = 0; ix < expected; ix += 1) if (!seen.has(ix)) return false;
  return true;
}

/**
 * Embed every chunk. One call when they fit in one, successive calls when they
 * do not — `embedTexts` throws rather than truncating a batch over its own
 * 100-item limit, and a document that long is a real (if absurd) possibility.
 */
async function embedChunks(
  chunks: string[]
): Promise<{ ok: true; vectors: number[][] } | { ok: false; reason: string }> {
  const vectors: number[][] = [];
  for (let at = 0; at < chunks.length; at += MAX_BATCH_SIZE) {
    const result = await embedTexts(chunks.slice(at, at + MAX_BATCH_SIZE));
    if (!result.ok) {
      // The splitter guarantees every piece is under the cap, so this is a bug
      // here, not a document problem. Retrying would reach the same answer.
      return { ok: false, reason: 'over_cap' };
    }
    vectors.push(...result.vectors);
  }
  return { ok: true, vectors };
}

export interface IndexOneFileArgs {
  classroomId: string;
  /** Repo-relative path of the file the bytes came from. */
  path: string;
  /** The git blob sha of those bytes. */
  sha: string;
  /** The bytes, as text. */
  body: string;
  docHint?: DocHint;
}

/**
 * Index one just-committed file.
 *
 * NEVER REJECTS and never throws: every caller is a save path holding it with
 * `void`, and an unhandled rejection there would take the process down over a
 * cache. Everything it decides comes back in the return value instead, because
 * a reconcile that can only read a debug log cannot report readiness.
 */
export async function indexOneFile(args: IndexOneFileArgs): Promise<IndexResult> {
  const { classroomId, sha, body, docHint } = args;

  try {
    // Before any DB work: unset is the state most of the fleet runs in, and it
    // is a safe one. Nothing is written, nothing is deleted, nothing is logged
    // at a level anyone is paged for.
    if (!isWorkersAiConfigured()) return { outcome: 'skipped', reason: 'not_configured' };

    const classified = classifyPath(args.path);
    if (!classified.indexable) return { outcome: 'skipped', reason: classified.reason };
    const { target } = classified;
    const path = target.sourcePath;

    if (!classroomId || !sha || typeof body !== 'string') {
      return { outcome: 'skipped', reason: 'incomplete_args' };
    }

    // A page that has BOTH shapes is a `content.json` page with a legacy
    // `index.html` still sitting beside it; the reader prefers the json and so
    // does the index. Indexing both would put the same page in the corpus twice
    // under one doc_id, with whichever wrote last deciding what it says.
    if (target.legacy) {
      const canonical = await getPrisma().contentAsset.findUnique({
        where: {
          classroom_id_path: { classroom_id: classroomId, path: `${target.docPath}/content.json` },
        },
        select: { sha: true },
      });
      if (canonical) return { outcome: 'skipped', reason: 'legacy_superseded' };
    }

    const doc = await resolveDoc(classroomId, target, docHint);
    if (!doc) return { outcome: 'skipped', reason: 'no_record' };

    const stamp = {
      sourceSha: sha,
      extractVersion: EXTRACT_VERSION,
      embedModel: EMBEDDING_MODEL,
    };
    if (isFresh(await storedChunks(classroomId, doc.kind, doc.id), stamp)) {
      return { outcome: 'skipped', reason: 'fresh' };
    }

    let docText: string;
    if (target.extract === 'plain-text') {
      // No parser: the file IS the text. The title still leads, for the same
      // reason it does everywhere else.
      const trimmed = body.trim();
      docText = [doc.title, trimmed].filter(Boolean).join('\n');
    } else {
      // Dynamic: cheerio must not load at startup. See the file docblock.
      const { extractText } = await import('../content/extract/index.ts');
      const extracted =
        target.extract === 'blocknote'
          ? extractText({ kind: 'blocknote', json: body }, { title: doc.title })
          : extractText({ kind: target.extract, html: body }, { title: doc.title });
      if (!extracted.ok) {
        // The LAST GOOD ROW STAYS. An unreadable save is a reason to keep
        // answering out of the previous version, not to blank the document out
        // of the corpus and answer nothing.
        console.warn(
          `[contentIndex] Extraction failed for ${path} (classroom ${classroomId}): ${extracted.error ?? 'unknown'}`
        );
        return { outcome: 'failed', reason: 'extract' };
      }
      docText = extracted.text;
    }

    // An empty string that means "this parsed to nothing" must not be written as
    // a success: it embeds to a vector that ranks against real questions and
    // answers with nothing. Same rule as `ok: false` — leave what is there.
    if (!docText.trim()) return { outcome: 'skipped', reason: 'empty' };

    const chunks = chunkDocument(docText, doc.title);
    if (chunks.length === 0) return { outcome: 'skipped', reason: 'empty' };

    const embedded = await embedChunks(chunks);
    if (!embedded.ok) {
      console.warn(
        `[contentIndex] Embedding refused ${path} (classroom ${classroomId}): ${embedded.reason}`
      );
      return { outcome: 'failed', reason: embedded.reason };
    }

    const chunkCount = chunks.length;
    const written = await getPrisma().$transaction(async tx => {
      // Out-of-order guard. Embedding took seconds; a second save may have
      // landed inside them. The asset map holds the sha the newest commit
      // produced, so a mismatch here means these bytes are already history —
      // writing them would stamp an OLD document with a NEW sha's name and make
      // it look fresh to every future reconcile.
      const current = await tx.contentAsset.findUnique({
        where: { classroom_id_path: { classroom_id: classroomId, path } },
        select: { sha: true },
      });
      if (current && current.sha !== sha) return false;

      for (const [index, text] of chunks.entries()) {
        const vector = toVectorLiteral(embedded.vectors[index]);
        // Raw, because `embedding` is `Unsupported` and invisible to Prisma
        // Client — and `updated_at` is set by hand for the same reason the
        // raw path needs it: `@updatedAt` is a Prisma Client feature and a raw
        // upsert goes straight past it.
        await tx.$executeRaw`
          INSERT INTO content_index
            (classroom_id, doc_kind, doc_id, chunk_ix, chunk_count, source_path,
             source_sha, extract_version, embed_model, title, text, embedding,
             indexed_at, updated_at)
          VALUES
            (${classroomId}, ${doc.kind}, ${doc.id}, ${index}::int, ${chunkCount}::int, ${path},
             ${sha}, ${EXTRACT_VERSION}::int, ${EMBEDDING_MODEL}, ${doc.title}, ${text},
             ${vector}::vector, NOW(), NOW())
          ON CONFLICT (classroom_id, doc_kind, doc_id, chunk_ix) DO UPDATE SET
            chunk_count     = EXCLUDED.chunk_count,
            source_path     = EXCLUDED.source_path,
            source_sha      = EXCLUDED.source_sha,
            extract_version = EXCLUDED.extract_version,
            embed_model     = EXCLUDED.embed_model,
            title           = EXCLUDED.title,
            text            = EXCLUDED.text,
            embedding       = EXCLUDED.embedding,
            indexed_at      = NOW(),
            updated_at      = NOW()
        `;
      }

      // A document that SHRANK leaves its old tail behind — chunk 7 of the
      // previous version is still a perfectly good row with a perfectly good
      // vector, and it keeps answering out of text this document no longer has.
      await tx.$executeRaw`
        DELETE FROM content_index
        WHERE classroom_id = ${classroomId}
          AND doc_kind = ${doc.kind}
          AND doc_id = ${doc.id}
          AND chunk_ix >= ${chunkCount}::int
      `;
      return true;
    });

    if (!written) return { outcome: 'skipped', reason: 'superseded' };
    return { outcome: 'indexed', chunks: chunkCount };
  } catch (error: unknown) {
    // Warn, not debug: unlike a cold cache, an index that stops being written
    // is a search that quietly stops finding new content, and the reconcile's
    // report is the only other place it would show. Never the body — a page is
    // course content and this line goes to a shared log.
    console.warn(
      `[contentIndex] Could not index ${args.path} (classroom ${classroomId}):`,
      error instanceof Error ? error.message : String(error)
    );
    return { outcome: 'failed', reason: 'error' };
  }
}

// ─── Reconcile ───────────────────────────────────────────────────────────────

/** One document the reconcile has decided needs indexing. */
export interface IndexWorkItem {
  classroomId: string;
  /** The CANONICAL source for this document — `content.json` over `index.html`. */
  path: string;
  /** The sha the asset map says that path holds. */
  sha: string;
  docHint: DocHint;
}

/** An index row with no live document behind it any more. */
export interface IndexOrphan {
  kind: ContentDocKind;
  id: string;
}

/**
 * Separator for the `(doc_kind, doc_id)` composite map key below.
 *
 * NUL rather than a space or a colon: `doc_id` is a uuid for a page or a deck
 * but a REPO PATH for a `file`, and a separator a path could contain would
 * split one key into the wrong two halves — silently, inside the orphan sweep,
 * whose job is deleting rows.
 */
const DOC_KEY_SEP = '\u0000';

const docKey = (kind: string, id: string): string => `${kind}${DOC_KEY_SEP}${id}`;

export interface ClassroomIndexPlan {
  items: IndexWorkItem[];
  orphans: IndexOrphan[];
  /** Documents with no blob in the asset map at all — nothing to fetch. */
  missingAssets: number;
}

/**
 * What this classroom's index is missing, from the RECORDS rather than from the
 * asset map.
 *
 * The map is a cache of the repo tree and can be empty, stale, or missing rows
 * for a classroom nobody has rendered; starting from it would make "this
 * classroom has no map yet" and "this classroom has nothing to index" the same
 * answer. Pages and slides are the source of truth for what documents exist —
 * the map only says which bytes they are made of.
 */
export async function planClassroomIndex(classroomId: string): Promise<ClassroomIndexPlan> {
  const prisma = getPrisma();

  const [pages, slides, assets, stored] = await Promise.all([
    prisma.page.findMany({
      where: { classroom_id: classroomId },
      select: { id: true, title: true, content_path: true },
    }),
    prisma.slide.findMany({
      where: { classroom_id: classroomId },
      select: { id: true, title: true, content_path: true },
    }),
    prisma.contentAsset.findMany({
      where: { classroom_id: classroomId, type: 'blob' },
      select: { path: true, sha: true },
    }),
    getPrisma().$queryRaw<Array<StoredChunk & { doc_kind: string; doc_id: string }>>`
      SELECT doc_kind, doc_id, chunk_ix, chunk_count, source_sha, extract_version, embed_model,
             (embedding IS NULL) AS embedding_null
      FROM content_index
      WHERE classroom_id = ${classroomId}
    `,
  ]);

  const shaByPath = new Map(assets.map(asset => [asset.path, asset.sha]));
  const byDoc = new Map<string, StoredChunk[]>();
  for (const row of stored) {
    const key = docKey(row.doc_kind, row.doc_id);
    const list = byDoc.get(key) ?? [];
    list.push(row);
    byDoc.set(key, list);
  }

  const items: IndexWorkItem[] = [];
  const live = new Set<string>();
  let missingAssets = 0;

  const consider = (kind: ContentDocKind, id: string, title: string, path: string | null) => {
    live.add(docKey(kind, id));
    const sha = path === null ? undefined : shaByPath.get(path);
    if (path === null || sha === undefined) {
      // The document exists but the map holds no blob for it — an unsynced
      // classroom, or a folder that was never committed. Nothing to fetch and
      // nothing to compare against; the next run tries again.
      missingAssets += 1;
      return;
    }
    const rows = byDoc.get(docKey(kind, id)) ?? [];
    const stamp = {
      sourceSha: sha,
      extractVersion: EXTRACT_VERSION,
      embedModel: EMBEDDING_MODEL,
    };
    if (isFresh(rows, stamp)) return;
    items.push({ classroomId, path, sha, docHint: { kind, id, title } });
  };

  for (const page of pages) {
    // Canonical source, decided here and once: `content.json` when the repo has
    // one, the legacy `index.html` only when it does not. Comparing the index
    // row against whichever path happened to be in the map first would make a
    // json-first page look permanently stale against its own dead html.
    const json = `${page.content_path}/content.json`;
    const html = `${page.content_path}/index.html`;
    const canonical = shaByPath.has(json) ? json : shaByPath.has(html) ? html : null;
    consider('page', page.id, page.title, canonical);
  }

  for (const slide of slides) {
    const html = `${slide.content_path}/index.html`;
    consider('slide', slide.id, slide.title, shaByPath.has(html) ? html : null);
  }

  // `bot-context/` has no DB rows at all — the map IS its record.
  for (const asset of assets) {
    if (!asset.path.startsWith(FILE_PREFIX)) continue;
    const classified = classifyPath(asset.path);
    if (!classified.indexable) continue;
    consider('file', asset.path, titleForFile(asset.path), asset.path);
  }

  const orphans: IndexOrphan[] = [];
  for (const key of byDoc.keys()) {
    if (live.has(key)) continue;
    const [kind, id] = key.split(DOC_KEY_SEP);
    orphans.push({ kind: kind as ContentDocKind, id });
  }

  return { items, orphans, missingAssets };
}

/**
 * Drop index rows for documents that no longer exist.
 *
 * A deleted page cascades its `content_index` rows away with it, so the common
 * case needs nothing. What does not cascade is a `'file'` whose path left the
 * repo, and a row written for a record that was deleted while an index was in
 * flight — both keep answering questions out of content nobody can open.
 */
export async function deleteOrphans(classroomId: string, orphans: IndexOrphan[]): Promise<number> {
  if (orphans.length === 0) return 0;
  const predicates = orphans.map(
    orphan => Prisma.sql`(doc_kind = ${orphan.kind} AND doc_id = ${orphan.id})`
  );
  const deleted = await getPrisma().$executeRaw`
    DELETE FROM content_index
    WHERE classroom_id = ${classroomId}
      AND (${Prisma.join(predicates, ' OR ')})
  `;
  return deleted;
}

/** Bytes for one repo path, with the sha they actually came from. */
export type FetchBody = (
  classroom: ReconcileClassroom,
  path: string
) => Promise<{ text: string; sha: string | null } | null>;

export interface ReconcileClassroom {
  id: string;
  content_key_version: number;
  content_repo: string;
  git_organization: { login: string };
  content_delivery_enabled: boolean;
}

export interface ReconcileReport {
  classrooms: number;
  /** Documents found to need work. */
  eligible: number;
  indexed: number;
  skipped: number;
  failed: number;
  orphansDeleted: number;
  /** Every non-clean outcome, counted by its reason. The readiness signal. */
  byReason: Record<string, number>;
}

export interface ReconcileOptions {
  /** Test seam, and the task's own injection point. Defaults to the delivery layer. */
  fetchBody?: FetchBody;
  /** Documents in flight at once. Each is a network fetch plus an embed call. */
  concurrency?: number;
  /** Only these classrooms. Unset means every classroom with pages or slides. */
  classroomIds?: string[];
  /** How stale an asset map may be before the reconcile refreshes it first. */
  assetMaxAgeMs?: number;
}

const DEFAULT_CONCURRENCY = 4;
/** Six hours: the nightly sweep runs twenty minutes before this one. */
const DEFAULT_ASSET_MAX_AGE_MS = 6 * 60 * 60 * 1000;

/**
 * The default byte source: the delivery layer's own read ladder (Worker →
 * contents API → Pages CDN), which never throws and returns null instead.
 *
 * Imported dynamically so this module stays free of `contentDelivery.service`
 * at load time — the save paths that import THIS file also import that one, and
 * a static edge here would close the cycle.
 */
const deliveryFetchBody: FetchBody = async (classroom, path) => {
  const { fetchContentText } = await import('./contentDelivery.service.ts');
  const got = await fetchContentText({ classroom }, path, { label: 'index-reconcile' });
  return got ? { text: got.text, sha: got.sha } : null;
};

/** Run `work` over `items`, at most `limit` at a time. */
async function mapWithLimit<T>(
  items: T[],
  limit: number,
  work: (item: T) => Promise<void>
): Promise<void> {
  let next = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      await work(items[index]);
    }
  });
  await Promise.all(runners);
}

/**
 * Bring every classroom's index level with its content repo.
 *
 * This is the PRIMARY writer, not a backstop. The save hooks cover a document
 * the moment somebody edits it; everything else — the push webhook, the
 * importers, the migration scripts, the slides.com importer, and every document
 * that simply has not been touched since this shipped — arrives here. Its first
 * run is the backfill.
 *
 * Never throws. One classroom's dead repo, revoked App install or rate limit
 * must not abandon the classrooms after it in the list, so every per-classroom
 * failure is counted and the run continues.
 */
export async function reconcileContentIndex(opts: ReconcileOptions = {}): Promise<ReconcileReport> {
  const prisma = getPrisma();
  const fetchBody = opts.fetchBody ?? deliveryFetchBody;
  const concurrency = opts.concurrency ?? DEFAULT_CONCURRENCY;
  const assetMaxAgeMs = opts.assetMaxAgeMs ?? DEFAULT_ASSET_MAX_AGE_MS;
  const configured = isWorkersAiConfigured();

  const report: ReconcileReport = {
    classrooms: 0,
    eligible: 0,
    indexed: 0,
    skipped: 0,
    failed: 0,
    orphansDeleted: 0,
    byReason: {},
  };
  const count = (reason: string) => {
    report.byReason[reason] = (report.byReason[reason] ?? 0) + 1;
  };

  let classroomIds = opts.classroomIds;
  if (!classroomIds) {
    // Every classroom that HAS documents, which is not the same set as the one
    // with an asset map: a classroom nobody has rendered has pages and no map,
    // and it is exactly the one the index is missing entirely.
    const [pageOwners, slideOwners] = await Promise.all([
      prisma.page.groupBy({ by: ['classroom_id'] }),
      prisma.slide.groupBy({ by: ['classroom_id'] }),
    ]);
    classroomIds = [
      ...new Set([
        ...pageOwners.map(row => row.classroom_id),
        ...slideOwners.map(row => row.classroom_id),
      ]),
    ];
  }

  const classrooms = await prisma.classroom.findMany({
    where: { id: { in: classroomIds } },
    select: {
      id: true,
      content_key_version: true,
      content_repo: true,
      content_delivery_enabled: true,
      git_organization: { select: { login: true } },
    },
  });

  for (const row of classrooms) {
    report.classrooms += 1;
    if (!row.content_repo || !row.git_organization?.login) {
      count('no_content_repo');
      continue;
    }
    const classroom: ReconcileClassroom = {
      id: row.id,
      content_key_version: row.content_key_version,
      content_repo: row.content_repo,
      content_delivery_enabled: row.content_delivery_enabled === true,
      git_organization: { login: row.git_organization.login },
    };

    try {
      // The map is what says which bytes each document is made of, and the
      // nightly asset sweep only touches classrooms that ALREADY have rows. A
      // classroom with none would otherwise be un-indexable forever, waiting on
      // a cron that has decided it is not its business — so the refresh happens
      // here, on demand, rather than depending on another job's timing.
      const { ensureContentAssets } = await import('./contentAssets.service.ts');
      await ensureContentAssets(row.id, { maxAgeMs: assetMaxAgeMs });

      const plan = await planClassroomIndex(row.id);
      report.eligible += plan.items.length;
      for (let missing = 0; missing < plan.missingAssets; missing += 1) {
        report.skipped += 1;
        count('no_asset');
      }

      report.orphansDeleted += await deleteOrphans(row.id, plan.orphans);

      if (!configured) {
        report.skipped += plan.items.length;
        for (const _item of plan.items) count('not_configured');
        continue;
      }

      await mapWithLimit(plan.items, concurrency, async item => {
        const body = await fetchBody(classroom, item.path);
        if (!body) {
          report.failed += 1;
          count('fetch');
          return;
        }
        // A body whose sha is null came off the Pages CDN, which serves a path
        // and names no object; one whose sha differs came from a read that
        // raced the map. Either way these bytes are NOT the sha we would stamp
        // them with, and stamping them anyway makes a wrong document look fresh
        // to every future run. Leave it for the next reconcile.
        if (body.sha === null || body.sha !== item.sha) {
          report.failed += 1;
          count('sha_mismatch');
          return;
        }

        const result = await indexOneFile({
          classroomId: item.classroomId,
          path: item.path,
          sha: item.sha,
          body: body.text,
          docHint: item.docHint,
        });
        if (result.outcome === 'indexed') report.indexed += 1;
        else if (result.outcome === 'skipped') report.skipped += 1;
        else report.failed += 1;
        if (result.reason) count(result.reason);
      });
    } catch (error: unknown) {
      report.failed += 1;
      count('classroom_error');
      console.warn(
        `[contentIndex] Reconcile failed for classroom ${row.id}:`,
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  return report;
}
