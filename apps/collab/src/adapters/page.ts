/**
 * The PAGE adapter: BlockNote pages (`pages/<slug>/content.json`).
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
import { pageContentToYDoc, yDocToBlocks } from '@classmoji/page-schema/server';
import type { PageSnapshotContent } from '@classmoji/collab';
import { itemHash } from '@classmoji/collab/hash';

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

const pageContent = ClassmojiService.pageContent;
type BlockOp = Parameters<typeof pageContent.applyBlockOps>[1][number];

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

/** Content at `loadContent` → blocks + cover, or a refusal. */
function requireJson(
  loaded: LoadedContent,
  what: string
): { blocks: PageBlock[]; cover: PageCoverImage | null } {
  if (loaded.format === 'json') {
    return { blocks: (loaded.blocks as PageBlock[]) ?? [], cover: loaded.coverImage ?? null };
  }
  if (loaded.format === 'html') {
    throw new CollabHttpError(422, {
      error: 'legacy-html',
      message: `${what} is a legacy HTML page; migrate it to content.json before live editing`,
    });
  }
  throw new CollabHttpError(409, {
    error: 'content-missing',
    message: `${what} has no content file`,
  });
}

export function createPageAdapter(
  deps: PageAdapterDeps = defaultPageAdapterDeps
): CollabAdapter<'page', BlockOp> {
  async function mustFindPage(pageId: string): Promise<PageRecord> {
    const page = await deps.findPage(pageId);
    if (!page) throw new CollabHttpError(404, { error: 'not-found' });
    return page;
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
      return page ? { classroomId: page.classroom_id } : null;
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
      const { blocks, cover: jsonCover } = requireJson(loaded, `page ${docId}`);
      // Legacy pages keep the cover only in the DB columns: seed it the way
      // the pages loader falls back today, so it doesn't vanish from the editor.
      const cover = jsonCover ?? legacyCover(page);
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
          message: `page ${docId} content.json does not fit the page schema: ${err instanceof Error ? err.message : String(err)}`,
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
        const last = ops.at(-1);
        result.touchedId =
          last?.op === 'insert' ? insertedIds.at(-1) : last && 'id' in last ? last.id : undefined;
        next = nonEmpty(next);
        // Every node is built once BEFORE the first write: a bad block is a
        // 422 with nothing written, never half a reconcile.
        assertConvertible(next, 'ops');
        reconcileBlocks(doc, current, next);
      });
      return result;
    },

    setCover(ctx, coverImage) {
      ctx.transact(doc => writeCover(doc, coverImage));
    },

    async mergeExternal(ctx, { sha, before }): Promise<ExternalMergeResult> {
      const page = await mustFindPage(ctx.ref.docId);
      const normalize = (blocks: unknown[]) =>
        pageContent.normalizeBlockStructure(pageContent.ensureBlockIds(blocks));

      // theirs: the content file at the pushed commit.
      const theirsLoaded = await deps.loadContent(page, { ref: sha });
      const theirsRaw = requireJson(theirsLoaded, `page ${page.id} at ${sha}`);

      // Already ours (our own push, a replay, an older push): nothing to do.
      if (theirsLoaded.sha && theirsLoaded.sha === ctx.row?.source_sha) {
        return { sourceSha: theirsLoaded.sha, conflicts: 0, noop: true };
      }

      // base: the file at `before` (exactly the outside change), else the
      // blob the live doc descends from.
      let baseRaw: { blocks: PageBlock[]; cover: PageCoverImage | null } | null = null;
      if (before && !/^0+$/.test(before)) {
        try {
          const loaded = await deps.loadContent(page, { ref: before });
          if (loaded.format === 'json') {
            baseRaw = { blocks: loaded.blocks as PageBlock[], cover: loaded.coverImage ?? null };
          }
        } catch (err) {
          console.warn(`[collab] page ${page.id}: base at ${before} unreadable:`, err);
        }
      }
      const baseSha = ctx.row?.source_sha;
      if (!baseRaw && baseSha) {
        const text = await deps.readBlob(page, baseSha);
        if (text != null) {
          const parsed = parsePageContent(text);
          baseRaw = { blocks: parsed.blocks as PageBlock[], cover: parsed.coverImage ?? null };
        }
      }
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
