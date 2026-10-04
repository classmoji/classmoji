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

import {
  CollabHttpError,
  type AuthorizeResult,
  type CollabAdapter,
  type ExternalMergeResult,
  type LiveEditContext,
  type SeedResult,
} from './types.ts';
import {
  brokenColumnLists,
  readCover,
  reconcileBlocks,
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
      if (!page.classroom.collab_enabled) return { ok: false, reason: 'collab-disabled' };
      const role = await deps.findRole(userId, page.classroom_id);
      if (!canEditPages(role)) return { ok: false, reason: 'forbidden' };
      if (!canMutateClassroom({ status: page.classroom.status as never, role: role! })) {
        return { ok: false, reason: 'classroom-locked' };
      }
      return { ok: true, classroomId: page.classroom_id };
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
        const doc = pageContentToYDoc({ blocks: pageContent.blankPageBlocks() });
        return { doc, sourceSha: null, classroomId: page.classroom_id };
      }
      const { blocks, cover } = requireJson(loaded, `page ${docId}`);
      // Deterministic ids for any id-less block — the ids MCP derives on read,
      // so an agent's ops name blocks the live doc actually has.
      const doc = pageContentToYDoc({
        blocks: pageContent.ensureBlockIds(blocks),
        coverImage: cover,
      });
      return { doc, sourceSha: loaded.sha, classroomId: page.classroom_id };
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

    applyOps(ctx: LiveEditContext, ops) {
      ctx.transact(doc => {
        const current = blocksOf(doc);
        let next: PageBlock[];
        try {
          next = pageContent.ensureBlockIds(pageContent.applyBlockOps(current, ops)) as PageBlock[];
        } catch (err) {
          asHttpError(err);
        }
        reconcileBlocks(doc, current, next);
      });
    },

    setCover(ctx, coverImage) {
      ctx.transact(doc => writeCover(doc, coverImage));
    },

    async mergeExternal(ctx, { sha }): Promise<ExternalMergeResult> {
      const page = await mustFindPage(ctx.ref.docId);

      // theirs: the content file at the pushed commit.
      const theirsLoaded = await deps.loadContent(page, { ref: sha });
      const theirs = requireJson(theirsLoaded, `page ${page.id} at ${sha}`);

      // base: what the live doc descends from (seeded from or last pushed).
      let base: { blocks: PageBlock[]; cover: PageCoverImage | null } = { blocks: [], cover: null };
      const baseSha = ctx.row?.source_sha;
      if (baseSha) {
        const text = await deps.readBlob(page, baseSha);
        if (text != null) {
          const parsed = parsePageContent(text);
          base = { blocks: parsed.blocks as PageBlock[], cover: parsed.coverImage ?? null };
        }
      }

      let conflicts = 0;
      // ours is read INSIDE the transaction, so typing that landed while the
      // files were fetched is part of the merge, not reverted by it.
      ctx.transact(doc => {
        const ours = blocksOf(doc);
        const result = pageContent.merge3Blocks(base.blocks, ours, theirs.blocks);
        conflicts = result.conflicts.length;
        const merged = pageContent.normalizeBlockStructure(
          pageContent.ensureBlockIds(result.merged)
        ) as PageBlock[];
        reconcileBlocks(doc, ours, merged);
        if (JSON.stringify(theirs.cover) !== JSON.stringify(base.cover)) {
          writeCover(doc, theirs.cover);
        }
      });

      return { sourceSha: theirsLoaded.sha, conflicts };
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
