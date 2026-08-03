import { createHash } from 'node:crypto';
import { classroomContentRepoName } from '@classmoji/utils';
import { ContentService } from '../content/ContentService.ts';

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
 */
export async function loadPageContent(
  page: PageWithContentRepo,
  { skipCache = false }: { skipCache?: boolean } = {}
): Promise<PageContentResult> {
  const { gitOrganization, repo } = contentRepoFor(page);

  // Try JSON first (BlockNote format)
  try {
    const jsonResult = await ContentService.getContent({
      gitOrganization,
      repo,
      path: `${page.content_path}/content.json`,
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
 * Unknown ids throw a BlockOpError naming the id (code UNKNOWN_BLOCK_ID).
 */
export function applyBlockOps(blocks: unknown[], ops: BlockOp[]): unknown[] {
  let doc = structuredClone(blocks) as BlockNode[];

  for (const op of ops) {
    switch (op.op) {
      case 'update': {
        const target = mustFindBlock(doc, op.id, 'update');
        const replacement = structuredClone(op.block) as BlockNode;
        replacement.id = op.id; // id preserved regardless of the payload
        target.parent[target.index] = replacement;
        break;
      }

      case 'insert': {
        insertBlocksAt(doc, structuredClone(op.blocks) as BlockNode[], op.position, 'insert');
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
        break;
      }

      default:
        throw new BlockOpError(`Unknown op '${(op as { op?: string }).op}'`, 'INVALID_OP');
    }
  }

  return doc;
}
