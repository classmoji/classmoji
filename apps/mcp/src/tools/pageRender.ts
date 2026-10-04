/**
 * page_render — let an agent SEE a page it edits, and `render: true` on
 * page_content_apply.
 *
 * The page is rendered by the pages app's token-gated `/_render/page/:pageId`
 * (the class site's static BlockNote renderer, staff view), laid out 900px
 * wide and returned as JPEG chunks 1200px tall. Blocks the caller names are
 * outlined and located (top/bottom px, which chunk). See tools/render.ts for
 * the deck side and render/browser.ts for the browser.
 *
 * Tier: the READ gate of page_content_get (OWNER/TEACHER) — rendering is a
 * read. The route trusts only the view token minted after that gate.
 */

import { ClassmojiService } from '@classmoji/services';
import type { ViewAt } from '@classmoji/services/render-contract';
import { z } from 'zod';
import { liveSha, liveStateFor } from '../collab/client.ts';
import { ToolError } from '../mcp/errors.ts';
import type { ToolContext, ToolDefinition, ToolResult } from '../mcp/registry.ts';
import { RenderError } from '../render/browser.ts';
import { LruCache } from '../render/cache.ts';
import { imageBlocks } from '../render/deckAgent.ts';
import {
  PAGE_CHUNK_HEIGHT,
  PAGE_RENDER_WIDTH,
  renderPage,
  type PageLayout,
  type PageRenderResult,
} from '../render/pageRender.ts';
import { readLivePage, resolveReadRef } from './pageContent.ts';
import { loadPageWithRepoInClassroom, OWNER_TEACHER, type PageWithRepoRecord } from './shared.ts';

const RENDER_RATE_LIMIT = { capacity: 12, refillPerSecond: 0.2 };
const JPEG_QUALITY = 70;
const DEFAULT_CHUNKS = 3;
const MAX_CHUNKS = 6;

interface CachedPage {
  result: Omit<PageRenderResult, 'images' | 'backend'>;
  images: Map<number, string>;
}
const pageCache = new LruCache<CachedPage>(80);

export function clearPageRenderCache(): void {
  pageCache.clear();
}

function pagesOrigin(): string | null {
  const base =
    process.env.PAGES_URL?.trim() ||
    (process.env.NODE_ENV === 'production' ? '' : 'http://localhost:7100');
  return base ? base.replace(/\/+$/, '') : null;
}

interface BlockNodeLike {
  id?: unknown;
  children?: unknown;
}

/** Every block id in the tree. */
export function blockIdSet(blocks: unknown): Set<string> {
  const out = new Set<string>();
  const walk = (list: unknown) => {
    if (!Array.isArray(list)) return;
    for (const block of list as BlockNodeLike[]) {
      if (typeof block?.id === 'string') out.add(block.id);
      walk(block?.children);
    }
  };
  walk(blocks);
  return out;
}

/** Which copy, the page's blocks there, and their version. */
export async function readPageForRender(
  page: PageWithRepoRecord,
  at: ViewAt,
  viewerId: string
): Promise<{ blocks: unknown; version: string | null; note?: string }> {
  const ref = await resolveReadRef(page, at);
  let note: string | undefined;
  const liveState = liveStateFor(page.classroom);
  if (liveState && !ref) {
    const live = await readLivePage(liveState.env, page, viewerId);
    if ('snapshot' in live) {
      return {
        blocks: live.snapshot.content.blocks,
        version: liveSha(live.snapshot.epoch, live.snapshot.version),
      };
    }
    if (live.fallbackNote) note = live.fallbackNote;
  }
  const content = await ClassmojiService.pageContent.loadPageContent(page, {
    skipCache: true,
    ...(ref ? { ref } : {}),
  });
  if (content.format !== 'json') {
    throw new ToolError(
      'invalid_params',
      content.format === 'html'
        ? 'This page still stores legacy HTML, so it cannot be rendered — open it once in the editor.'
        : 'This page has no content yet — nothing to render.'
    );
  }
  return { blocks: content.blocks, version: content.sha ?? null, ...(note ? { note } : {}) };
}

/** The 1-based chunks a block spans. */
export function chunksOf(box: { top: number; bottom: number }, chunkHeight: number): number[] {
  const first = Math.floor(Math.max(0, box.top) / chunkHeight) + 1;
  const last = Math.floor(Math.max(0, box.bottom - 1) / chunkHeight) + 1;
  const out: number[] = [];
  for (let n = first; n <= last; n += 1) out.push(n);
  return out;
}

/** Chunks to capture: from `start`, or the ones holding the blocks, capped. */
export function chooseChunks(
  layout: PageLayout,
  options: { start?: number; max: number; byBlocks: boolean }
): number[] {
  if (options.start || !options.byBlocks || layout.blocks.length === 0) {
    const from = Math.min(Math.max(1, options.start ?? 1), layout.chunks);
    const out: number[] = [];
    for (let n = from; n <= layout.chunks && out.length < options.max; n += 1) out.push(n);
    return out;
  }
  const wanted = new Set<number>();
  for (const box of layout.blocks) for (const n of chunksOf(box, PAGE_CHUNK_HEIGHT)) wanted.add(n);
  return [...wanted].sort((a, b) => a - b).slice(0, options.max);
}

function keyVersion(classroom: { content_key_version?: unknown }): number {
  const v = Number(classroom.content_key_version ?? 0);
  return Number.isSafeInteger(v) && v >= 0 ? v : 0;
}

/** Shared body of page_render and page_content_apply's `render: true`. */
export async function pageRenderResult(
  page: PageWithRepoRecord,
  read: { blocks: unknown; version: string | null; note?: string },
  at: ViewAt,
  blockIds: string[],
  options: { start?: number; max: number }
): Promise<{ payload: Record<string, unknown>; images: string[] }> {
  const started = Date.now();
  const cacheKey =
    read.version && read.version !== 'unknown'
      ? `${page.id}|${read.version}|${at}|${[...blockIds].sort().join(',')}`
      : null;
  const byBlocks = blockIds.length > 0;

  let cached = cacheKey ? pageCache.get(cacheKey) : undefined;
  let chunks = cached ? chooseChunks(cached.result, { ...options, byBlocks }) : [];
  const hit = cached;
  const fromCache = Boolean(hit && chunks.every(n => hit.images.has(n)));

  if (!fromCache) {
    const origin = pagesOrigin();
    if (!origin) {
      throw new ToolError(
        'internal',
        'Rendering is not configured here (PAGES_URL is unset).',
        'RENDER_UNAVAILABLE'
      );
    }
    let result: PageRenderResult;
    try {
      result = await renderPage({
        origin,
        pageId: page.id,
        classroomId: page.classroom_id,
        keyVersion: keyVersion(page.classroom as { content_key_version?: unknown }),
        at,
        pin: read.version,
        blockIds,
        chooseChunks: layout => {
          chunks = chooseChunks(layout, { ...options, byBlocks });
          return chunks;
        },
        quality: JPEG_QUALITY,
      });
    } catch (error) {
      if (error instanceof RenderError) throw new ToolError('internal', error.message, error.code);
      throw new ToolError(
        'internal',
        `The page could not be rendered: ${error instanceof Error ? error.message : String(error)}`,
        'RENDER_FAILED'
      );
    }
    const { images, backend: _backend, ...rest } = result;
    const key =
      result.version !== 'unknown'
        ? `${page.id}|${result.version}|${at}|${[...blockIds].sort().join(',')}`
        : null;
    const prior = key ? pageCache.get(key) : undefined;
    const merged = new Map([...(prior?.images ?? []), ...images]);
    cached = { result: rest, images: merged };
    if (key) pageCache.set(key, cached);
  }
  if (!cached) throw new ToolError('internal', 'The page could not be rendered', 'RENDER_FAILED');
  const entry = cached;
  const layout = entry.result;
  const notes: string[] = [];
  if (read.note) notes.push(read.note);
  if (read.version && layout.version !== read.version) {
    notes.push(`The page changed after it was read (${read.version}); this is ${layout.version}.`);
  }
  const located = new Set(layout.blocks.map(b => b.id));
  const missing = blockIds.filter(id => !located.has(id));

  const images = chunks.map(n => entry.images.get(n)).filter((x): x is string => Boolean(x));
  const payload: Record<string, unknown> = {
    page_id: page.id,
    at,
    version: layout.version,
    width_px: PAGE_RENDER_WIDTH,
    height_px: layout.height,
    chunk_height_px: PAGE_CHUNK_HEIGHT,
    total_chunks: layout.chunks,
    chunks: chunks.map(n => ({
      chunk: n,
      from_px: (n - 1) * PAGE_CHUNK_HEIGHT,
      to_px: Math.min(n * PAGE_CHUNK_HEIGHT, layout.height),
    })),
    ...(layout.blocks.length
      ? {
          blocks: layout.blocks.map(b => ({
            block_id: b.id,
            top_px: b.top,
            bottom_px: b.bottom,
            chunk: chunksOf(b, PAGE_CHUNK_HEIGHT)[0],
          })),
        }
      : {}),
    ...(missing.length ? { not_rendered: missing } : {}),
    ...(layout.clipped.length ? { clipped: layout.clipped } : {}),
    ...(layout.overflowX > 0 ? { overflow_x_px: layout.overflowX } : {}),
    cached: fromCache,
    ms: Date.now() - started,
    ...(notes.length ? { note: notes.join(' ') } : {}),
  };
  return { payload, images };
}

function withImages(payload: Record<string, unknown>, images: string[]): ToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }, ...imageBlocks(images)],
  };
}

interface PageRenderArgs {
  classroom: string;
  page_id: string;
  at?: 'main' | 'live' | 'preview';
  block_ids?: string[];
  chunk?: number;
  max_chunks?: number;
}

export const pageRenderTool: ToolDefinition<PageRenderArgs> = {
  name: 'page_render',
  title: 'Render a page',
  rateLimit: RENDER_RATE_LIMIT,
  description:
    'Renders a page so you can SEE it: the page as readers see it (cover, title, every block, ' +
    `images) laid out ${PAGE_RENDER_WIDTH}px wide, returned as JPEG chunks ` +
    `${PAGE_CHUNK_HEIGHT}px tall, top first. block_ids outlines those blocks in orange and ` +
    'reports where each sits (top/bottom px, chunk); without chunk you get the chunks that ' +
    'hold them. chunk + max_chunks (default 3, up to 6) page through a long page. Also ' +
    'reports boxes that hide content behind a scrollbar (wide code blocks, tables) and ' +
    'horizontal overflow. at: main (alias live) is the page itself, the live document when ' +
    'live editing is on; at: preview is the pending preview. Renders are cached per version.',
  scope: 'read',
  roles: OWNER_TEACHER,
  inputSchema: {
    classroom: z.string().describe("Classroom reference as 'org/slug'"),
    page_id: z.string().uuid().describe('Page id'),
    at: z
      .enum(['main', 'live', 'preview'])
      .optional()
      .describe("'main' (default; 'live' is the same) or the pending 'preview'"),
    block_ids: z
      .array(z.string().min(1))
      .min(1)
      .max(20)
      .optional()
      .describe('Blocks to outline and locate (ids from page_content_outline)'),
    chunk: z.number().int().min(1).optional().describe('First chunk to return (1-based)'),
    max_chunks: z
      .number()
      .int()
      .min(1)
      .max(MAX_CHUNKS)
      .optional()
      .describe(`How many chunks (default ${DEFAULT_CHUNKS})`),
  },
  handler: async (args, ctx) => {
    const page = await loadPageWithRepoInClassroom(args.page_id, ctx);
    const at: ViewAt = args.at === 'preview' ? 'preview' : 'main';
    const read = await readPageForRender(page, at, ctx.viewer.userId);
    const known = blockIdSet(read.blocks);
    for (const id of args.block_ids ?? []) {
      if (!known.has(id)) {
        throw new ToolError(
          'invalid_params',
          `Unknown block id '${id}' — call page_content_outline for current ids`
        );
      }
    }
    const { payload, images } = await pageRenderResult(page, read, at, args.block_ids ?? [], {
      ...(args.chunk ? { start: args.chunk } : {}),
      max: args.max_chunks ?? DEFAULT_CHUNKS,
    });
    return withImages(payload, images);
  },
};

/** The block ids an apply's result says it changed (deleted ones aside). */
export function changedBlockIds(payload: Record<string, unknown>): string[] {
  const out: string[] = [];
  const add = (id: unknown) => {
    if (typeof id === 'string' && !out.includes(id)) out.push(id);
  };
  for (const entry of (Array.isArray(payload.applied) ? payload.applied : []) as Array<
    Record<string, unknown>
  >) {
    if (entry.op !== 'delete' && entry.op !== 'replace_all') add(entry.id);
    if (Array.isArray(entry.ids)) entry.ids.forEach(add);
    for (const r of (entry.reminted_ids as Array<{ to?: unknown }> | undefined) ?? []) add(r.to);
  }
  const inserted = payload.inserted_ids;
  if (Array.isArray(inserted)) for (const group of inserted) [group].flat().forEach(add);
  return out;
}

/**
 * page_content_apply with `render: true`: the apply's own result plus a
 * `render` block — the chunks holding the changed blocks, outlined. A render
 * that fails never fails the apply.
 */
export async function renderAfterPageApply(
  result: ToolResult,
  pageId: string,
  ctx: ToolContext
): Promise<ToolResult> {
  if (result.isError) return result;
  const first = result.content[0];
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(first?.type === 'text' ? first.text : '{}') as Record<string, unknown>;
  } catch {
    return result;
  }
  try {
    const page = await loadPageWithRepoInClassroom(pageId, ctx);
    const at: ViewAt = payload.committed_to === 'preview' ? 'preview' : 'main';
    const read = await readPageForRender(page, at, ctx.viewer.userId);
    const known = blockIdSet(read.blocks);
    const changed = changedBlockIds(payload)
      .filter(id => known.has(id))
      .slice(0, 20);
    const { payload: render, images } = await pageRenderResult(page, read, at, changed, {
      max: 2,
    });
    const { page_id: _pageId, ...rest } = render;
    return withImages({ ...payload, render: rest }, images);
  } catch (error) {
    return withImages(
      { ...payload, render_error: error instanceof Error ? error.message : String(error) },
      []
    );
  }
}
