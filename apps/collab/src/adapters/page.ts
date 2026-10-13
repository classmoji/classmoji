/**
 * The PAGE adapter: BlockNote pages (`pages/<slug>/content.json`).
 *
 * A legacy page (only `pages/<slug>/index.html`) is converted on its first
 * live open (`htmlToPageBlocks`) and seeded with `source_sha` = index.html's
 * blob: the checkpoint worker compares content.json first and index.html
 * second, so the first checkpoint after an edit creates content.json beside
 * index.html and records ITS blob as `source_sha` from then on.
 *
 * Edit rule: today's — OWNER or TEACHER in the page's classroom
 * (`findClassroomRole`, highest role wins), the classroom mutation gate
 * (`canMutateClassroom`: LOCKED / UNPUBLISHED are owner-only), and
 * `classroom.collab_enabled`.
 */
import type * as Y from 'yjs';
import type { Role } from '@prisma/client';
import { ClassmojiService, ContentService } from '@classmoji/services';
import { canMutateClassroom } from '@classmoji/auth/predicates';
import { canEditPages, findClassroomRole } from '@classmoji/auth/classroom-role';
import { SCHEMA_VERSION, parsePageContent, type PageCoverImage } from '@classmoji/page-schema';
import {
  htmlToPageBlocks,
  pageContentToYDoc,
  yDocToBlocks,
  type HtmlToPageBlocksOptions,
} from '@classmoji/page-schema/server';
import type { PageSnapshotContent } from '@classmoji/collab';
import { itemHash, pageView } from '@classmoji/collab/hash';
import { AGENT_TOUCHED_MAX } from '@classmoji/collab';

import {
  CollabHttpError,
  type ApplyOpsResult,
  type AuthorizeResult,
  type CollabAdapter,
  type ExternalMergeResult,
  type LiveEditContext,
  type MergePreviewResult,
  type SeedResult,
} from './types.ts';
import {
  assertConvertible,
  assertReadable,
  brokenColumnLists,
  nonEmpty,
  readCover,
  reconcileBlocks,
  throughSchema,
  unwrapBrokenColumnLists,
  writeCover,
  type PageBlock,
} from './pageDoc.ts';
import { findBlockElement, pageCursor } from './pageCursor.ts';

const pageContent = ClassmojiService.pageContent;
type BlockOp = Parameters<typeof pageContent.applyBlockOps>[1][number];

/**
 * What a batch of page ops inserted or changed and is still in the page, in
 * op order (an id touched twice counts where it was touched last), at most
 * AGENT_TOUCHED_MAX — and the block the agent's caret goes to: the one the
 * last op that wrote anything wrote last.
 */
export function touchedBlocks(
  ops: BlockOp[],
  remints: Map<string, string>,
  next: PageBlock[]
): { touchedIds?: string[]; cursorBlockId?: string } {
  const present = new Set<string>();
  const index = (blocks: PageBlock[]) => {
    for (const block of blocks) {
      if (block?.id) present.add(block.id);
      if (Array.isArray(block?.children)) index(block.children);
    }
  };
  index(next);
  const order: string[] = [];
  const touch = (id: string | undefined) => {
    if (!id) return;
    const at = order.indexOf(id);
    if (at !== -1) order.splice(at, 1);
    order.push(id);
  };
  let cursorBlockId: string | undefined;
  ops.forEach((op, i) => {
    if (op.op === 'insert') {
      for (const block of op.blocks as PageBlock[]) {
        const id = block.id ? (remints.get(`${i}:${block.id}`) ?? block.id) : undefined;
        touch(id);
        cursorBlockId = id ?? cursorBlockId;
      }
    } else if (op.op === 'update' || op.op === 'move') {
      touch(op.id);
      cursorBlockId = op.id;
    } else if (op.op === 'replace_all') {
      order.length = 0;
      const blocks = pageContent.ensureBlockIds(op.blocks) as PageBlock[];
      for (const block of blocks) touch(block.id);
      cursorBlockId = blocks.at(-1)?.id ?? cursorBlockId;
    }
  });
  const ids = order.filter(id => present.has(id)).slice(-AGENT_TOUCHED_MAX);
  return {
    ...(ids.length > 0 ? { touchedIds: ids } : {}),
    ...(cursorBlockId && present.has(cursorBlockId) ? { cursorBlockId } : {}),
  };
}

/** The page row the adapter needs (a `page.findById` with its classroom). */
export interface PageRecord {
  id: string;
  title: string;
  content_path: string;
  classroom_id: string;
  header_image_url?: string | null;
  header_image_position?: number | null;
  classroom: {
    id: string;
    slug?: string;
    status: string;
    collab_enabled: boolean;
    content_repo: string;
    git_organization?: { login: string; provider: string; [key: string]: unknown } | null;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

type LoadedContent = Awaited<ReturnType<typeof pageContent.loadPageContent>>;

/** I/O the adapter does; swapped out in tests. */
export interface PageAdapterDeps {
  findPage(pageId: string): Promise<PageRecord | null>;
  findRole(userId: string, classroomId: string): Promise<Role | null>;
  /** content.json (or legacy index.html) at the default branch, or at `ref`. */
  loadContent(page: PageRecord, options: { ref?: string }): Promise<LoadedContent>;
  /** A blob's text by sha, null when it does not exist. */
  readBlob(page: PageRecord, sha: string): Promise<string | null>;
  /** Legacy index.html -> blocks. Default `htmlToPageBlocks`; swapped out in tests. */
  convertHtml?(html: string, options: HtmlToPageBlocksOptions): Promise<unknown[]>;
}

export const defaultPageAdapterDeps: PageAdapterDeps = {
  async findPage(pageId) {
    return (await ClassmojiService.page.findById(pageId, {
      includeClassroom: true,
    })) as unknown as PageRecord | null;
  },
  findRole(userId, classroomId) {
    return findClassroomRole({ userId, classroomId });
  },
  loadContent(page, { ref }) {
    return pageContent.loadPageContent(page as never, { skipCache: true, ...(ref ? { ref } : {}) });
  },
  async readBlob(page, sha) {
    const blob = await ContentService.getBlobContent({
      gitOrganization: page.classroom.git_organization as never,
      repo: page.classroom.content_repo,
      sha,
    });
    return blob?.content ?? null;
  },
};

function blocksOf(doc: Y.Doc): PageBlock[] {
  return yDocToBlocks(doc) as PageBlock[];
}

/** The cover a legacy page keeps only in its DB columns (the pages loader's fallback). */
function legacyCover(page: PageRecord): PageCoverImage | null {
  return page.header_image_url
    ? { url: page.header_image_url, position: page.header_image_position ?? 50 }
    : null;
}

function arrayOf(value: unknown): unknown[] {
  if (!Array.isArray(value)) {
    throw new CollabHttpError(400, {
      error: 'invalid-content',
      message: 'blocks must be an array',
    });
  }
  return value;
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/** The chooser's `[{ id, choose }]` → merge3Blocks' `{ [id]: choice }`. */
function resolutionsRecord(resolutions: unknown): Record<string, 'ours' | 'theirs'> {
  if (resolutions == null) return {};
  if (!Array.isArray(resolutions)) {
    throw new CollabHttpError(400, {
      error: 'invalid-resolutions',
      message: 'resolutions must be an array',
    });
  }
  const out: Record<string, 'ours' | 'theirs'> = {};
  for (const entry of resolutions as { id?: unknown; choose?: unknown }[]) {
    if (
      !entry ||
      typeof entry.id !== 'string' ||
      (entry.choose !== 'ours' && entry.choose !== 'theirs')
    ) {
      throw new CollabHttpError(400, {
        error: 'invalid-resolutions',
        message: "each resolution is { id, choose: 'ours' | 'theirs' }",
      });
    }
    out[entry.id] = entry.choose;
  }
  return out;
}

function asHttpError(err: unknown): never {
  if (err instanceof pageContent.BlockOpError) {
    throw new CollabHttpError(422, { error: 'invalid-op', code: err.code, message: err.message });
  }
  throw err;
}

type PageContentRaw = { blocks: PageBlock[]; cover: PageCoverImage | null };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function withoutIds(blocks: unknown[]): PageBlock[] {
  return blocks.map(raw => {
    const { id: _id, children, ...rest } = raw as PageBlock;
    return {
      ...rest,
      ...(Array.isArray(children) ? { children: withoutIds(children) } : {}),
    } as PageBlock;
  });
}

export function createPageAdapter(
  deps: PageAdapterDeps = defaultPageAdapterDeps
): CollabAdapter<'page', BlockOp> {
  const convert = deps.convertHtml ?? htmlToPageBlocks;

  async function mustFindPage(pageId: string): Promise<PageRecord> {
    const page = await deps.findPage(pageId);
    if (!page) throw new CollabHttpError(404, { error: 'not-found' });
    return page;
  }

  /**
   * Legacy page HTML -> blocks. Old `/<slug>/pages/<id>` links are rewritten
   * only to a page of THIS page's classroom (looked up by the row's own
   * classroom, never by the slug in the content), at this classroom's address.
   *
   * The converter gives every block a fresh uuid; those are dropped for the
   * content-derived ids `ensureBlockIds` gives, so the same HTML always reads
   * as the same ids: a snapshot of a page nobody has open (seeded, not
   * stored) names the blocks the stored seed will have, and an outside
   * merge's base shares its blocks with the live doc seeded from that HTML.
   * The deck adapter names legacy slides the same way (`legacyIdGen`).
   *
   * Throws `legacy-html` (422) when the converter itself fails.
   */
  async function convertLegacy(page: PageRecord, html: string, what: string): Promise<PageBlock[]> {
    const resolvePageLink = async (linkSlug: string, pageId: string) => {
      if (!UUID.test(pageId)) return null;
      const target = await deps.findPage(pageId);
      if (!target || target.classroom_id !== page.classroom_id) return null;
      return `/${page.classroom.slug ?? linkSlug}/${pageId}`;
    };
    try {
      // One conversion at a time per process: the converter queues itself.
      const blocks = await convert(html, { title: page.title, resolvePageLink });
      return pageContent.ensureBlockIds(withoutIds(blocks)) as PageBlock[];
    } catch (err) {
      console.error(`[collab] ${what}: legacy HTML could not be converted:`, err);
      throw new CollabHttpError(422, {
        error: 'legacy-html',
        message: `${what} is a legacy HTML page that could not be converted for live editing`,
      });
    }
  }

  /** Content at `loadContent` → blocks + cover (legacy HTML converted), or a refusal. */
  async function contentOf(
    page: PageRecord,
    loaded: LoadedContent,
    what: string
  ): Promise<PageContentRaw> {
    if (loaded.format === 'json') {
      return { blocks: (loaded.blocks as PageBlock[]) ?? [], cover: loaded.coverImage ?? null };
    }
    if (loaded.format === 'html') {
      return { blocks: await convertLegacy(page, String(loaded.blocks ?? ''), what), cover: null };
    }
    throw new CollabHttpError(409, {
      error: 'content-missing',
      message: `${what} has no content file`,
    });
  }

  /**
   * A blob the live doc descends from: content.json text, or the legacy
   * index.html a converted doc was seeded from. Null when it is neither.
   */
  async function contentOfBlob(page: PageRecord, text: string): Promise<PageContentRaw | null> {
    let parsed: ReturnType<typeof parsePageContent> | null = null;
    try {
      parsed = parsePageContent(text);
    } catch (err) {
      if (!(err instanceof SyntaxError)) throw err;
    }
    if (parsed) return { blocks: parsed.blocks as PageBlock[], cover: parsed.coverImage ?? null };
    try {
      return await contentOf(
        page,
        { format: 'html', blocks: text, coverImage: null, sha: null },
        `page ${page.id} base`
      );
    } catch {
      return null;
    }
  }

  return {
    kind: 'page',
    schemaVersion: SCHEMA_VERSION,

    async authorize({ userId, docId }): Promise<AuthorizeResult> {
      const page = await deps.findPage(docId);
      if (!page) return { ok: false, reason: 'not-found' };
      const role = await deps.findRole(userId, page.classroom_id);
      // A member's refusal is audited (classroomId + role); a non-member's isn't.
      const member = role ? { classroomId: page.classroom_id, role } : {};
      if (!page.classroom.collab_enabled)
        return { ok: false, reason: 'collab-disabled', ...member };
      if (!canEditPages(role)) return { ok: false, reason: 'forbidden', ...member };
      if (!canMutateClassroom({ status: page.classroom.status as never, role: role! })) {
        return { ok: false, reason: 'classroom-locked', ...member };
      }
      return { ok: true, classroomId: page.classroom_id, role: role! };
    },

    async locate(docId) {
      const page = await deps.findPage(docId);
      return page
        ? { classroomId: page.classroom_id, collabEnabled: page.classroom?.collab_enabled === true }
        : null;
    },

    async seed({ docId }): Promise<SeedResult> {
      const page = await mustFindPage(docId);
      const loaded = await deps.loadContent(page, {});
      if (loaded.format === 'none') {
        // How the pages app creates a page: no files until the first save.
        const doc = pageContentToYDoc({
          blocks: pageContent.blankPageBlocks(),
          coverImage: legacyCover(page),
        });
        return { doc, sourceSha: null, classroomId: page.classroom_id };
      }
      // Legacy HTML is converted here, once: the row stores the result, and
      // its source_sha (index.html's blob, below) is what currentSourceSha
      // reads back while content.json does not exist, so a clean reopen is
      // served from the row, not converted or reseeded again.
      const { blocks, cover: fileCover } = await contentOf(page, loaded, `page ${docId}`);
      // Legacy pages keep the cover only in the DB columns: seed it the way
      // the pages loader falls back today, so it doesn't vanish from the editor.
      const cover = fileCover ?? legacyCover(page);
      // Deterministic ids for any id-less block — the ids MCP derives on read,
      // so an agent's ops name blocks the live doc actually has — and the
      // multi-column invariants restored, so the seed always opens.
      const prepared = nonEmpty(
        pageContent.normalizeBlockStructure(pageContent.ensureBlockIds(blocks)) as PageBlock[]
      );
      let doc: Y.Doc;
      try {
        doc = pageContentToYDoc({ blocks: prepared, coverImage: cover });
      } catch (err) {
        throw new CollabHttpError(422, {
          error: 'invalid-block',
          message: `page ${docId} content does not fit the page schema: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
      // For legacy HTML: index.html's blob. The checkpoint worker compares
      // content.json first and index.html second against it (expectBase), so
      // the first checkpoint creates content.json and records that blob.
      return { doc, sourceSha: loaded.sha, classroomId: page.classroom_id };
    },

    async currentSourceSha(docId) {
      const page = await mustFindPage(docId);
      const loaded = await deps.loadContent(page, {});
      return loaded.format === 'none' ? null : loaded.sha;
    },

    snapshot(doc): PageSnapshotContent {
      return { blocks: blocksOf(doc), coverImage: readCover(doc) };
    },

    parseOps(raw) {
      const parsed = pageContent.pageBlockOpsPayloadSchema.safeParse(raw);
      if (!parsed.success) {
        throw new CollabHttpError(400, { error: 'invalid-ops', issues: parsed.error.issues });
      }
      return parsed.data;
    },

    checkExpect(doc, expect) {
      const byId = new Map<string, PageBlock>();
      const index = (blocks: PageBlock[]) => {
        for (const block of blocks) {
          if (block?.id) byId.set(block.id, block);
          if (Array.isArray(block?.children)) index(block.children);
        }
      };
      index(blocksOf(doc));
      return Object.entries(expect)
        .filter(([id, hash]) => {
          const block = byId.get(id);
          return !block || itemHash(block) !== hash;
        })
        .map(([id]) => id);
    },

    itemView(doc) {
      return pageView({ blocks: blocksOf(doc) });
    },

    applyOps(ctx: LiveEditContext, rawOps): ApplyOpsResult {
      // Inserted blocks get their (deterministic) ids up front, so the ids
      // the response reports are the ones the doc ends up with.
      const ops = rawOps.map(op =>
        op.op === 'insert' ? { ...op, blocks: pageContent.ensureBlockIds(op.blocks) } : op
      );
      const result: ApplyOpsResult = {};
      ctx.transact(doc => {
        const current = blocksOf(doc);
        assertReadable(doc, current);
        const remints = new Map<string, string>();
        let next: PageBlock[];
        try {
          next = pageContent.ensureBlockIds(
            pageContent.applyBlockOps(current, ops, {
              onIdRemint: ({ op_index, from, to }) => remints.set(`${op_index}:${from}`, to),
            })
          ) as PageBlock[];
        } catch (err) {
          asHttpError(err);
        }
        const insertedIds: string[] = [];
        ops.forEach((op, i) => {
          if (op.op !== 'insert') return;
          for (const block of op.blocks as PageBlock[]) {
            if (block.id) insertedIds.push(remints.get(`${i}:${block.id}`) ?? block.id);
          }
        });
        if (insertedIds.length > 0) result.insertedIds = insertedIds;
        next = nonEmpty(next);
        Object.assign(result, touchedBlocks(ops, remints, next));
        // Presence shows at the block written last (a delete leaves it where it was).
        if (result.cursorBlockId) result.touchedId = result.cursorBlockId;
        // Every node is built once BEFORE the first write: a bad block is a
        // 422 with nothing written, never half a reconcile.
        assertConvertible(next, 'ops');
        reconcileBlocks(doc, current, next);
      });
      return result;
    },

    cursorAt(doc, point, selectTo, scope) {
      return pageCursor(doc, point, selectTo ?? null, scope ?? 'own');
    },

    hasItem(doc, id) {
      return findBlockElement(doc, id) !== null;
    },

    setCover(ctx, coverImage) {
      ctx.transact(doc => writeCover(doc, coverImage));
    },

    async mergeExternal(ctx, { sha, before }): Promise<ExternalMergeResult> {
      const page = await mustFindPage(ctx.ref.docId);
      const normalize = (blocks: unknown[]) =>
        pageContent.normalizeBlockStructure(pageContent.ensureBlockIds(blocks));

      // theirs: the content file at the pushed commit (legacy HTML converted).
      const theirsLoaded = await deps.loadContent(page, { ref: sha });

      // Already ours (our own push, a replay, an older push): nothing to do.
      if (theirsLoaded.sha && theirsLoaded.sha === ctx.row?.source_sha) {
        return { sourceSha: theirsLoaded.sha, conflicts: 0, noop: true };
      }
      const theirsRaw = await contentOf(page, theirsLoaded, `page ${page.id} at ${sha}`);

      // base: the file at `before` (exactly the outside change), else the
      // blob the live doc descends from. Either may be the legacy index.html
      // a converted doc was seeded from; it converts to the same ids.
      let baseRaw: PageContentRaw | null = null;
      // No content file before the push (a page created outside after a
      // blank start, or the live doc was seeded blank): the true merge base
      // is EMPTY — both sides' blocks are additions, nothing is a deletion.
      const empty = { blocks: [] as PageBlock[], cover: null };
      if (before && !/^0+$/.test(before)) {
        try {
          const loaded = await deps.loadContent(page, { ref: before });
          if (loaded.format === 'json' || loaded.format === 'html') {
            baseRaw = await contentOf(page, loaded, `page ${page.id} at ${before}`);
          } else if (loaded.format === 'none' && !ctx.row?.source_sha) {
            baseRaw = empty;
          }
        } catch (err) {
          console.warn(`[collab] page ${page.id}: base at ${before} unreadable:`, err);
        }
      }
      const baseSha = ctx.row?.source_sha;
      if (!baseRaw && baseSha) {
        const text = await deps.readBlob(page, baseSha);
        if (text != null) baseRaw = await contentOfBlob(page, text);
      }
      // Seeded blank (no source file ever) and nothing readable at `before`.
      if (!baseRaw && ctx.row && !baseSha && !ctx.row.pushed_commit) baseRaw = empty;
      if (!baseRaw) {
        // Taking theirs wholesale would revert every live edit. Keep the live
        // doc and refuse; the caller retries / alerts.
        console.error(
          `[collab] OUTSIDE PUSH NOT MERGED: page ${page.id} has no readable merge base (before=${before ?? '-'}, source_sha=${baseSha ?? '-'}); live doc kept`
        );
        throw new CollabHttpError(409, {
          error: 'no-merge-base',
          message: 'No readable merge base for the outside push; the live page was kept',
        });
      }

      const base = throughSchema(baseRaw.blocks, normalize, 'merge base');
      const theirs = throughSchema(theirsRaw.blocks, normalize, 'pushed content');

      let conflicts = 0;
      let conflictIds: string[] = [];
      // ours is read INSIDE the transaction, so typing that landed while the
      // files were fetched is part of the merge, not reverted by it.
      ctx.transact(doc => {
        const ours = blocksOf(doc);
        assertReadable(doc, ours);
        const result = pageContent.merge3Blocks(base, ours, theirs);
        conflicts = result.conflicts.length;
        conflictIds = result.conflicts.map(c => c.id);
        const merged = nonEmpty(normalize(result.merged) as PageBlock[]);
        assertConvertible(merged, 'merged content');
        reconcileBlocks(doc, ours, merged);
        if (JSON.stringify(theirsRaw.cover) !== JSON.stringify(baseRaw.cover)) {
          writeCover(doc, theirsRaw.cover);
        }
      });

      return {
        sourceSha: theirsLoaded.sha,
        conflicts,
        ...(conflictIds.length ? { conflictIds } : {}),
      };
    },

    mergePreview(ctx, { base, theirs, resolutions }): MergePreviewResult {
      const normalize = (blocks: unknown[]) =>
        pageContent.normalizeBlockStructure(pageContent.ensureBlockIds(blocks));
      const baseBlocks = throughSchema(arrayOf(base?.blocks), normalize, 'base');
      const theirsBlocks = throughSchema(arrayOf(theirs?.blocks), normalize, 'preview');
      const chosen = resolutionsRecord(resolutions);

      let result: MergePreviewResult = { conflicts: [] };
      ctx.transact(doc => {
        const ours = blocksOf(doc);
        assertReadable(doc, ours);
        const merge = pageContent.merge3Blocks(baseBlocks, ours, theirsBlocks, {
          resolutions: chosen,
        });
        if (merge.conflicts.length > 0) {
          result = { conflicts: merge.conflicts, autoMerged: merge.autoMerged };
          return; // nothing written
        }
        const merged = nonEmpty(normalize(merge.merged) as PageBlock[]);
        assertConvertible(merged, 'merged content');
        reconcileBlocks(doc, ours, merged);
        // Cover: today's accept rule — a preview-side change wins, anything
        // else keeps the live cover.
        const liveCover = readCover(doc);
        const baseCover = base?.coverImage ?? null;
        const theirsCover = theirs?.coverImage ?? null;
        if (sameJson(liveCover, baseCover) && !sameJson(theirsCover, baseCover)) {
          writeCover(doc, theirsCover);
        }
        result = { conflicts: [], autoMerged: merge.autoMerged };
      });
      return result;
    },

    repair(document, transact) {
      if (brokenColumnLists(document).length === 0) return false;
      let changed = false;
      transact(doc => {
        changed = unwrapBrokenColumnLists(doc);
      });
      return changed;
    },
  };
}
