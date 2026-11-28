/**
 * The PAGE adapter: BlockNote pages (`pages/<slug>/content.json`).
 *
 * A legacy page (only `pages/<slug>/index.html`) is NOT converted here: its
 * room is refused (`legacy-html`, 422) before anything is seeded or stored,
 * and so is an outside push that leaves a page as HTML only. Legacy pages are
 * converted by the operator script (`packages/tasks/src/scripts/
 * convertLegacyPages.ts`); collab never loads `@classmoji/page-html`,
 * `@blocknote/server-util` or jsdom (`scripts/check-no-dom-runtime.mjs
 * --entry apps/collab/src/index.ts` enforces it).
 *
 * Edit rule: today's — OWNER or TEACHER in the page's classroom
 * (`findClassroomRole`, highest role wins), the classroom mutation gate
 * (`canMutateClassroom`: LOCKED / UNPUBLISHED are owner-only), and
 * `classroom.collab_enabled`.
 */
import type * as Y from 'yjs';
import type { Role } from '@classmoji/database/client';
import { ClassmojiService, ContentService } from '@classmoji/services';
import { canMutateClassroom } from '@classmoji/auth/predicates';
import { canEditPages, findClassroomRole } from '@classmoji/auth/classroom-role';
import { SCHEMA_VERSION, parsePageContent, type PageCoverImage } from '@classmoji/page-schema';
import { pageContentToYDoc, yDocToBlocks } from '@classmoji/page-schema/server';
import type { PageSnapshotContent } from '@classmoji/collab';
import { itemHash, pageView } from '@classmoji/collab/hash';
import { AGENT_TOUCHED_MAX } from '@classmoji/collab';
import { reportError } from '@classmoji/utils/error-report';

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
import { parseOpsPayload } from './parseOps.ts';

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
  /**
   * content.json at the default branch, or at `ref` (`format: 'html'` when
   * git holds the page as legacy index.html only, which is refused).
   */
  loadContent(page: PageRecord, options: { ref?: string }): Promise<LoadedContent>;
  /** A blob's text by sha, null when it does not exist. */
  readBlob(page: PageRecord, sha: string): Promise<string | null>;
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

/**
 * The refusal for a page git holds as legacy HTML (index.html, no
 * content.json): the socket's `legacy-html` reason, 422 on the internal API.
 * Nothing is converted, seeded or stored for it.
 */
function legacyHtmlRefusal(what: string): CollabHttpError {
  return new CollabHttpError(422, {
    error: 'legacy-html',
    message: `${what} is a legacy HTML page (index.html, no content.json); it is not edited live until it is converted`,
  });
}

/**
 * `deps.loadContent` with a content.json that exists but does not parse
 * (`PageContentFormatError`) answered as a final 422 `invalid-content`: a
 * retry reads the same file. Matched by name, so a second copy of the
 * services module (tests, bundles) is recognised too.
 */
async function loadOrRefuse(
  deps: PageAdapterDeps,
  page: PageRecord,
  options: { ref?: string },
  what: string
): Promise<LoadedContent> {
  try {
    return await deps.loadContent(page, options);
  } catch (err) {
    if (err instanceof Error && err.name === 'PageContentFormatError') {
      throw new CollabHttpError(422, {
        error: 'invalid-content',
        message: `${what}: content.json exists but is not valid JSON`,
      });
    }
    throw err;
  }
}

export function createPageAdapter(
  deps: PageAdapterDeps = defaultPageAdapterDeps
): CollabAdapter<'page', BlockOp> {
  async function mustFindPage(pageId: string): Promise<PageRecord> {
    const page = await deps.findPage(pageId);
    if (!page) throw new CollabHttpError(404, { error: 'not-found' });
    return page;
  }

  /** content.json at `loadContent` → blocks + cover; legacy HTML and no file are refused. */
  function contentOf(loaded: LoadedContent, what: string): PageContentRaw {
    if (loaded.format === 'json') {
      return { blocks: (loaded.blocks as PageBlock[]) ?? [], cover: loaded.coverImage ?? null };
    }
    if (loaded.format === 'html') throw legacyHtmlRefusal(what);
    throw new CollabHttpError(409, {
      error: 'content-missing',
      message: `${what} has no content file`,
    });
  }

  /** A blob the live doc descends from, as content.json; null when it is not one. */
  function contentOfBlob(text: string): PageContentRaw | null {
    try {
      const parsed = parsePageContent(text);
      return { blocks: parsed.blocks as PageBlock[], cover: parsed.coverImage ?? null };
    } catch (err) {
      if (err instanceof SyntaxError) return null;
      throw err;
    }
  }

  return {
    kind: 'page',
    schemaVersion: SCHEMA_VERSION,

    async authorize({ userId, docId }): Promise<AuthorizeResult> {
      const page = await deps.findPage(docId);
      if (!page) return { ok: false, reason: 'not-found' };
      const role = await deps.findRole(userId, page.classroom_id);
      // A refusal is audited in the page's classroom: a member's with their
      // role, someone who holds none there as the classroom's non-member row.
      const member = { classroomId: page.classroom_id, role: role ?? null };
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
      const loaded = await loadOrRefuse(deps, page, {}, `page ${docId}`);
      if (loaded.format === 'none') {
        // How the pages app creates a page: no files until the first save.
        const doc = pageContentToYDoc({
          blocks: pageContent.blankPageBlocks(),
          coverImage: legacyCover(page),
        });
        return { doc, sourceSha: null, classroomId: page.classroom_id };
      }
      // Legacy HTML (index.html, no content.json) is refused here, before the
      // caller inserts anything: no row, no checkpoint, no empty content.json.
      const { blocks, cover: fileCover } = contentOf(loaded, `page ${docId}`);
      // A page whose content.json has no cover keeps it in the DB columns:
      // seed it the way the pages loader falls back, so it doesn't vanish.
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
      const parsed = parseOpsPayload(pageContent.pageBlockOpsPayloadSchema, raw, 'page ops');
      if (!parsed.success) {
        throw new CollabHttpError(400, { error: 'invalid-ops', issues: parsed.issues });
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

      // theirs: content.json at the pushed commit. A push that leaves the
      // page as legacy HTML only (`legacy-html`), or a content.json that does
      // not parse (`invalid-content`), is refused with a 422: the live doc is
      // kept.
      const theirsLoaded = await loadOrRefuse(
        deps,
        page,
        { ref: sha },
        `page ${page.id} at ${sha}`
      );

      // Already ours (our own push, a replay, an older push): nothing to do.
      if (theirsLoaded.sha && theirsLoaded.sha === ctx.row?.source_sha) {
        return { sourceSha: theirsLoaded.sha, conflicts: 0, noop: true };
      }
      const theirsRaw = contentOf(theirsLoaded, `page ${page.id} at ${sha}`);

      // base: content.json at `before` (exactly the outside change), else the
      // blob the live doc descends from. Legacy HTML is no base: it is read
      // as unreadable, and without another base the push is not merged.
      let baseRaw: PageContentRaw | null = null;
      // No content file before the push (a page created outside after a
      // blank start, or the live doc was seeded blank): the true merge base
      // is EMPTY — both sides' blocks are additions, nothing is a deletion.
      const empty = { blocks: [] as PageBlock[], cover: null };
      if (before && !/^0+$/.test(before)) {
        try {
          const loaded = await deps.loadContent(page, { ref: before });
          if (loaded.format === 'json') {
            baseRaw = contentOf(loaded, `page ${page.id} at ${before}`);
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
        if (text != null) baseRaw = contentOfBlob(text);
      }
      // Seeded blank (no source file ever) and nothing readable at `before`.
      if (!baseRaw && ctx.row && !baseSha && !ctx.row.pushed_commit) baseRaw = empty;
      if (!baseRaw) {
        // Taking theirs wholesale would revert every live edit. Keep the live
        // doc and refuse; the caller retries / alerts.
        console.error(
          `[collab] OUTSIDE PUSH NOT MERGED: page ${page.id} has no readable merge base (before=${before ?? '-'}, source_sha=${baseSha ?? '-'}); live doc kept`
        );
        const refusal = new CollabHttpError(409, {
          error: 'no-merge-base',
          message: 'No readable merge base for the outside push; the live page was kept',
        });
        // The outside change stays out of the live page until someone acts.
        reportError(refusal, {
          surface: 'collab.external_merge',
          tags: { kind: 'page', doc_id: page.id },
        });
        throw refusal;
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
