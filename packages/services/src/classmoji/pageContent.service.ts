import { createHash } from 'node:crypto';
import { classroomContentRepoName } from '@classmoji/utils';
import { ContentService } from '../content/ContentService.ts';
import {
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
    content_namespace: string;
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
  return {
    gitOrganization,
    repo: classroomContentRepoName({
      login: gitOrganization.login,
      namespace: page.classroom.content_namespace,
    }),
  };
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

  const wrapper: { blocks: unknown; coverImage?: PageCoverImage | null } = { blocks };
  if (coverImage !== undefined) {
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
 * @returns `{ url, path }` — raw.githubusercontent.com URL for immediate use.
 */
export async function uploadPageAsset(
  page: PageWithContentRepo,
  buffer: Buffer,
  filename: string
): Promise<{ url: string; path: string }> {
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

  return { url: result.url, path: result.path };
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

export type BlockOp =
  | { op: 'update'; id: string; block: unknown }
  | { op: 'insert'; blocks: unknown[]; position: BlockPosition }
  | { op: 'move'; id: string; position: BlockPosition }
  | { op: 'delete'; id: string }
  | { op: 'replace_all'; blocks: unknown[] };

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
  { onIdRemint }: { onIdRemint?: (remint: BlockIdRemint) => void } = {}
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

  return doc;
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
      /** Changes the semantic layer can merge without a decision. */
      auto_merged: number;
      ours_sha: string | null;
      theirs_sha: string | null;
    };

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
  }: { oursSha?: string; theirsSha: string | null; coverImage: PageCoverImage | null }
): Promise<{ sha: string; preview_kept?: boolean; reason?: string }> {
  const { gitOrganization, repo } = contentRepoFor(page);
  const branch = previewBranchName(page.content_path);
  const path = `${page.content_path}/content.json`;

  const saved = await savePageContent(page, mergedBlocks, {
    coverImage,
    ...(oursSha ? { expectedSha: oursSha } : {}),
    message: `Accept preview (auto-merged): ${page.title}`,
  });

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

/** The accept path taken when the git merge reports a conflict. */
async function acceptSemanticFallback(page: PageWithContentRepo): Promise<AcceptPreviewResult> {
  const threeWay = await readPreviewThreeWay(page);
  const { theirs, base } = threeWay;
  let ours = threeWay.ours;
  const baseBlocks = extractBlocks(base?.content);
  const theirsBlocks = extractBlocks(theirs?.content);

  for (let attempt = 0; attempt < 2; attempt++) {
    const merge = merge3Blocks(baseBlocks, extractBlocks(ours?.content), theirsBlocks);
    if (merge.conflicts.length > 0) {
      // Only the true collisions are reported; the branch is left alone so
      // the caller can resolve (resolvePreviewConflicts), re-apply, or discard.
      return {
        merged: false,
        conflict: true,
        units: merge.conflicts,
        auto_merged: merge.autoMerged,
        ours_sha: ours?.sha ?? null,
        theirs_sha: theirs?.sha ?? null,
      };
    }

    const coverImage = mergeCover(
      extractCover(base?.content),
      extractCover(ours?.content),
      extractCover(theirs?.content)
    );
    try {
      const committed = await commitSemanticMergeToMain(page, merge.merged, {
        oursSha: ours?.sha,
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
 * @throws {PreviewResolutionError} NO_PREVIEW / NOTHING_TO_RESOLVE /
 *   UNRESOLVED_CONFLICTS / UNKNOWN_RESOLUTIONS / DUPLICATE_RESOLUTIONS.
 */
export async function resolvePreviewConflicts(
  page: PageWithContentRepo,
  { resolutions }: { resolutions: MergeResolution[] }
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
  const baseBlocks = extractBlocks(base?.content);
  const theirsBlocks = extractBlocks(theirs?.content);

  for (let attempt = 0; attempt < 2; attempt++) {
    const oursBlocks = extractBlocks(ours?.content);
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
      extractCover(ours?.content),
      extractCover(theirs?.content)
    );
    try {
      const committed = await commitSemanticMergeToMain(page, resolved.merged, {
        oursSha: ours?.sha,
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

const deepEqual = (a: unknown, b: unknown): boolean =>
  a === b || canonicalJson(a) === canonicalJson(b);

/**
 * 3-way diff of a block document by top-level unit (block) id, for conflict
 * reporting after a failed preview merge. Pure.
 *
 * A unit conflicts when BOTH sides changed it relative to base (edit/edit,
 * edit/delete, or both-added-differently) and the two sides disagree. A
 * one-sided change is not a conflict (git would have auto-merged it — the
 * report only names what genuinely needs a human/agent decision).
 *
 * The top-level ordering is compared as id sequences the same way: reordered
 * differently on both sides → one sentinel `__order__` unit whose ours/theirs/
 * base carry the id arrays. Nested children ride inside their parent unit
 * (deep-equal covers the whole subtree).
 */
export function diffBlockUnits(
  base: BlockNode[],
  ours: BlockNode[],
  theirs: BlockNode[]
): PreviewConflictUnit[] {
  const byId = (blocks: BlockNode[]): Map<string, { block: BlockNode; index: number }> => {
    const map = new Map<string, { block: BlockNode; index: number }>();
    blocks.forEach((block, index) => {
      if (block && typeof block.id === 'string' && !map.has(block.id)) {
        map.set(block.id, { block, index });
      }
    });
    return map;
  };

  const baseMap = byId(base);
  const oursMap = byId(ours);
  const theirsMap = byId(theirs);

  const seen = new Set<string>();
  const orderedIds = [...theirsMap.keys(), ...oursMap.keys(), ...baseMap.keys()].filter(id => {
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });

  const units: PreviewConflictUnit[] = [];
  for (const id of orderedIds) {
    const inBase = baseMap.get(id);
    const inOurs = oursMap.get(id);
    const inTheirs = theirsMap.get(id);

    const oursChanged = !deepEqual(inBase?.block, inOurs?.block);
    const theirsChanged = !deepEqual(inBase?.block, inTheirs?.block);
    if (!oursChanged || !theirsChanged) continue; // one-sided → auto-mergeable
    if (deepEqual(inOurs?.block, inTheirs?.block)) continue; // both sides agree

    units.push({
      id,
      index: inTheirs?.index ?? inOurs?.index ?? inBase?.index ?? -1,
      ...(inOurs ? { ours: inOurs.block } : {}),
      ...(inTheirs ? { theirs: inTheirs.block } : {}),
      ...(inBase ? { base: inBase.block } : {}),
    });
  }

  // Ordering conflict: both sides changed the top-level sequence, differently.
  const baseIds = idsOf(base);
  const oursIds = idsOf(ours);
  const theirsIds = idsOf(theirs);
  const oursOrderChanged = !deepEqual(baseIds, oursIds);
  const theirsOrderChanged = !deepEqual(baseIds, theirsIds);
  if (oursOrderChanged && theirsOrderChanged && !deepEqual(oursIds, theirsIds)) {
    units.push({
      id: ORDER_CONFLICT_ID,
      index: -1,
      ours: oursIds,
      theirs: theirsIds,
      base: baseIds,
    });
  }

  return units;
}

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
  const bMap = byId(b);
  const oMap = byId(o);
  const tMap = byId(t);

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
  return { merged, conflicts, autoMerged };
}
