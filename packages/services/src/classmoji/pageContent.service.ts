import { createHash } from 'node:crypto';
import { signBlobUrl } from '@classmoji/content-signing';
import { z } from 'zod';
import { ContentService } from '../content/ContentService.ts';
import { recordContentAsset } from './contentAssets.service.ts';
import {
  dedupeMergedTreeIds,
  indexResolutions,
  mergeIdSequence3,
  PreviewResolutionError,
  type MergeChoice,
  type MergeResolution,
} from '../content/merge3.ts';

export { PreviewResolutionError } from '../content/merge3.ts';
export type { MergeChoice, MergeResolution } from '../content/merge3.ts';

/**
 * Page Content Service
 *
 * Owns page content stored in the per-classroom content repo:
 * `pages/<slug>/content.json` (BlockNote JSON, wrapper format
 * `{ blocks, coverImage? }`) with `index.html` as the legacy fallback.
 *
 * Extracted from apps/pages' content.server.ts (Phase 1 of the content-tools
 * plan) so apps/pages routes and the MCP content tools share one read/write
 * path. Deliberately framework-free: no React, no editor schema — the
 * HTML→BlockNote migration (which needs the editor schema) stays app-local
 * in apps/pages.
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export interface PageCoverImage {
  url: string;
  position: number;
}

/** Minimal page shape needed to locate its content repo. */
export interface PageWithContentRepo {
  title: string;
  content_path: string;
  classroom: {
    /** Stored content repo name — never re-derived from org + namespace. */
    content_repo: string;
    git_organization?: {
      provider: string;
      login: string;
      [key: string]: unknown;
    } | null;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface PageContentResult {
  format: 'json' | 'html' | 'none';
  /** BlockNote blocks array for 'json'; raw HTML string for 'html'; null for 'none'. */
  blocks: unknown;
  coverImage: PageCoverImage | null;
  /** Git blob sha of the file the content came from (null when format is 'none'). */
  sha: string | null;
}

/** A BlockNote-shaped block node (loosely typed — the service treats content as opaque). */
interface BlockNode {
  id?: string;
  children?: BlockNode[];
  [key: string]: unknown;
}

// ─── Repo resolution ─────────────────────────────────────────────────────────

function contentRepoFor(page: PageWithContentRepo) {
  const gitOrganization = page.classroom.git_organization;
  if (!gitOrganization?.login) {
    throw new Error('Git organization not configured');
  }
  if (!page.classroom.content_repo) {
    throw new Error('Classroom content repo not configured');
  }
  return { gitOrganization, repo: page.classroom.content_repo };
}

// ─── Load / save ─────────────────────────────────────────────────────────────

/**
 * Load page content from the content repo.
 * Tries `content.json` first (BlockNote — `{ blocks, coverImage? }` wrapper or
 * legacy bare blocks array), falls back to `index.html` (legacy HTML).
 *
 * @param page - Page with classroom.git_organization
 * @param options.skipCache - Bypass the 60s ContentService cache (sha-bearing
 *   reads that will be used as expectedSha MUST pass true).
 * @param options.ref - Git ref (branch/sha) to read from — e.g. the page's
 *   preview branch. Ref-bearing reads always bypass the cache.
 */
export async function loadPageContent(
  page: PageWithContentRepo,
  { skipCache = false, ref }: { skipCache?: boolean; ref?: string } = {}
): Promise<PageContentResult> {
  const { gitOrganization, repo } = contentRepoFor(page);

  // Try JSON first (BlockNote format)
  try {
    const jsonResult = await ContentService.getContent({
      gitOrganization,
      repo,
      path: `${page.content_path}/content.json`,
      ...(ref ? { ref } : {}),
      skipCache,
    });

    if (jsonResult?.content) {
      const parsed = JSON.parse(jsonResult.content);

      // New format: { blocks, coverImage? } wrapper
      if (parsed && !Array.isArray(parsed) && Array.isArray(parsed.blocks)) {
        return {
          format: 'json',
          blocks: parsed.blocks,
          coverImage: parsed.coverImage || null,
          sha: jsonResult.sha,
        };
      }

      // Old format: bare blocks array
      return {
        format: 'json',
        blocks: parsed,
        coverImage: null,
        sha: jsonResult.sha,
      };
    }
  } catch (err) {
    console.error(
      `[pageContent.loadPageContent] JSON fetch failed for ${repo}/${page.content_path}/content.json:`,
      err
    );
  }

  // Fallback: HTML (legacy format)
  try {
    const htmlResult = await ContentService.getContent({
      gitOrganization,
      repo,
      path: `${page.content_path}/index.html`,
      ...(ref ? { ref } : {}),
      skipCache,
    });

    if (htmlResult?.content) {
      return {
        format: 'html',
        blocks: htmlResult.content,
        coverImage: null,
        sha: htmlResult.sha,
      };
    }
  } catch (err) {
    console.error(
      `[pageContent.loadPageContent] HTML fetch failed for ${repo}/${page.content_path}/index.html:`,
      err
    );
  }

  return { format: 'none', blocks: null, coverImage: null, sha: null };
}

/**
 * Save BlockNote JSON content to `content.json` (wrapper format
 * `{ blocks, coverImage? }`). Does NOT touch the legacy `index.html`.
 *
 * @param page - Page with classroom.git_organization
 * @param blocks - BlockNote document blocks array
 * @param options.coverImage - Cover image metadata; `undefined` (omitted)
 *   preserves the existing coverImage via a fresh re-read, `null` removes it.
 * @param options.expectedSha - Optimistic-lock sha; mismatch → error with
 *   status 409 (propagated from ContentService.put).
 * @param options.message - Commit message (default `Update page: <title>`).
 * @param options.branch - Branch to commit to (default: repo default branch).
 * @returns The new file sha and commit sha.
 */
export async function savePageContent(
  page: PageWithContentRepo,
  blocks: unknown,
  {
    coverImage,
    expectedSha,
    message,
    branch,
  }: {
    coverImage?: PageCoverImage | null;
    expectedSha?: string;
    message?: string;
    branch?: string;
  } = {}
): Promise<{ sha: string; commit: string }> {
  const { gitOrganization, repo } = contentRepoFor(page);
  const path = `${page.content_path}/content.json`;

  // When coverImage isn't explicitly provided, read the existing JSON to
  // preserve it (fresh read — a stale cached coverImage must not resurrect).
  if (coverImage === undefined) {
    try {
      const existing = await ContentService.getContent({
        gitOrganization,
        repo,
        path,
        ...(branch ? { ref: branch } : {}),
        skipCache: true,
      });
      if (existing?.content) {
        const parsed = JSON.parse(existing.content);
        if (parsed && !Array.isArray(parsed) && parsed.coverImage) {
          coverImage = parsed.coverImage;
        }
      }
    } catch {
      // No existing file — coverImage stays undefined (won't be in wrapper)
    }
  }

  // The key is only written when a cover actually exists: `null` (remove) and
  // absence both serialize as no key, matching what pre-merge saves produced —
  // a semantic accept must not sprinkle `"coverImage": null` into documents
  // that never had one. Reads treat a missing key and null identically.
  // Last gate before the bytes hit the repo, so a caller that forgets to
  // normalize still cannot commit an unopenable document. Idempotent, so the
  // paths that already normalized pay only a structural walk.
  //
  // Two writers reach content.json WITHOUT coming through here, and neither is
  // covered by this line: acceptPreview's clean git merge (handled explicitly,
  // see repairMergedContent) and contentImport's byte-for-byte page copy, which
  // never parses the blocks — a broken page in a source classroom still
  // propagates to every classroom that imports it.
  const wrapper: { blocks: unknown; coverImage?: PageCoverImage } = {
    blocks: Array.isArray(blocks) ? normalizeBlockStructure(blocks) : blocks,
  };
  if (coverImage != null) {
    wrapper.coverImage = coverImage;
  }

  return ContentService.put({
    gitOrganization,
    repo,
    path,
    content: JSON.stringify(wrapper, null, 2),
    message: message ?? `Update page: ${page.title}`,
    ...(expectedSha ? { expectedSha } : {}),
    ...(branch ? { branch } : {}),
  });
}

/**
 * Upload a binary asset to the page's `assets/` folder.
 * Takes a Buffer — callers converting from a Web API File do the
 * File→Buffer adaptation app-side.
 *
 * ## Why `url` is a repo path — but only when something can read one
 *
 * What goes INTO the document should be the reference — `pages/lab-1/assets/
 * x.png` — because that is the only form that keeps following the file: it
 * survives a re-upload, a cache bust, and a viewer in a different tier.
 * `displayUrl` is the signed URL for showing the image right now, deliberately
 * a separate field so a caller cannot store one by accident.
 *
 * That only holds while the delivery layer is CONFIGURED, because it is the
 * only thing that knows how to turn a bare path back into something a browser
 * can fetch. Unconfigured, there is no read-side translation anywhere — editor,
 * viewer, or class site — so storing a path would make every upload a 404 the
 * moment it is saved. So when nothing can be signed, `url` stays the legacy
 * absolute URL, exactly as it was before this existed. Switching the layer on
 * changes what NEW uploads store; the old absolute URLs keep resolving through
 * case 2 of the resolver.
 *
 * `displayUrl` is signed DIRECTLY from the sha the upload just returned rather
 * than looked up in the asset map, because the push webhook that would put a
 * row there has not fired yet — a map lookup here would reliably miss.
 *
 * Which is also why the row is written HERE. `displayUrl` only covers the
 * editor's own preview; the moment the page is saved and re-rendered, the
 * stored path goes through the map like any other, and a miss there renders as
 * a dangling URL. The upload already has the path, the sha and the size, so the
 * row is recorded from them rather than left to a webhook round trip.
 *
 * @returns `{ url, path, displayUrl }`. `path` is always the repo path.
 *   `displayUrl` is null when the delivery layer is off, and `url` is then the
 *   legacy absolute URL rather than the path.
 */
export async function uploadPageAsset(
  page: PageWithContentRepo,
  buffer: Buffer,
  filename: string
): Promise<{ url: string; path: string; displayUrl: string | null }> {
  const { gitOrganization, repo } = contentRepoFor(page);

  const result = await ContentService.upload({
    gitOrganization,
    repo,
    folder: `${page.content_path}/assets`,
    file: buffer,
    filename,
    branch: 'main',
    message: `Upload asset for ${page.title || 'page'}`,
  });

  const classroomId = (page.classroom as { id?: unknown }).id;
  if (typeof classroomId === 'string') {
    // Never throws, and its failure is not this caller's problem: the file is
    // already in the repo, and the next sync writes the same row.
    await recordContentAsset(classroomId, {
      path: result.path,
      sha: result.sha,
      size: buffer.length,
    });
  }

  const displayUrl = await signUploadedAsset(page, result.path, result.sha);

  // No signature means no reader can resolve a bare path — store the legacy URL.
  return { url: displayUrl ? result.path : result.url, path: result.path, displayUrl };
}

/**
 * Sign a just-uploaded blob at the draft tier, or null if that is not possible.
 *
 * Draft because only a writer ever sees this URL, and a writer is by definition
 * looking at unpublished content. Every failure path returns null: an upload
 * that succeeded must not be reported as failed because a URL could not be
 * minted for it.
 */
async function signUploadedAsset(
  page: PageWithContentRepo,
  path: string,
  sha: string
): Promise<string | null> {
  const origin = process.env.CONTENT_DELIVERY_ORIGIN;
  const master = process.env.CONTENT_SIGNING_SECRET;
  if (!origin || !master) return null;

  const classroom = page.classroom as { id?: unknown; content_key_version?: unknown };
  if (typeof classroom.id !== 'string') return null;

  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return null;

  try {
    return await signBlobUrl(
      origin,
      {
        master,
        classroomId: classroom.id,
        keyVersion:
          typeof classroom.content_key_version === 'number' ? classroom.content_key_version : 0,
        tier: 'draft',
      },
      { sha, ext: name.slice(dot + 1).toLowerCase() }
    );
  } catch (error) {
    console.warn(
      `[pageContent.uploadPageAsset] Could not sign ${path}:`,
      error instanceof Error ? error.message : error
    );
    return null;
  }
}

// ─── Blank page content ──────────────────────────────────────────────────────

/** The standard BlockNote block props every default block carries. */
const STANDARD_BLOCK_PROPS = {
  textColor: 'default',
  backgroundColor: 'default',
  textAlignment: 'left',
} as const;

/** Blocks for a fresh blank page: one empty paragraph with a stable id. */
export function blankPageBlocks(): BlockNode[] {
  return [
    {
      id: 'p1',
      type: 'paragraph',
      props: { ...STANDARD_BLOCK_PROPS },
      content: [],
      children: [],
    },
  ];
}

/** `content.json` body for a fresh blank page (wrapper format). */
export function blankPageContentJson(): string {
  return JSON.stringify({ blocks: blankPageBlocks() }, null, 2);
}

// ─── Deterministic block ids ─────────────────────────────────────────────────

/**
 * Canonical JSON: deterministic serialization with object keys sorted at
 * every level, so hashing is stable regardless of key insertion order.
 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'undefined';
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  const entries = Object.keys(value as Record<string, unknown>)
    .sort()
    .map(key => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`);
  return `{${entries.join(',')}}`;
}

function fillBlockIds(blocks: BlockNode[], parentPath: string): void {
  blocks.forEach((block, index) => {
    if (!block || typeof block !== 'object') return;
    const path = parentPath ? `${parentPath}.${index}` : String(index);
    if (!block.id) {
      // Hash the block as given (before descendants get ids filled) salted
      // with its positional path — identical sibling blocks at different
      // positions still get distinct ids, and re-running on the same doc
      // yields the same ids every time.
      block.id =
        'b' +
        createHash('sha1')
          .update(canonicalJson(block) + ':' + path)
          .digest('hex')
          .slice(0, 10);
    }
    if (Array.isArray(block.children) && block.children.length > 0) {
      fillBlockIds(block.children, path);
    }
  });
}

/**
 * Fill missing block ids deterministically:
 * `'b' + sha1(canonicalJson(block) + ':' + positionalPath).slice(0, 10)`.
 * Existing ids are preserved; recurses into `children`. Pure — returns a new
 * array, input untouched. Stable: the same document always yields the same
 * ids, so ids derived on read match ids derived on a later read even before
 * they're persisted.
 */
export function ensureBlockIds<T = unknown>(blocks: T[]): T[] {
  const copy = structuredClone(blocks) as unknown as BlockNode[];
  fillBlockIds(copy, '');
  return copy as unknown as T[];
}

// ─── Block operations ────────────────────────────────────────────────────────

/** Typed error for applyBlockOps failures (unknown ids, bad positions, bad ops). */
export class BlockOpError extends Error {
  code: 'UNKNOWN_BLOCK_ID' | 'INVALID_POSITION' | 'INVALID_OP';

  constructor(message: string, code: 'UNKNOWN_BLOCK_ID' | 'INVALID_POSITION' | 'INVALID_OP') {
    super(message);
    this.name = 'BlockOpError';
    this.code = code;
  }
}

export type BlockPosition = { after: string } | { at: 'start' | 'end' };

/**
 * Single source of truth for the page block-op vocabulary (content-tools plan
 * §7 P8) — the pages twin of slides' deckOpSchema. Consumed by:
 *  - the pages editor save action (route.server.ts) via
 *    `pageBlockOpsPayloadSchema` (op cap 400 — an editor session may touch many
 *    blocks between saves), which 400s a malformed payload instead of letting a
 *    raw TypeError escape as a 500, and
 *  - the page_content_apply MCP tool (which keeps its own tighter `.max(25)`
 *    total-op cap as an override).
 * It also types `applyBlockOps`' input. The client diff (blockOpsDiff.ts)
 * mirrors a SUBSET of this vocabulary (it never emits replace_all); it cannot
 * import server code into the browser bundle, so its BlockOp type is a
 * hand-kept structural twin that stays assignable to this one.
 */
const pageBlockBodySchema = z.record(z.unknown());
const pageBlockPositionSchema = z.union([
  z.object({ after: z.string().min(1) }).strict(),
  z.object({ at: z.enum(['start', 'end']) }).strict(),
]);

export const pageBlockOpSchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('update'),
    id: z.string().min(1),
    block: pageBlockBodySchema.describe('Full replacement block (its id is preserved)'),
  }),
  z.object({
    op: z.literal('insert'),
    blocks: z.array(pageBlockBodySchema).min(1).max(400),
    position: pageBlockPositionSchema,
  }),
  z.object({
    op: z.literal('move'),
    id: z.string().min(1),
    position: pageBlockPositionSchema,
  }),
  z.object({
    op: z.literal('delete'),
    id: z.string().min(1),
  }),
  z.object({
    op: z.literal('replace_all'),
    blocks: z.array(pageBlockBodySchema),
  }),
]);

export type BlockOp = z.infer<typeof pageBlockOpSchema>;

/**
 * Payload schema for the editor's ops-shaped save (a JSON array of ops). The
 * MCP tool applies a tighter `.max(25)` in its own inputSchema.
 */
export const pageBlockOpsPayloadSchema = z.array(pageBlockOpSchema).min(1).max(400);

/** Collect every id in the tree (incl. nested children). */
function collectBlockIds(blocks: BlockNode[], out = new Set<string>()): Set<string> {
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;
    if (typeof block.id === 'string' && block.id) out.add(block.id);
    if (Array.isArray(block.children)) collectBlockIds(block.children, out);
  }
  return out;
}

/** A client-supplied block id that collided and was re-minted. */
export interface BlockIdRemint {
  /** Index of the op (within the ops array) whose payload carried the id. */
  op_index: number;
  from: string;
  to: string;
}

/**
 * Deterministically re-mint a colliding id: same derivation family as
 * ensureBlockIds (`'b' + sha1(canonicalJson(block-sans-id) + ':' + seed)`),
 * with a counter suffix in the (vanishingly unlikely) event of a hash clash.
 */
function remintBlockId(block: BlockNode, seed: string, used: Set<string>): string {
  const { id: _id, ...rest } = block;
  for (let n = 0; ; n++) {
    const candidate =
      'b' +
      createHash('sha1')
        .update(canonicalJson(rest) + ':' + seed + (n > 0 ? ':' + n : ''))
        .digest('hex')
        .slice(0, 10);
    if (!used.has(candidate)) return candidate;
  }
}

/**
 * Enforce id uniqueness on client-supplied blocks (mutates in place, callers
 * pass clones): any id already in `used` (existing doc ids, or an earlier
 * block in the same payload) is re-minted deterministically. Ids the payload
 * lacks are left absent — ensureBlockIds fills those downstream.
 */
function sanitizeIncomingIds(
  blocks: BlockNode[],
  used: Set<string>,
  seedPrefix: string,
  onRemint?: (from: string, to: string) => void
): void {
  blocks.forEach((block, index) => {
    if (!block || typeof block !== 'object') return;
    const seed = seedPrefix ? `${seedPrefix}.${index}` : String(index);
    if (typeof block.id === 'string' && block.id) {
      if (used.has(block.id)) {
        const to = remintBlockId(block, seed, used);
        onRemint?.(block.id, to);
        block.id = to;
      }
      used.add(block.id);
    }
    if (Array.isArray(block.children) && block.children.length > 0) {
      sanitizeIncomingIds(block.children, used, seed, onRemint);
    }
  });
}

/** Depth-first search for a block id anywhere in the tree (incl. children). */
function findBlock(blocks: BlockNode[], id: string): { parent: BlockNode[]; index: number } | null {
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    if (block?.id === id) {
      return { parent: blocks, index: i };
    }
    if (Array.isArray(block?.children)) {
      const found = findBlock(block.children, id);
      if (found) return found;
    }
  }
  return null;
}

function mustFindBlock(blocks: BlockNode[], id: string, opName: string) {
  const found = findBlock(blocks, id);
  if (!found) {
    throw new BlockOpError(`Unknown block id '${id}' in ${opName} op`, 'UNKNOWN_BLOCK_ID');
  }
  return found;
}

function insertBlocksAt(
  doc: BlockNode[],
  newBlocks: BlockNode[],
  position: BlockPosition,
  opName: string
): void {
  if ('after' in position) {
    const target = mustFindBlock(doc, position.after, opName);
    target.parent.splice(target.index + 1, 0, ...newBlocks);
  } else if (position?.at === 'start') {
    doc.unshift(...newBlocks);
  } else if (position?.at === 'end') {
    doc.push(...newBlocks);
  } else {
    throw new BlockOpError(
      `Invalid position in ${opName} op — expected { after: <id> } or { at: 'start' | 'end' }`,
      'INVALID_POSITION'
    );
  }
}

// ─── Structural normalization (multi-column invariants) ──────────────────────
//
// `columnList` / `column` (@blocknote/xl-multi-column) are the only blocks in
// the page schema whose ProseMirror content expressions constrain their
// CHILDREN: `columnList` is `"column column+"` (every child a column, minimum
// two) and `column` is `"blockContainer+"` (at least one child). Everything
// else accepts whatever children it is handed, which is why the op vocabulary
// can otherwise stay schema-agnostic.
//
// That gap is not theoretical. A `delete` op naming a column splices it out
// with no idea it was the second-to-last one; an `insert` positioned `after` a
// column lands a paragraph as a columnList's direct child. Either document
// serializes and commits perfectly happily — and then throws "Error creating
// document from blocks passed as `initialContent`" for EVERY reader, because
// ProseMirror refuses to build a doc that violates the schema. The viewer and
// the editor share that failure, so a page broken this way cannot be repaired
// in the editor either; the only way back is a re-commit from outside. That
// asymmetry is why the invariant is enforced on the way IN rather than left to
// render-time tolerance.

const COLUMN_LIST_TYPE = 'columnList';
const COLUMN_TYPE = 'column';

/** A structural repair made on the way into a commit. */
export interface BlockStructureRepair {
  kind:
    | 'column_list_unwrapped'
    | 'column_list_child_wrapped'
    | 'empty_column_filled'
    | 'stray_column_unwrapped';
  /** Id of the offending block, when it had one. */
  id?: string;
}

function emptyParagraph(): BlockNode {
  // Same shape blankPageBlocks persists: a repair writes to the repo, and a
  // props-less paragraph would materialize with populated props on the next
  // editor load, making the following save report a block nobody edited as
  // changed. Ids are minted by normalizeBlockStructure once repairs settle.
  return { type: 'paragraph', props: { ...STANDARD_BLOCK_PROPS }, content: [], children: [] };
}

function repairAt(block: BlockNode, kind: BlockStructureRepair['kind']): BlockStructureRepair {
  return { kind, ...(typeof block.id === 'string' && block.id ? { id: block.id } : {}) };
}

/**
 * Restore the multi-column invariants, in place (callers pass clones).
 *
 * - a `column` with no children gets an empty paragraph, so emptying one slot
 *   of a row keeps the row rather than killing the document
 * - a non-column child of a `columnList` is wrapped in its own column, which
 *   keeps it exactly where it was authored
 * - a `columnList` left with fewer than two columns is unwrapped: its columns'
 *   children take its place, in order. This matches what the editor does when
 *   you delete the second-to-last column — the content returns to full width
 *   instead of growing a blank column nobody asked for
 * - a `column` outside any `columnList` is unwrapped the same way
 *
 * Content is never dropped: every unwrap splices the children up in place.
 */
function repairColumnStructure(
  blocks: BlockNode[],
  insideColumnList: boolean,
  onRepair?: (repair: BlockStructureRepair) => void
): void {
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    if (!block || typeof block !== 'object') continue;

    // Depth first: a child columnList must already be valid (or gone) before
    // this level decides what its own children are.
    if (Array.isArray(block.children)) {
      repairColumnStructure(block.children, block.type === COLUMN_LIST_TYPE, onRepair);
    }

    if (block.type === COLUMN_TYPE) {
      if (!insideColumnList) {
        const lifted = Array.isArray(block.children) ? block.children : [];
        blocks.splice(i, 1, ...lifted);
        onRepair?.(repairAt(block, 'stray_column_unwrapped'));
        i += lifted.length - 1;
      } else if (!Array.isArray(block.children) || block.children.length === 0) {
        block.children = [emptyParagraph()];
        onRepair?.(repairAt(block, 'empty_column_filled'));
      }
      continue;
    }

    if (block.type !== COLUMN_LIST_TYPE) continue;

    const kids = Array.isArray(block.children) ? block.children : [];

    // Strays become columns of their own so the row keeps its authored order.
    const columns = kids.map(kid => {
      if (kid?.type === COLUMN_TYPE) return kid;
      // The stray's id, not the row's: the caller is being told to go look at
      // something, and the row alone doesn't say which block moved.
      onRepair?.(repairAt(kid ?? block, 'column_list_child_wrapped'));
      return { type: COLUMN_TYPE, props: { width: 1 }, children: [kid ?? emptyParagraph()] };
    });

    if (columns.length >= 2) {
      block.children = columns;
      continue;
    }

    // One column (or none) left — unwrap, keeping the content in place.
    const lifted = columns.flatMap(column =>
      Array.isArray(column.children) ? column.children : []
    );
    blocks.splice(i, 1, ...lifted);
    onRepair?.(repairAt(block, 'column_list_unwrapped'));
    i += lifted.length - 1;
  }
}

/**
 * Return a document that BlockNote can actually open: same blocks, with the
 * multi-column invariants restored (see `repairColumnStructure`). Pure and
 * idempotent — a document that is already valid is returned structurally
 * unchanged, so it is safe to call on every path that produces one.
 */
export function normalizeBlockStructure<T = unknown>(
  blocks: T[],
  { onRepair }: { onRepair?: (repair: BlockStructureRepair) => void } = {}
): T[] {
  const copy = structuredClone(blocks) as unknown as BlockNode[];

  let repaired = false;
  repairColumnStructure(copy, false, repair => {
    repaired = true;
    onRepair?.(repair);
  });

  // A repair invents blocks (the filler paragraph, the wrapping column) and
  // they must not reach the repo id-less: only the MCP path runs ensureBlockIds
  // afterwards, and apps/pages never id-fills on read, so BlockNote would mint
  // a random id client-side and the next ops-shaped save would name a block the
  // stored document doesn't have. Gated on an actual repair to keep the
  // documented promise that a valid document comes back unchanged.
  return (repaired ? ensureBlockIds(copy) : copy) as unknown as T[];
}

/**
 * Apply a sequence of block operations to a document. Pure — returns a new
 * blocks array, input untouched. Ops are applied sequentially, so later ops
 * see earlier ops' effects (an op may reference a block inserted by a
 * previous op in the same batch). Ids are matched anywhere in the tree,
 * including nested `children`.
 *
 * Ops:
 * - `update  { id, block }`          — replace the block wholesale; its id is preserved.
 * - `insert  { blocks, position }`   — insert after a block ({ after }) or at the
 *                                      top level ({ at: 'start' | 'end' }).
 * - `move    { id, position }`       — remove then re-insert at position.
 * - `delete  { id }`                 — remove the block (and its children).
 * - `replace_all { blocks }`         — replace the entire document.
 *
 * Client-supplied blocks (insert / replace_all payloads, and an update's
 * children) whose ids collide with existing ids — or with each other — are
 * re-minted deterministically (matching deck_apply's insert behavior); each
 * re-mint is reported through `onIdRemint`.
 *
 * Unknown ids throw a BlockOpError naming the id (code UNKNOWN_BLOCK_ID).
 */
export function applyBlockOps(
  blocks: unknown[],
  ops: BlockOp[],
  {
    onIdRemint,
    onStructureRepair,
  }: {
    onIdRemint?: (remint: BlockIdRemint) => void;
    onStructureRepair?: (repair: BlockStructureRepair) => void;
  } = {}
): unknown[] {
  let doc = structuredClone(blocks) as BlockNode[];

  for (const [opIndex, op] of ops.entries()) {
    const remintReporter = (from: string, to: string) =>
      onIdRemint?.({ op_index: opIndex, from, to });

    switch (op.op) {
      case 'update': {
        const target = mustFindBlock(doc, op.id, 'update');
        const replacement = structuredClone(op.block) as BlockNode;
        replacement.id = op.id; // id preserved regardless of the payload
        if (Array.isArray(replacement.children) && replacement.children.length > 0) {
          // Children ride along wholesale — their ids must not collide with
          // ids elsewhere in the doc (the replaced subtree's own ids are fair
          // game to reuse).
          const used = collectBlockIds(doc);
          for (const oldId of collectBlockIds([target.parent[target.index]])) {
            used.delete(oldId);
          }
          used.add(op.id);
          sanitizeIncomingIds(replacement.children, used, `op${opIndex}`, remintReporter);
        }
        target.parent[target.index] = replacement;
        break;
      }

      case 'insert': {
        const inserted = structuredClone(op.blocks) as BlockNode[];
        sanitizeIncomingIds(inserted, collectBlockIds(doc), `op${opIndex}`, remintReporter);
        insertBlocksAt(doc, inserted, op.position, 'insert');
        break;
      }

      case 'move': {
        if ('after' in op.position && op.position.after === op.id) {
          throw new BlockOpError(
            `Cannot move block '${op.id}' relative to itself`,
            'INVALID_POSITION'
          );
        }
        const source = mustFindBlock(doc, op.id, 'move');
        const [moved] = source.parent.splice(source.index, 1);
        insertBlocksAt(doc, [moved], op.position, 'move');
        break;
      }

      case 'delete': {
        const target = mustFindBlock(doc, op.id, 'delete');
        target.parent.splice(target.index, 1);
        break;
      }

      case 'replace_all': {
        doc = structuredClone(op.blocks) as BlockNode[];
        // A fresh document may still carry internal duplicates.
        sanitizeIncomingIds(doc, new Set<string>(), `op${opIndex}`, remintReporter);
        break;
      }

      default:
        throw new BlockOpError(`Unknown op '${(op as { op?: string }).op}'`, 'INVALID_OP');
    }
  }

  // Ops are structural, not schema-aware: a delete that empties a columnList
  // below two columns applies cleanly and yields a document no reader can
  // open. Repair before the result escapes, so what callers report and what
  // gets committed are the same document.
  return normalizeBlockStructure(doc, {
    ...(onStructureRepair ? { onRepair: onStructureRepair } : {}),
  });
}

// ─── Preview branches (plan §3b) ─────────────────────────────────────────────
//
// One singleton preview branch per page, named `preview/<content_path>`.
// Pages have no generated artifact, so preview branches carry content.json
// only (savePageContent with a branch writes just that file). Accept merges
// the branch into main via the GitHub merge API and deletes it; discard
// deletes it without touching main.

/** The singleton preview branch for a content path (e.g. `preview/pages/syllabus`). */
export function previewBranchName(contentPath: string): string {
  return `preview/${contentPath}`;
}

export interface PreviewStatus {
  exists: boolean;
  /** Commits the preview branch has that main lacks (present iff exists). */
  commits_ahead?: number;
  /** Committer date (ISO) of the oldest preview-only commit — the preview's age. */
  oldest_commit_at?: string;
}

/**
 * Report whether the page's preview branch exists and how far ahead of main
 * it is. A 404 from the compare (branch absent) → `{ exists: false }`.
 */
export async function getPreviewStatus(page: PageWithContentRepo): Promise<PreviewStatus> {
  const { gitOrganization, repo } = contentRepoFor(page);
  const comparison = await ContentService.compareBranches({
    gitOrganization,
    repo,
    base: 'main',
    head: previewBranchName(page.content_path),
  });
  if (!comparison) {
    return { exists: false };
  }
  const oldest = comparison.commits[0]?.date;
  return {
    exists: true,
    commits_ahead: comparison.ahead_by,
    ...(oldest ? { oldest_commit_at: oldest } : {}),
  };
}

/**
 * Ensure the page's preview branch exists, creating it from main's current
 * HEAD when absent. Existing branches are left untouched (stacking — a
 * multi-step agent session accumulates commits on one preview).
 *
 * Main's HEAD sha comes from comparing main against itself (the compare
 * payload's base commit), avoiding a separate refs read.
 */
export async function ensurePreviewBranch(
  page: PageWithContentRepo
): Promise<{ branch: string; created: boolean }> {
  const { gitOrganization, repo } = contentRepoFor(page);
  const branch = previewBranchName(page.content_path);

  const existing = await ContentService.compareBranches({
    gitOrganization,
    repo,
    base: 'main',
    head: branch,
  });
  if (existing) {
    return { branch, created: false };
  }

  const main = await ContentService.compareBranches({
    gitOrganization,
    repo,
    base: 'main',
    head: 'main',
  });
  if (!main) {
    throw new Error(`Cannot resolve main HEAD for ${repo} — repository has no main branch?`);
  }

  try {
    await ContentService.createBranch({ gitOrganization, repo, branch, fromSha: main.base_sha });
  } catch (error: unknown) {
    // Creation race: a concurrent apply created the branch between our probe
    // and this call. GitHub answers 422 "Reference already exists" — treat as
    // exists (the stacking semantics the probe would have chosen).
    const { status, message } = error as { status?: number; message?: string };
    if (status === 422 && message?.includes('already exists')) {
      return { branch, created: false };
    }
    throw error;
  }
  return { branch, created: true };
}

export interface PreviewConflictUnit {
  /** Block id (or the sentinel `__order__` for a top-level ordering conflict). */
  id: string;
  /** Index in the preview's document (falls back to main's, then base's). */
  index: number;
  /** Main's version of the unit (absent = deleted on main). */
  ours?: unknown;
  /** The preview's version of the unit (absent = deleted on the preview). */
  theirs?: unknown;
  /** The merge-base version (absent = the unit was added after the fork). */
  base?: unknown;
}

export type AcceptPreviewResult =
  | {
      merged: true;
      /** content.json's blob sha on main post-merge (read at the merge commit) — the fresh expected_sha for future applies. */
      sha: string | null;
      /** Present when the git merge conflicted but the semantic 3-way auto-merge committed the result. */
      semantic?: true;
      /** Changes auto-merged by the semantic layer (present iff semantic). */
      auto_merged?: number;
      /** true when a concurrent stacking apply landed after the merge snapshot — the branch was kept, not deleted. */
      preview_kept?: boolean;
      /** Why the preview branch was retained (present iff preview_kept). */
      reason?: string;
    }
  | {
      merged: false;
      conflict: true;
      /** ONLY the true collisions — everything else auto-merges on accept. */
      units: BlockMergeConflict[];
      /**
       * Text preview of every block referenced by the `__order__` sentinel,
       * keyed by block id — lets the chooser list the two orderings as numbered
       * title/summary rows instead of raw ids. In a pure ordering conflict a
       * block's CONTENT is identical on both sides, so it is summarized ONCE
       * here. Absent when there is no order conflict. See PageUnitPreview.
       */
      unit_previews?: Record<string, PageUnitPreview>;
      /** Changes the semantic layer can merge without a decision. */
      auto_merged: number;
      ours_sha: string | null;
      theirs_sha: string | null;
    };

/** A block as the order-conflict chooser lists it (text-only; no editor mounted). */
export interface PageUnitPreview {
  /** Position in the source document. */
  index: number;
  /** Block type + a short slice of its text (≤80 chars). */
  summary: string;
}

/** Slice of a block's text kept in an order-conflict summary. */
const UNIT_PREVIEW_SUMMARY_CAP = 80;

/** Result of resolvePreviewConflicts: the resolved merge committed to main. */
export interface ResolvePreviewResult {
  merged: true;
  semantic: true;
  sha: string | null;
  auto_merged: number;
  /** The applied choices, echoed for auditing. */
  resolved: MergeResolution[];
  preview_kept?: boolean;
  reason?: string;
}

/** Parse a content.json body (wrapper or legacy bare array) into its blocks. */
function extractBlocks(content: string | null | undefined): BlockNode[] {
  if (!content) return [];
  try {
    const parsed = JSON.parse(content);
    if (Array.isArray(parsed)) return parsed;
    if (parsed && Array.isArray(parsed.blocks)) return parsed.blocks;
  } catch {
    // Malformed JSON — treat as empty for diff purposes
  }
  return [];
}

/**
 * Accept the page's preview: merge the preview branch into main via the
 * GitHub merge API, then delete the branch — unless a concurrent stacking
 * apply landed on the branch after the merge snapshot, in which case the
 * branch is KEPT (deleting it would discard the newer edits) and the result
 * carries `preview_kept: true` with a reason.
 *
 * On a git-level conflict, nothing is merged and nothing is deleted; instead
 * a structured per-unit report is built by 3-way-walking content.json's
 * top-level blocks (base = merge-base version, ours = main, theirs = preview)
 * so the caller can resolve semantically and re-apply.
 */
/**
 * Normalize a document GitHub's merge API just produced, committing a repair
 * only when one was actually needed.
 *
 * @param mergedFile - the post-merge content.json read (content + blob sha).
 * @returns the sha of the repair commit, or null when nothing needed fixing.
 */
async function repairMergedContent(
  page: PageWithContentRepo,
  mergedFile: { content?: string | null; sha?: string | null } | null,
  mergedSha: string | null
): Promise<string | null> {
  const blocks = mergedFile?.content ? parseBlocksStrict(mergedFile.content) : null;
  // Unparseable content.json is not this function's problem to solve — the
  // merge stands and the existing conflict/reload flows already cover it.
  if (!blocks) return null;

  let repaired = false;
  const normalized = normalizeBlockStructure(blocks, {
    onRepair: () => {
      repaired = true;
    },
  });
  if (!repaired) return null;

  try {
    const saved = await savePageContent(page, normalized, {
      coverImage: extractCover(mergedFile?.content),
      // CAS on the blob the merge produced: if anything landed in between,
      // that write went through savePageContent and was normalized itself, so
      // losing this race leaves a valid document either way.
      ...(mergedSha ? { expectedSha: mergedSha } : {}),
      message: `Accept preview (repaired column layout): ${page.title}`,
    });
    return saved.sha;
  } catch (error: unknown) {
    console.warn(
      `[pageContent.acceptPreview] Could not commit the post-merge column repair for ${page.content_path}:`,
      error instanceof Error ? error.message : String(error)
    );
    return null;
  }
}

export async function acceptPreview(page: PageWithContentRepo): Promise<AcceptPreviewResult> {
  const { gitOrganization, repo } = contentRepoFor(page);
  const branch = previewBranchName(page.content_path);

  const result = await ContentService.mergeBranch({
    gitOrganization,
    repo,
    base: 'main',
    head: branch,
    message: `Accept preview: ${page.title}`,
  });

  if (result.merged) {
    const path = `${page.content_path}/content.json`;

    // Report content.json's blob sha on main post-merge (aligning with the
    // deck accept's semantics). Read at the MERGE COMMIT sha — a deterministic
    // ref immune to GitHub's eventually-consistent branch reads. 204 no-op
    // merges have no merge commit; fall back to a fresh main read.
    let newSha: string | null = null;
    try {
      const mergedFile = await ContentService.getContent({
        gitOrganization,
        repo,
        path,
        ...(result.sha ? { ref: result.sha } : { skipCache: true }),
      });
      newSha = mergedFile?.sha ?? null;

      // A CLEAN git merge is not a valid document. Both sides can individually
      // satisfy the multi-column invariants and still merge into something no
      // reader can open: deleting two different columns from the same row is
      // two non-overlapping hunks in a pretty-printed content.json, so git
      // merges them without a conflict and never runs the semantic fallback.
      // This is the default route for a published page (applies land on the
      // preview branch), so it is the likeliest way the invariant gets broken,
      // not an exotic one. Repair on top of the merge commit.
      newSha = (await repairMergedContent(page, mergedFile, newSha)) ?? newSha;
    } catch (error: unknown) {
      // Advisory only — the merge itself stands.
      console.warn(
        `[pageContent.acceptPreview] Could not read merged content.json sha for ${repo}/${path}:`,
        error instanceof Error ? error.message : String(error)
      );
    }

    // Concurrent-stacking guard: a stacking apply may have committed to the
    // preview branch AFTER the merge snapshot GitHub used. If the branch now
    // has commits main lacks, deleting it would silently discard those edits —
    // keep the branch and report it. (A compare failure also keeps the branch:
    // stranding a preview is recoverable, deleting fresh commits is not.)
    let previewKept = false;
    let reason: string | undefined;
    try {
      const after = await ContentService.compareBranches({
        gitOrganization,
        repo,
        base: 'main',
        head: branch,
      });
      if (after && after.ahead_by > 0) {
        previewKept = true;
        reason = `Preview branch gained ${after.ahead_by} new commit(s) during accept — retained with the newer edits`;
      } else if (after) {
        await ContentService.deleteBranch({ gitOrganization, repo, branch });
      }
      // after === null → branch already gone (concurrent discard) — nothing to delete.
    } catch (error: unknown) {
      previewKept = true;
      reason = 'Could not verify the preview branch was fully merged — retained for safety';
      console.warn(
        `[pageContent.acceptPreview] Post-merge branch check failed for ${repo}/${branch}:`,
        error instanceof Error ? error.message : String(error)
      );
    }

    return {
      merged: true,
      sha: newSha,
      ...(previewKept ? { preview_kept: true, reason } : {}),
    };
  }

  // Git-level conflict: run the semantic 3-way merge (Phase 7). Zero true
  // collisions → the auto-merged result is committed to main (CAS'd on main's
  // pre-write sha) and the branch is deleted; genuine collisions → structured
  // report with only the units that need a decision, branch kept.
  return acceptSemanticFallback(page);
}

// ─── Semantic merge on accept (Phase 7) ──────────────────────────────────────

type ContentRead = Awaited<ReturnType<typeof ContentService.getContent>>;

interface PreviewThreeWay {
  comparison: Awaited<ReturnType<typeof ContentService.compareBranches>>;
  ours: ContentRead;
  theirs: ContentRead;
  base: ContentRead;
}

/** Read the 3-way (ours = fresh main, theirs = the preview branch, base = merge-base). */
async function readPreviewThreeWay(page: PageWithContentRepo): Promise<PreviewThreeWay> {
  const { gitOrganization, repo } = contentRepoFor(page);
  const branch = previewBranchName(page.content_path);
  const path = `${page.content_path}/content.json`;

  const comparison = await ContentService.compareBranches({
    gitOrganization,
    repo,
    base: 'main',
    head: branch,
  });
  const [ours, theirs, base] = await Promise.all([
    ContentService.getContent({ gitOrganization, repo, path, skipCache: true }),
    ContentService.getContent({ gitOrganization, repo, path, ref: branch }),
    comparison?.merge_base_sha
      ? ContentService.getContent({ gitOrganization, repo, path, ref: comparison.merge_base_sha })
      : Promise.resolve(null),
  ]);
  return { comparison, ours, theirs, base };
}

/** Read a fresh copy of main's content.json (retry path after a CAS loss). */
async function readFreshOurs(page: PageWithContentRepo) {
  const { gitOrganization, repo } = contentRepoFor(page);
  return ContentService.getContent({
    gitOrganization,
    repo,
    path: `${page.content_path}/content.json`,
    skipCache: true,
  });
}

/** Pull the coverImage out of a raw content.json body (wrapper format only). */
function extractCover(content: string | null | undefined): PageCoverImage | null {
  if (!content) return null;
  try {
    const parsed = JSON.parse(content);
    if (parsed && !Array.isArray(parsed) && parsed.coverImage) {
      return parsed.coverImage as PageCoverImage;
    }
  } catch {
    // Malformed JSON — no cover.
  }
  return null;
}

/**
 * 3-way cover merge: a preview-side change wins (the accept publishes the
 * preview's intent), anything else keeps main's. MCP previews never touch the
 * cover, so a genuine double-change is out of scope — main's survives.
 */
function mergeCover(
  base: PageCoverImage | null,
  ours: PageCoverImage | null,
  theirs: PageCoverImage | null
): PageCoverImage | null {
  const oursChanged = canonicalJson(ours) !== canonicalJson(base);
  const theirsChanged = canonicalJson(theirs) !== canonicalJson(base);
  if (theirsChanged && !oursChanged) return theirs;
  return ours;
}

/**
 * Commit a semantically merged document to main (CAS'd on main's pre-write
 * sha via savePageContent's expectedSha), then delete the preview branch —
 * unless the branch's content moved past the `theirs` we merged (a concurrent
 * stacking apply), in which case it is kept. Note: `compareBranches.ahead_by`
 * cannot make that call here — the semantic commit is a NEW commit on main,
 * so the branch's commits are never git-ancestors; the branch's content blob
 * sha vs the merged theirs sha is the reliable signal.
 */
async function commitSemanticMergeToMain(
  page: PageWithContentRepo,
  mergedBlocks: unknown[],
  {
    oursSha,
    theirsSha,
    coverImage,
  }: { oursSha: string; theirsSha: string | null; coverImage: PageCoverImage | null }
): Promise<{ sha: string; preview_kept?: boolean; reason?: string }> {
  const { gitOrganization, repo } = contentRepoFor(page);
  const branch = previewBranchName(page.content_path);
  const path = `${page.content_path}/content.json`;

  // oursSha is REQUIRED: the merge commit is always CAS'd on main's pre-write
  // content.json sha. Callers guard the main-file-deleted degenerate
  // (MAIN_CONTENT_MISSING) before reaching here — never an unguarded write.
  const saved = await savePageContent(page, mergedBlocks, {
    coverImage,
    expectedSha: oursSha,
    message: `Accept preview (auto-merged): ${page.title}`,
  });

  // TOCTOU note: this guard is a compare-THEN-delete — a stacking apply can
  // still land on the branch between the getMeta read and the deleteBranch
  // call below, and would be discarded with the branch. Accepted: GitHub's
  // refs DELETE has no precondition (no CAS delete), so the window cannot be
  // closed API-side; the guard shrinks it from the whole merge duration to
  // one request round-trip, and an apply racing an in-flight accept has no
  // ordering guarantee either way.
  let previewKept = false;
  let reason: string | undefined;
  try {
    const branchMeta = await ContentService.getMeta({
      gitOrganization,
      repo,
      path,
      ref: branch,
      skipCache: true,
    });
    if (branchMeta && theirsSha && branchMeta.sha !== theirsSha) {
      previewKept = true;
      reason = 'Preview branch gained new edits during accept — retained with the newer changes';
    } else {
      try {
        await ContentService.deleteBranch({ gitOrganization, repo, branch });
      } catch (error: unknown) {
        const status = (error as { status?: number }).status;
        if (status !== 404 && status !== 422) throw error; // already gone is fine
      }
    }
  } catch (error: unknown) {
    previewKept = true;
    reason = 'Could not verify the preview branch was unchanged — retained for safety';
    console.warn(
      `[pageContent.acceptPreview] Post-merge branch check failed for ${repo}/${branch}:`,
      error instanceof Error ? error.message : String(error)
    );
  }

  return { sha: saved.sha, ...(previewKept ? { preview_kept: true, reason } : {}) };
}

/**
 * Typed refusal for the main-file-deleted degenerate: without main's
 * content.json there is no sha to CAS the merge commit on, so committing
 * would be an unguarded write over whatever deleted it.
 */
function mainContentMissing(): PreviewResolutionError {
  return new PreviewResolutionError(
    "Main's content.json was deleted while this preview was pending — discard the preview " +
      'or re-apply it as a fresh document',
    'MAIN_CONTENT_MISSING'
  );
}

/**
 * Typed refusal for a missing/unparseable merge base (plan §7 P3): without the
 * content.json the preview forked from there is no trustworthy 3-way base, and
 * merging against an EMPTY base silently resurrects deletions and duplicates
 * blocks (the add/add case, where content.json was created independently on
 * both sides). Refuse rather than commit a corrupt document — mirroring the
 * save path's readSaveMergeBase refusal.
 */
function mergeBaseMissing(): PreviewResolutionError {
  return new PreviewResolutionError(
    'This preview has no common merge base with the live page (its content.json was created ' +
      'or replaced independently on both sides) — discard the preview or re-apply it as a fresh ' +
      'document',
    'MERGE_BASE_MISSING'
  );
}

/** Flatten a block's inline content (styled text, links, table rows) to plain text. */
function blockInlineText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map(node => {
        const inline = node as { text?: unknown; content?: unknown };
        if (typeof inline.text === 'string') return inline.text;
        if (inline.content !== undefined) return blockInlineText(inline.content);
        return '';
      })
      .join('');
  }
  const rows = (content as { rows?: { cells?: unknown[] }[] } | null | undefined)?.rows;
  if (Array.isArray(rows)) {
    return rows
      .map(row => (Array.isArray(row?.cells) ? row.cells.map(blockInlineText).join(' · ') : ''))
      .join('\n');
  }
  return '';
}

/** A one-line `type: text…` summary of a block for the order-conflict list. */
function blockPreviewSummary(block: BlockNode): string {
  const type = typeof block.type === 'string' ? block.type : 'block';
  const text = blockInlineText(block.content).replace(/\s+/g, ' ').trim();
  if (!text) return type;
  const shown =
    text.length > UNIT_PREVIEW_SUMMARY_CAP
      ? `${text.slice(0, UNIT_PREVIEW_SUMMARY_CAP - 1)}…`
      : text;
  return `${type}: ${shown}`;
}

/**
 * Build the `unit_previews` map for a block-order conflict: every block id the
 * `__order__` sentinel references, summarized ONCE from the ours document
 * (falling back to theirs for ids only present there). Undefined when there is
 * no order conflict. Blocks are id-normalized to align with the merge engine's
 * conflict ids (merge3Blocks fills derived ids internally).
 */
function buildPageUnitPreviews(
  conflicts: BlockMergeConflict[],
  oursBlocks: BlockNode[],
  theirsBlocks: BlockNode[]
): Record<string, PageUnitPreview> | undefined {
  const ids = new Set<string>();
  for (const conflict of conflicts) {
    if (conflict.reason === 'order') {
      for (const list of [conflict.ours, conflict.theirs, conflict.base]) {
        if (Array.isArray(list)) for (const id of list) if (typeof id === 'string') ids.add(id);
      }
    }
  }
  if (ids.size === 0) return undefined;

  const index = new Map<string, { block: BlockNode; index: number }>();
  for (const blocks of [ensureBlockIds(oursBlocks), ensureBlockIds(theirsBlocks)]) {
    (blocks as BlockNode[]).forEach((block, i) => {
      if (block?.id && !index.has(block.id)) index.set(block.id, { block, index: i });
    });
  }
  const previews: Record<string, PageUnitPreview> = {};
  for (const id of ids) {
    const entry = index.get(id);
    if (!entry) continue;
    previews[id] = { index: entry.index, summary: blockPreviewSummary(entry.block) };
  }
  return Object.keys(previews).length > 0 ? previews : undefined;
}

/** The accept path taken when the git merge reports a conflict. */
async function acceptSemanticFallback(page: PageWithContentRepo): Promise<AcceptPreviewResult> {
  const threeWay = await readPreviewThreeWay(page);
  const { theirs, base } = threeWay;
  let ours = threeWay.ours;
  // P7: a concurrent discard can delete the preview branch between the git
  // merge conflict and this 3-way read — with no preview there is nothing to
  // accept, and merging against the vanished theirs would auto-merge junk.
  // Mirror the resolvePreviewConflicts NO_PREVIEW guard.
  if (!threeWay.comparison) {
    throw new PreviewResolutionError(
      'No pending preview for this page — nothing to accept',
      'NO_PREVIEW'
    );
  }
  // P3: the 3-way needs a real merge base. A missing/unparseable base (the
  // add/add degenerate) would degrade to [] and silently resurrect deletions
  // or duplicate blocks — refuse instead.
  const baseBlocks = base?.content ? parseBlocksStrict(base.content) : null;
  if (!baseBlocks) throw mergeBaseMissing();
  const theirsBlocks = extractBlocks(theirs?.content);

  for (let attempt = 0; attempt < 2; attempt++) {
    // Main's content.json vanished (deleted while the preview was pending):
    // never commit without a CAS precondition — refuse with a typed error.
    if (!ours?.sha) throw mainContentMissing();

    const oursBlocks = extractBlocks(ours.content);
    const merge = merge3Blocks(baseBlocks, oursBlocks, theirsBlocks);
    if (merge.conflicts.length > 0) {
      // Only the true collisions are reported; the branch is left alone so
      // the caller can resolve (resolvePreviewConflicts), re-apply, or discard.
      const unitPreviews = buildPageUnitPreviews(merge.conflicts, oursBlocks, theirsBlocks);
      return {
        merged: false,
        conflict: true,
        units: merge.conflicts,
        ...(unitPreviews ? { unit_previews: unitPreviews } : {}),
        auto_merged: merge.autoMerged,
        ours_sha: ours.sha,
        theirs_sha: theirs?.sha ?? null,
      };
    }

    const coverImage = mergeCover(
      extractCover(base?.content),
      extractCover(ours.content),
      extractCover(theirs?.content)
    );
    try {
      const committed = await commitSemanticMergeToMain(page, merge.merged, {
        oursSha: ours.sha,
        theirsSha: theirs?.sha ?? null,
        coverImage,
      });
      return { merged: true, semantic: true, auto_merged: merge.autoMerged, ...committed };
    } catch (error: unknown) {
      if ((error as { status?: number }).status !== 409 || attempt === 1) throw error;
      // Main moved while we were auto-merging — one retry against fresh main.
      ours = await readFreshOurs(page);
    }
  }
  /* c8 ignore next */
  throw new Error('unreachable');
}

/**
 * Apply chooser decisions to a conflicted preview accept: re-runs the 3-way
 * merge, requires the resolutions to exactly cover the current conflict set
 * (`ours` = keep main's version, `theirs` = keep the preview's; the sentinel
 * `__order__` addresses a top-level order conflict), commits the resolved
 * merge to main exactly like a semantic accept, and deletes the branch.
 *
 * @param options.expectedOursSha - pin the resolution to the conflict report
 *   the choices were made against (the report's `ours_sha`). When provided
 *   and main's content.json no longer matches, the resolve fails with
 *   CONTENT_CONFLICT instead of applying reviewed choices to unseen content.
 * @param options.expectedTheirsSha - same pin for the preview side
 *   (the report's `theirs_sha`).
 *
 * @throws {PreviewResolutionError} NO_PREVIEW / NOTHING_TO_RESOLVE /
 *   UNRESOLVED_CONFLICTS / UNKNOWN_RESOLUTIONS / DUPLICATE_RESOLUTIONS /
 *   INVALID_RESOLUTIONS / CONTENT_CONFLICT / MAIN_CONTENT_MISSING.
 */
export async function resolvePreviewConflicts(
  page: PageWithContentRepo,
  {
    resolutions,
    expectedOursSha,
    expectedTheirsSha,
  }: {
    resolutions: MergeResolution[];
    expectedOursSha?: string;
    expectedTheirsSha?: string;
  }
): Promise<ResolvePreviewResult> {
  if (!resolutions?.length) {
    throw new PreviewResolutionError(
      'No resolutions supplied — pass one {id, choose} per conflict',
      'UNRESOLVED_CONFLICTS'
    );
  }
  const chosen = indexResolutions(resolutions);

  const threeWay = await readPreviewThreeWay(page);
  if (!threeWay.comparison) {
    throw new PreviewResolutionError(
      'No pending preview for this page — nothing to resolve',
      'NO_PREVIEW'
    );
  }
  const { theirs, base } = threeWay;
  let ours = threeWay.ours;
  // P3: refuse a missing/unparseable merge base (add/add degenerate) rather
  // than apply reviewed choices over an empty base that resurrects/duplicates.
  const baseBlocks = base?.content ? parseBlocksStrict(base.content) : null;
  if (!baseBlocks) throw mergeBaseMissing();
  const theirsBlocks = extractBlocks(theirs?.content);

  if (expectedTheirsSha && (theirs?.sha ?? null) !== expectedTheirsSha) {
    throw new PreviewResolutionError(
      'The preview changed since the conflict report these choices were made against — ' +
        're-run accept for a fresh report',
      'CONTENT_CONFLICT'
    );
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    // Re-checked every attempt: a CAS-loss retry re-reads main, and choices
    // pinned to the reviewed report must not silently apply to newer content.
    if (expectedOursSha && (ours?.sha ?? null) !== expectedOursSha) {
      throw new PreviewResolutionError(
        'The live page changed since the conflict report these choices were made against — ' +
          're-run accept for a fresh report',
        'CONTENT_CONFLICT'
      );
    }
    if (!ours?.sha) throw mainContentMissing();

    const oursBlocks = extractBlocks(ours.content);
    const current = merge3Blocks(baseBlocks, oursBlocks, theirsBlocks);
    const conflictIds = new Set(current.conflicts.map(unit => unit.id));
    if (conflictIds.size === 0) {
      throw new PreviewResolutionError(
        'Nothing to resolve — the preview now merges cleanly; accept it without resolutions',
        'NOTHING_TO_RESOLVE'
      );
    }
    const missing = [...conflictIds].filter(id => !(id in chosen));
    if (missing.length > 0) {
      throw new PreviewResolutionError(
        `Every conflict needs a choice — missing: ${missing.join(', ')}`,
        'UNRESOLVED_CONFLICTS',
        missing
      );
    }
    const unknown = Object.keys(chosen).filter(id => !conflictIds.has(id));
    if (unknown.length > 0) {
      throw new PreviewResolutionError(
        `Not current conflict ids: ${unknown.join(', ')} — re-run accept for the current report`,
        'UNKNOWN_RESOLUTIONS',
        unknown
      );
    }

    const resolved = merge3Blocks(baseBlocks, oursBlocks, theirsBlocks, { resolutions: chosen });
    if (resolved.conflicts.length > 0) {
      throw new Error(
        `Resolution pass left conflicts standing (${resolved.conflicts.map(u => u.id).join(', ')}) — this is a bug`
      );
    }

    const coverImage = mergeCover(
      extractCover(base?.content),
      extractCover(ours.content),
      extractCover(theirs?.content)
    );
    try {
      const committed = await commitSemanticMergeToMain(page, resolved.merged, {
        oursSha: ours.sha,
        theirsSha: theirs?.sha ?? null,
        coverImage,
      });
      return {
        merged: true,
        semantic: true,
        auto_merged: resolved.autoMerged,
        resolved: resolutions,
        ...committed,
      };
    } catch (error: unknown) {
      if ((error as { status?: number }).status !== 409 || attempt === 1) throw error;
      // Main moved under us — re-read, re-validate the conflict set, retry once.
      ours = await readFreshOurs(page);
    }
  }
  /* c8 ignore next */
  throw new Error('unreachable');
}

// ─── Semantic merge for EDITOR saves (plan §3b Phase 7.5) ────────────────────

/**
 * Fallback conflict for the save-merge path: carries `status: 409` so the
 * existing route handling (the "page changed — reload" banner) applies
 * unchanged. Thrown when no trustworthy 3-way exists (base blob unreadable,
 * main's content.json gone) or when the CAS retry lost twice.
 */
export class PageSaveConflictError extends Error {
  status = 409 as const;
  code = 'CONTENT_CONFLICT' as const;

  constructor(message: string) {
    super(message);
    this.name = 'PageSaveConflictError';
  }
}

/** Strict content.json parse — wrapper or legacy bare array; anything else null. */
function parseBlocksStrict(content: string): BlockNode[] | null {
  try {
    const parsed = JSON.parse(content);
    if (Array.isArray(parsed)) return parsed;
    if (parsed && Array.isArray(parsed.blocks)) return parsed.blocks;
  } catch {
    // Malformed — the caller falls back to the plain conflict flow.
  }
  return null;
}

export interface SavePageMergeArgs {
  /** The editor's conflict token — content.json's blob sha when the editor read it (the 3-way base). */
  baseSha: string;
  /** Chooser decisions from a prior conflict report (save re-submit). */
  resolutions?: MergeResolution[];
  /**
   * Pin to the conflict report the resolutions were reviewed against (its
   * `ours_sha`). When main's content.json no longer matches, the save fails
   * with CONTENT_CONFLICT instead of applying reviewed choices to unseen
   * content.
   */
  expectedOursSha?: string;
  message?: string;
}

export type SavePageMergeResult =
  | {
      merged: true;
      /** content.json's new blob sha — the editor's fresh conflict token. */
      sha: string;
      commit: string;
      /**
       * The merged blocks as committed — the editor must adopt this document
       * (its own local copy lacks the folded-in concurrent changes, and a
       * fresh token over a stale document would clobber them on the NEXT save).
       */
      document: unknown[];
      /** Block-level changes (both sides) that merged without a conflict. */
      auto_merged: number;
      /** Concurrent (main-side) block changes folded into this save — the toast count. */
      concurrent: number;
    }
  | {
      merged: false;
      conflict: true;
      /** ONLY the true collisions (incl. the `__order__` sentinel). */
      units: BlockMergeConflict[];
      auto_merged: number;
      /** Main's content.json sha the report was built from — the resolution pin. */
      ours_sha: string;
    };

/**
 * Read + parse the save-merge base: the document at the editor's conflict
 * token, fetched content-addressed via ContentService.getBlobContent. A
 * failed or unparseable read means no trustworthy 3-way exists — throw the
 * fallback conflict rather than merging against a guessed base.
 *
 * @throws {PageSaveConflictError}
 */
async function readSaveMergeBase(page: PageWithContentRepo, baseSha: string): Promise<BlockNode[]> {
  const { gitOrganization, repo } = contentRepoFor(page);
  let baseFile: { content: string } | null = null;
  try {
    baseFile = await ContentService.getBlobContent({ gitOrganization, repo, sha: baseSha });
  } catch (error: unknown) {
    console.warn(
      `[pageContent.saveMerge] Base blob read failed for ${repo}@${baseSha}:`,
      error instanceof Error ? error.message : String(error)
    );
  }
  const baseBlocks = baseFile ? parseBlocksStrict(baseFile.content) : null;
  if (!baseBlocks) {
    throw new PageSaveConflictError('This page changed since it was read — reload before saving');
  }
  return baseBlocks;
}

/**
 * Save an editor's posted blocks over a stale conflict token by 3-way
 * semantic merge (plan §3b Phase 7.5). The token IS the merge base: it is
 * content.json's blob sha at editor-load time, fetched content-addressed via
 * ContentService.getBlobContent. ours = fresh main, theirs = the posted
 * blocks. Zero collisions → the merged document is committed (CAS'd on
 * main's pre-write sha, main's current coverImage preserved) and the save
 * succeeds with the concurrent-change count; true collisions → a structured
 * per-unit report for the editor's conflict chooser. The client re-submits
 * the SAME posted blocks plus resolutions and the report's `ours_sha` pin.
 *
 * @throws {PageSaveConflictError} fallback to the plain 409 reload flow.
 * @throws {PreviewResolutionError} CONTENT_CONFLICT (ours pin stale) /
 *   NOTHING_TO_RESOLVE / UNRESOLVED_CONFLICTS / UNKNOWN_RESOLUTIONS /
 *   DUPLICATE_RESOLUTIONS / INVALID_RESOLUTIONS.
 */
export async function savePageContentWithMerge(
  page: PageWithContentRepo,
  theirs: unknown[],
  { baseSha, resolutions, expectedOursSha, message }: SavePageMergeArgs
): Promise<SavePageMergeResult> {
  const baseBlocks = await readSaveMergeBase(page, baseSha);
  return runSaveMerge(page, theirs, baseBlocks, { resolutions, expectedOursSha, message });
}

/**
 * The save-merge core shared by the whole-document entry
 * (savePageContentWithMerge) and the ops entry (savePageContentFromOps):
 * 3-way merge of base (the token's document) / ours (fresh main) / theirs
 * (the posted or materialized document), the resolutions validation, the
 * concurrent-change count, and the CAS'd commit with one retry.
 */
async function runSaveMerge(
  page: PageWithContentRepo,
  theirs: unknown[],
  baseBlocks: BlockNode[],
  {
    resolutions,
    expectedOursSha,
    message,
  }: Pick<SavePageMergeArgs, 'resolutions' | 'expectedOursSha' | 'message'>
): Promise<SavePageMergeResult> {
  const { gitOrganization, repo } = contentRepoFor(page);
  const path = `${page.content_path}/content.json`;

  const chosen = resolutions ? indexResolutions(resolutions) : null;

  for (let attempt = 0; attempt < 2; attempt++) {
    // Ours = fresh main. skipCache REQUIRED — this read pins the CAS sha.
    const ours = await ContentService.getContent({ gitOrganization, repo, path, skipCache: true });

    // Re-checked every attempt: a CAS-loss retry re-reads main, and choices
    // reviewed against one report must not silently apply to newer content.
    if (expectedOursSha && (ours?.sha ?? null) !== expectedOursSha) {
      throw new PreviewResolutionError(
        'The page changed since the conflict report these choices were made against — ' +
          'save again for a fresh report',
        'CONTENT_CONFLICT'
      );
    }

    const oursBlocks = ours ? parseBlocksStrict(ours.content) : null;
    if (!ours || !oursBlocks) {
      // content.json deleted or unreadable on main: no CAS anchor, no 3-way.
      throw new PageSaveConflictError(
        'content.json no longer exists — reload the page before saving'
      );
    }

    if (chosen) {
      // The resolutions must exactly cover the CURRENT conflict set (same
      // validation as resolvePreviewConflicts).
      const current = merge3Blocks(baseBlocks, oursBlocks, theirs);
      const conflictIds = new Set(current.conflicts.map(unit => unit.id));
      if (conflictIds.size === 0) {
        throw new PreviewResolutionError(
          'Nothing to resolve — the save now merges cleanly; save again without resolutions',
          'NOTHING_TO_RESOLVE'
        );
      }
      const missing = [...conflictIds].filter(id => !(id in chosen));
      if (missing.length > 0) {
        throw new PreviewResolutionError(
          `Every conflict needs a choice — missing: ${missing.join(', ')}`,
          'UNRESOLVED_CONFLICTS',
          missing
        );
      }
      const unknown = Object.keys(chosen).filter(id => !conflictIds.has(id));
      if (unknown.length > 0) {
        throw new PreviewResolutionError(
          `Not current conflict ids: ${unknown.join(', ')} — save again for the current report`,
          'UNKNOWN_RESOLUTIONS',
          unknown
        );
      }
    }

    const merge = merge3Blocks(
      baseBlocks,
      oursBlocks,
      theirs,
      chosen ? { resolutions: chosen } : {}
    );
    if (merge.conflicts.length > 0) {
      if (chosen) {
        throw new Error(
          `Resolution pass left conflicts standing (${merge.conflicts.map(u => u.id).join(', ')}) — this is a bug`
        );
      }
      return {
        merged: false,
        conflict: true,
        units: merge.conflicts,
        auto_merged: merge.autoMerged,
        ours_sha: ours.sha,
      };
    }

    // Concurrent (main-side) changes folded into this save: a theirs-less
    // merge (theirs = base) counts exactly the blocks ours changed vs base.
    const concurrent = merge3Blocks(baseBlocks, oursBlocks, baseBlocks).autoMerged;

    // Commit message: a resolution pass or a genuine concurrent fold-in is
    // recorded distinctly so the git history isn't indistinguishable from a
    // plain save (the routes no longer override with a plain message — plan
    // "commit-message" finding). A clean save with no concurrency and no
    // resolutions keeps the plain message (nothing was actually merged).
    const resolvedCount = chosen ? Object.keys(chosen).length : 0;
    const committedMessage =
      message ??
      (resolvedCount > 0
        ? `Update page (merged; resolved ${resolvedCount} conflict${resolvedCount === 1 ? '' : 's'}): ${page.title}`
        : concurrent > 0
          ? `Update page (merged): ${page.title}`
          : `Update page: ${page.title}`);

    // Both sides can be individually valid and still merge into a document
    // that isn't (each deletes a different column of the same three-column
    // row). Normalize once, so the commit and the document handed back to the
    // client are the same blocks — the client adopts what main now holds.
    const merged = normalizeBlockStructure(merge.merged);

    try {
      const saved = await savePageContent(page, merged, {
        // Preserve main's CURRENT cover explicitly (the editor save carries no
        // cover; passing it avoids savePageContent's extra preserve re-read).
        coverImage: extractCover(ours.content),
        expectedSha: ours.sha,
        message: committedMessage,
      });
      return {
        merged: true,
        sha: saved.sha,
        commit: saved.commit,
        document: merged,
        auto_merged: merge.autoMerged,
        concurrent,
      };
    } catch (error: unknown) {
      if ((error as { status?: number }).status !== 409 || attempt === 1) throw error;
      // Main moved mid-commit — one retry re-runs the 3-way against fresh ours.
    }
  }
  /* c8 ignore next */
  throw new Error('unreachable');
}

// ─── Ops saves (diff-at-save) ────────────────────────────────────────────────

/**
 * Typed refusal for an ops save whose operations don't apply to the document
 * at base_sha (unknown block id or anchor, bad position, malformed op). The
 * client's recovery is ONE whole-document save of its current editor content —
 * that path needs no base to replay against. Carries `status: 409` so an
 * unhandled propagation degrades to the reload-banner flow, never a 500.
 */
export class PageOpsBaseMismatchError extends Error {
  status = 409 as const;
  code = 'OPS_BASE_MISMATCH' as const;

  constructor(message: string) {
    super(message);
    this.name = 'PageOpsBaseMismatchError';
  }
}

export interface SavePageOpsArgs extends SavePageMergeArgs {
  /**
   * Block operations the client diffed against the document at baseSha.
   * Ids and positions resolve against that BASE document.
   */
  ops: BlockOp[];
}

export type SavePageOpsResult =
  | (Omit<Extract<SavePageMergeResult, { merged: true }>, 'document'> & {
      /**
       * The merged blocks as committed, when they differ from the
       * ops-materialized document (concurrent main-side changes folded in, or
       * server-side id re-mints) — the editor must adopt them. `null` = the
       * committed document is exactly base+ops, i.e. the document the client
       * already shows; no adoption/remount needed.
       */
      document: unknown[] | null;
    })
  | Extract<SavePageMergeResult, { merged: false }>;

/**
 * Save an editor's diff-at-save block operations: materialize
 * `theirs = applyBlockOps(base, ops)` where base is the document at the
 * editor's conflict token (same blob-addressed base as
 * savePageContentWithMerge), then run the SAME 3-way merge/commit/report/
 * resolutions machinery. Untouched blocks never transmit, and concurrent
 * saves to different blocks auto-merge by construction. coverImage: ops
 * never carry it — main's current cover is preserved exactly like the
 * whole-document merge path.
 *
 * A conflict report's chooser re-submit carries the SAME ops plus
 * resolutions and the report's `ours_sha` pin.
 *
 * @throws {PageOpsBaseMismatchError} the ops don't apply to the document at
 *   baseSha — the client falls back to one whole-document save.
 * @throws {PageSaveConflictError} unreadable base → the plain 409 reload flow.
 * @throws {PreviewResolutionError} same resolution-validation errors as
 *   savePageContentWithMerge.
 */
export async function savePageContentFromOps(
  page: PageWithContentRepo,
  { ops, baseSha, resolutions, expectedOursSha, message }: SavePageOpsArgs
): Promise<SavePageOpsResult> {
  const baseBlocks = await readSaveMergeBase(page, baseSha);

  // Materialize theirs = base + ops. Any BlockOpError (unknown id/anchor —
  // the client diffed against a different document than the token names — or
  // a malformed op) is the typed mismatch, NOT a merge conflict.
  let theirs: unknown[];
  let reminted = 0;
  try {
    theirs = applyBlockOps(baseBlocks, ops, { onIdRemint: () => reminted++ });
  } catch (error: unknown) {
    if (error instanceof BlockOpError) {
      throw new PageOpsBaseMismatchError(
        `Ops do not apply to the document at base_sha — ${error.message}`
      );
    }
    throw error;
  }

  const result = await runSaveMerge(page, theirs, baseBlocks, {
    resolutions,
    expectedOursSha,
    message,
  });
  if (!result.merged) return result;

  // Adoption signal: when the committed document is exactly the materialized
  // base+ops, the client's editor already shows it — `document: null` skips
  // the adopt/remount (a clean ops save must not cost cursor position).
  // Compared against ensureBlockIds(theirs) because the merge engine fills
  // missing ids on every side; any server-side id re-mint forces adoption
  // (the client's copy carries the pre-remint ids).
  const unchanged =
    reminted === 0 && canonicalJson(result.document) === canonicalJson(ensureBlockIds(theirs));
  return unchanged ? { ...result, document: null } : result;
}

/**
 * Discard the page's preview branch (delete it; main is untouched).
 * 404-tolerant: an already-gone branch reports `existed: false` instead of
 * throwing (GitHub answers 422 "Reference does not exist" — some proxies 404).
 */
export async function discardPreview(
  page: PageWithContentRepo
): Promise<{ discarded: true; existed: boolean }> {
  const { gitOrganization, repo } = contentRepoFor(page);
  const branch = previewBranchName(page.content_path);

  try {
    await ContentService.deleteBranch({ gitOrganization, repo, branch });
    return { discarded: true, existed: true };
  } catch (error: unknown) {
    const status = (error as { status?: number }).status;
    if (status === 404 || status === 422) {
      return { discarded: true, existed: false };
    }
    throw error;
  }
}

// ─── 3-way block diff (conflict reporting) ───────────────────────────────────

/** Sentinel unit id for a top-level ordering conflict. */
export const ORDER_CONFLICT_ID = '__order__';

const idsOf = (blocks: BlockNode[]): string[] =>
  blocks.map(block => block?.id).filter((id): id is string => typeof id === 'string');

// NOTE (plan §7 P10): the Level-1 `diffBlockUnits` walker was removed here — it
// had zero production callers after Phase 7 (accept/save conflict reports come
// straight from merge3Blocks' `conflicts`), and its raw-string unit comparison
// diverged from the shipping engine's canonical, serialization-tolerant merge
// (re-adopting it would regress the Phase 7.5 phantom-conflict fix). The
// authoritative 3-way is `merge3Blocks` below.

// ─── merge3Blocks — semantic 3-way merge (Phase 7) ───────────────────────────

/** A true collision the semantic merge cannot decide. Same shape as
 * PreviewConflictUnit (absent ours/theirs = deleted on that side; the
 * `__order__` sentinel carries id arrays) plus the machine-readable reason. */
export interface BlockMergeConflict extends PreviewConflictUnit {
  reason: 'content' | 'delete_vs_edit' | 'both_added' | 'order';
}

export interface BlockMergeResult {
  /**
   * The merged document. Fully authoritative when `conflicts` is empty; while
   * conflicts are pending, conflicted units carry the theirs side (or ours
   * when theirs deleted) provisionally.
   */
  merged: unknown[];
  conflicts: BlockMergeConflict[];
  /** Block-level changes (edits/adds/deletes) that merged without a conflict. */
  autoMerged: number;
}

/**
 * Semantic 3-way merge of a BlockNote document by TOP-LEVEL block id
 * (base = merge-base, ours = main, theirs = preview). Pure. The unit is the
 * top-level block — its `children` subtree rides with it and compares
 * deep-equal (a slide-style per-child merge does not apply to pages).
 *
 * Rules (mirroring the deck engine):
 * - changed on one side only → take that side; identical changes → take either
 * - changed differently on both sides → conflict
 * - added on a side → keep (position woven from that side's order)
 * - deleted on one side + unchanged other → the delete wins
 * - deleted on one side + edited other → conflict (side absent = deleted)
 * - top-level order 3-way merged; both reordered differently → the
 *   `__order__` sentinel conflict
 * - a CROSS-SCOPE MOVE (an id that is top-level on one side but nested inside
 *   a block's subtree on another) merges as its own top-level unit: each
 *   side's copy is harvested from wherever it lives and the nested copies are
 *   stripped from their old parents, so a parent conflict card never carries
 *   a block with an independent fate — and a resolution can never commit a
 *   duplicated id. A move-out on one side + an edit-in-place on the other
 *   auto-merges (the edit follows the moved block).
 *
 * Ids are the merge identity: blocks missing one get the deterministic
 * derived id first (identical unedited blocks derive identical ids across
 * versions, so they still align).
 *
 * @param opts.resolutions - chooser decisions keyed by conflict id
 *   (`ours` = main's version, `theirs` = the preview's); a resolved conflict
 *   is applied and not reported.
 */
export function merge3Blocks(
  base: unknown[],
  ours: unknown[],
  theirs: unknown[],
  opts: { resolutions?: Record<string, MergeChoice> } = {}
): BlockMergeResult {
  const resolutions = opts.resolutions ?? {};
  const b = ensureBlockIds((base ?? []) as BlockNode[]) as BlockNode[];
  const o = ensureBlockIds((ours ?? []) as BlockNode[]) as BlockNode[];
  const t = ensureBlockIds((theirs ?? []) as BlockNode[]) as BlockNode[];

  const byId = (blocks: BlockNode[]): Map<string, { block: BlockNode; index: number }> => {
    const map = new Map<string, { block: BlockNode; index: number }>();
    blocks.forEach((block, index) => {
      if (block && typeof block.id === 'string' && !map.has(block.id)) {
        map.set(block.id, { block, index });
      }
    });
    return map;
  };

  // ── Cross-scope moves ──
  // Ids that are top-level on one side and nested on another are promoted to
  // top-level units everywhere they exist; the nested copies are stripped.
  const nestedById = (blocks: BlockNode[]): Map<string, BlockNode> => {
    const map = new Map<string, BlockNode>();
    const walk = (list: BlockNode[]): void => {
      for (const node of list) {
        if (!node || typeof node !== 'object') continue;
        if (typeof node.id === 'string' && node.id && !map.has(node.id)) {
          map.set(node.id, node);
        }
        if (Array.isArray(node.children)) walk(node.children);
      }
    };
    for (const top of blocks) {
      if (top && Array.isArray(top.children)) walk(top.children);
    }
    return map;
  };
  const topLevelIds = new Set([...idsOf(b), ...idsOf(o), ...idsOf(t)]);
  const nestedSides = [nestedById(b), nestedById(o), nestedById(t)];
  const escapedIds = new Set(
    [...topLevelIds].filter(id => nestedSides.some(nested => nested.has(id)))
  );
  if (escapedIds.size > 0) {
    const stripNested = (blocks: BlockNode[]): void => {
      const prune = (list: BlockNode[]): void => {
        for (let i = list.length - 1; i >= 0; i--) {
          const node = list[i];
          if (!node || typeof node !== 'object') continue;
          if (typeof node.id === 'string' && escapedIds.has(node.id)) {
            list.splice(i, 1);
            continue;
          }
          if (Array.isArray(node.children)) prune(node.children);
        }
      };
      for (const top of blocks) {
        if (top && Array.isArray(top.children)) prune(top.children);
      }
    };
    stripNested(b);
    stripNested(o);
    stripNested(t);
  }

  const bMap = byId(b);
  const oMap = byId(o);
  const tMap = byId(t);

  if (escapedIds.size > 0) {
    // Promote each escaped id to a synthetic top-level entry on the sides
    // where it only existed nested (its harvested copy is that side's
    // version). Display index comes from wherever it is genuinely top-level.
    const maps = [bMap, oMap, tMap] as const;
    for (const id of escapedIds) {
      const displayIndex = tMap.get(id)?.index ?? oMap.get(id)?.index ?? bMap.get(id)?.index ?? -1;
      maps.forEach((map, side) => {
        const harvested = nestedSides[side].get(id);
        if (!map.has(id) && harvested) {
          map.set(id, { block: harvested, index: displayIndex });
        }
      });
    }
  }

  const seen = new Set<string>();
  const allIds = [...tMap.keys(), ...oMap.keys(), ...bMap.keys()].filter(id => {
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });

  const sig = (entry: { block: BlockNode } | undefined): string =>
    entry ? canonicalJson(entry.block) : 'absent';

  const conflicts: BlockMergeConflict[] = [];
  let autoMerged = 0;
  /** Survivors: id → the block the merged doc carries (chosen or provisional). */
  const kept = new Map<string, BlockNode>();
  /** Ids that were (initially) conflicts — resolved or not (dedupe preference). */
  const conflictedIds = new Set<string>();

  for (const id of allIds) {
    const inB = bMap.get(id);
    const inO = oMap.get(id);
    const inT = tMap.get(id);

    const makeEntry = (reason: BlockMergeConflict['reason']): BlockMergeConflict => ({
      id,
      index: inT?.index ?? inO?.index ?? inB?.index ?? -1,
      reason,
      ...(inO ? { ours: structuredClone(inO.block) } : {}),
      ...(inT ? { theirs: structuredClone(inT.block) } : {}),
      ...(inB ? { base: structuredClone(inB.block) } : {}),
    });

    type Fate =
      | { kind: 'drop' }
      | { kind: 'keep'; block: BlockNode }
      | { kind: 'conflict'; entry: BlockMergeConflict; provisional: BlockNode };
    let fate: Fate;

    if (inB && inO && inT) {
      const oursChanged = sig(inO) !== sig(inB);
      const theirsChanged = sig(inT) !== sig(inB);
      if (!oursChanged && !theirsChanged) fate = { kind: 'keep', block: inB.block };
      else if (oursChanged && !theirsChanged) {
        fate = { kind: 'keep', block: inO.block };
        autoMerged++;
      } else if (!oursChanged && theirsChanged) {
        fate = { kind: 'keep', block: inT.block };
        autoMerged++;
      } else if (sig(inO) === sig(inT)) {
        fate = { kind: 'keep', block: inO.block }; // identical edits
        autoMerged++;
      } else {
        fate = { kind: 'conflict', entry: makeEntry('content'), provisional: inT.block };
      }
    } else if (inB && !inO && !inT) {
      fate = { kind: 'drop' }; // deleted on both sides
      autoMerged++;
    } else if (inB && !inO && inT) {
      // Deleted on ours (main).
      if (sig(inT) === sig(inB)) {
        fate = { kind: 'drop' }; // the delete wins over an unchanged block
        autoMerged++;
      } else {
        fate = { kind: 'conflict', entry: makeEntry('delete_vs_edit'), provisional: inT.block };
      }
    } else if (inB && inO && !inT) {
      // Deleted on theirs (the preview).
      if (sig(inO) === sig(inB)) {
        fate = { kind: 'drop' };
        autoMerged++;
      } else {
        fate = { kind: 'conflict', entry: makeEntry('delete_vs_edit'), provisional: inO.block };
      }
    } else if (!inB && inO && !inT) {
      fate = { kind: 'keep', block: inO.block }; // added on main
      autoMerged++;
    } else if (!inB && !inO && inT) {
      fate = { kind: 'keep', block: inT.block }; // added on the preview
      autoMerged++;
    } else if (sig(inO) === sig(inT)) {
      fate = { kind: 'keep', block: inO!.block }; // added identically on both
      autoMerged++;
    } else {
      fate = { kind: 'conflict', entry: makeEntry('both_added'), provisional: inT!.block };
    }

    if (fate.kind === 'conflict') conflictedIds.add(id);
    const choice = resolutions[id];
    if (fate.kind === 'conflict' && choice) {
      const chosenBlock = (choice === 'ours' ? fate.entry.ours : fate.entry.theirs) as
        | BlockNode
        | undefined;
      fate = chosenBlock == null ? { kind: 'drop' } : { kind: 'keep', block: chosenBlock };
    }

    if (fate.kind === 'keep') {
      kept.set(id, fate.block);
    } else if (fate.kind === 'conflict') {
      kept.set(id, fate.provisional);
      conflicts.push(fate.entry);
    }
  }

  // Top-level order: 3-way sequence merge with the survivors as members.
  const members = new Set(kept.keys());
  const seq = mergeIdSequence3(
    idsOf(b),
    idsOf(o),
    idsOf(t),
    members,
    resolutions[ORDER_CONFLICT_ID]
  );
  let order: string[];
  if (seq.conflict) {
    conflicts.push({
      id: ORDER_CONFLICT_ID,
      index: -1,
      reason: 'order',
      base: seq.base,
      ours: seq.ours,
      theirs: seq.theirs,
    });
    order = seq.provisional;
  } else {
    order = seq.order;
  }
  // Safety net: every survivor must land somewhere.
  for (const id of members) {
    if (!order.includes(id)) order.push(id);
  }

  const merged = order.map(id => structuredClone(kept.get(id)!));

  // Final safety assertion: no id may appear twice anywhere in the assembled
  // document (a duplicate committed to main corrupts the page for every
  // future merge and confuses id-addressed applies). Unreachable through the
  // cross-scope-move promotion above, but deeply-nested cross-parent moves
  // could still smuggle two copies in. Preference goes to the copy inside a
  // conflict unit's subtree — that copy is what the chooser card showed.
  const duplicateIds = dedupeMergedTreeIds(merged, conflictedIds);
  if (duplicateIds.length > 0) {
    console.warn(
      `[pageContent.merge3Blocks] merged document carried duplicate block id(s) ` +
        `${duplicateIds.join(', ')} — kept the conflict-resolution copy and dropped the stale one(s)`
    );
  }

  return { merged, conflicts, autoMerged };
}
