import { ClassmojiService, getAuthSession } from '~/utils/db.server.ts';
import { loadPageContent } from '~/utils/content.server.ts';
import { impersonatorOf, isImpersonatedSession } from '~/utils/pageSections.server.ts';
import { pageMutationBlocked } from '~/utils/auth.server.ts';
import { fetchLiveSnapshot, liveEditingEnv } from '~/utils/collab.server.ts';
import { joinsLiveRoom } from '~/utils/liveGates.ts';
import {
  commentBlocksFor,
  createCommentRateLimiter,
  handleCommentsGet,
  handleCommentsPost,
  type PageCommentsDeps,
} from '~/utils/pageComments.server.ts';
import type { PageForContent } from '~/types/pages.ts';

/**
 * Page comments (the page-comments plan's API contract).
 *
 * GET  /api/page-comments?pageId=
 *   → `{ threads, viewer: { canWrite, canResolve, canModerate, frozen } }`
 * POST /api/page-comments `{ pageId, intent, ... }` → `{ ok: true, thread }`
 *   create { blockId?, quote?, quoteOccurrence?, body } · reply { threadId, body }
 *   edit { commentId, body } · delete { commentId }
 *   react { commentId, emoji, on } · resolve { threadId, resolved }
 * Refusals: `{ error: CODE, message }`.
 *
 * A resource route (no component), so the root's sign-in redirect never runs
 * here: an anonymous call is a 401, not a 302. Every rule lives in
 * `ClassmojiService.pageComments` (shared with the MCP tools) and the
 * transport in `~/utils/pageComments.server.ts`, which is pure and
 * unit-tested; this file only wires the database in.
 */

type CommentsPageRow = NonNullable<Awaited<ReturnType<typeof ClassmojiService.page.findById>>>;

// One per process: the pages app runs on one machine (see the limiter).
const rateLimit = createCommentRateLimiter();

const deps: PageCommentsDeps<CommentsPageRow> = {
  async getSession(request) {
    const authData = await getAuthSession(request);
    if (!authData?.userId) return null;
    return {
      userId: authData.userId,
      impersonated: isImpersonatedSession(authData),
      impersonatedBy: impersonatorOf(authData),
    };
  },

  async findPage(pageId) {
    return (await ClassmojiService.page.findById(pageId, { includeClassroom: true })) ?? null;
  },

  // The one reader rule, shared with the page loader and the MCP tools.
  sectionViewer: args => ClassmojiService.pageSections.sectionViewer(args),

  readerState: args => ClassmojiService.pageSections.readerState(args),

  async loadCommentBlocks(page, viewer) {
    // The document the page loader renders for this caller (its `readContent`):
    // an editor who joins the live room anchors on the live document, so a
    // block added live can be commented on before the checkpoint reaches git;
    // everyone else on git's copy, the one their viewer shows. Not in preview:
    // comments are never shown on a preview branch.
    const canEdit = viewer.canEditAnyState;
    const liveEnv = canEdit ? liveEditingEnv(page.classroom) : null;
    const live =
      liveEnv &&
      joinsLiveRoom({
        canEdit,
        liveClassroom: true,
        signedIn: true,
        previewActive: false,
        mutationBlocked: Boolean(viewer.role && pageMutationBlocked(page.classroom, viewer.role)),
      });
    return commentBlocksFor({
      live: Boolean(live),
      readLive: async () =>
        liveEnv ? fetchLiveSnapshot(liveEnv, page.id, { timeoutMs: 3000 }) : null,
      readGit: () =>
        loadPageContent(
          page as unknown as PageForContent,
          canEdit ? { skipCache: true } : { viaWorker: true }
        ),
    });
  },

  rules: ClassmojiService.pageComments,

  audit: row => ClassmojiService.audit.create(row, { dedupe: false }),

  rateLimit,
};

export const action = ({ request }: { request: Request }) => handleCommentsPost(request, deps);

export const loader = ({ request }: { request: Request }) => handleCommentsGet(request, deps);
