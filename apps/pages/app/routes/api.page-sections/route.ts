import { ClassmojiService, getAuthSession } from '~/utils/db.server.ts';
import { loadPageContent } from '~/utils/content.server.ts';
import {
  handleSectionsGet,
  handleSectionsPost,
  impersonatorOf,
  isImpersonatedSession,
  type PageSectionsDeps,
} from '~/utils/pageSections.server.ts';
import type { PageForContent } from '~/types/pages.ts';

/**
 * A reader's checkable headings and locked sections.
 *
 * POST /api/page-sections  `{ pageId, blockId, intent: 'check'|'uncheck'|'unlock' }`
 *   → `{ ok: true, checked }` / `{ ok: true, unlockedAt }`.
 * GET  /api/page-sections?pageId=&blockId=
 *   → `{ students, unlocks: [{ userId, name, login, avatarUrl, unlockedAt }] }`
 *   (accepted OWNER/TEACHER of the page's classroom; a HEAD is not audited).
 *
 * A resource route (no component), so the root's sign-in redirect never runs
 * here: an anonymous call is a 401, not a 302. Every rule lives in
 * `~/utils/pageSections.server.ts`, which is pure and unit-tested; this file
 * only wires the database in.
 *
 * Writes are NOT gated by `pageMutationBlocked`: checks and unlocks are the
 * reader's own state, not an edit to the page, so an archived classroom keeps
 * them working as it keeps the page readable (plan R8). An UNPUBLISHED
 * classroom refuses them for non-owners (the entry rule).
 *
 * A session lookup that FAILS (as opposed to finding no session) is not
 * caught here: the handler answers it with a no-store 500, never a 401.
 */

type SectionsPageRow = NonNullable<Awaited<ReturnType<typeof ClassmojiService.page.findById>>>;

const deps: PageSectionsDeps<SectionsPageRow> = {
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

  async loadReaderBlocks(page) {
    // The loader's reader read: content.json by sha through the delivery
    // layer. A legacy HTML page (or none) cannot hold a checkable heading or a
    // locked section — the HTML migration produces neither — so it has no
    // blocks to target and every request about it is a 400.
    const { format, content } = await loadPageContent(page as unknown as PageForContent, {
      viaWorker: true,
    });
    return format === 'json' && Array.isArray(content) ? content : [];
  },

  setChecked: args => ClassmojiService.pageSections.setChecked(args),

  recordUnlock: args => ClassmojiService.pageSections.recordUnlock(args),

  sectionActivity: args => ClassmojiService.pageSections.sectionActivity(args),

  audit: ({ userId, classroomId, role, pageId, action, data, dedupe }) =>
    ClassmojiService.audit.create(
      {
        user_id: userId,
        classroom_id: classroomId,
        role,
        resource_type: 'PAGES',
        resource_id: pageId,
        action,
        data,
      },
      { dedupe: dedupe ?? true }
    ),

  isValidationError: error =>
    error instanceof ClassmojiService.pageSections.PageSectionsValidationError,
};

export const action = ({ request }: { request: Request }) => handleSectionsPost(request, deps);

export const loader = ({ request }: { request: Request }) => handleSectionsGet(request, deps);
