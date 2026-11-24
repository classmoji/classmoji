import { siteOrigin } from '@classmoji/services';

import { assetResolveContext, resolveDocumentAssets } from './assetRefs.server.ts';
import { ClassmojiService, prisma } from './db.server.ts';
import { loadMediaDownloads } from './mediaDownloads.server.ts';
import { readerCommentsFor, type CommentViewer } from './pageComments.server.ts';
import { NAV_GRID_SCHEDULE_PATH } from '~/components/editor/blocks/navGridShared.ts';
import type { LinkedPageRow, ReaderPayloadDeps } from './readerPayload.server.ts';

/**
 * The real I/O behind `buildReaderPayload` (`readerPayload.server.ts`), in one
 * module so a spec that runs the page loader with stubs swaps one import.
 */
export const readerPayloadDeps: ReaderPayloadDeps = {
  assetContext: (classroom, tier) =>
    assetResolveContext(
      classroom as unknown as Parameters<typeof assetResolveContext>[0],
      tier as Parameters<typeof assetResolveContext>[1]
    ),
  resolveAssets: (ctx, blocks, extraRefs) =>
    resolveDocumentAssets(ctx as Parameters<typeof resolveDocumentAssets>[0], blocks, extraRefs),
  loadMediaDownloads: (classroomId, blocks, role) => loadMediaDownloads(classroomId, blocks, role),
  linkedPages: async (classroomId, pageIds) => {
    if (pageIds.length === 0) return [];
    const rows = await prisma.page.findMany({
      // Scoped to the page's own classroom in SQL: an id from anywhere else
      // finds nothing.
      where: { classroom_id: classroomId, id: { in: pageIds } },
      select: {
        id: true,
        classroom_id: true,
        title: true,
        slug: true,
        is_public: true,
        is_draft: true,
      },
    });
    return rows as LinkedPageRow[];
  },
  readerComments: async ({
    userId,
    viewer,
    page,
    classroom,
    blocks,
    unlockedSectionIds,
    impersonated,
  }) => {
    const context = ClassmojiService.pageComments.commentContext({
      userId,
      // The service's answer (only NO_SECTION_VIEWER has no accepted role).
      viewer: viewer as CommentViewer,
      page: page as Parameters<typeof ClassmojiService.pageComments.commentContext>[0]['page'],
      classroom: classroom as unknown as Parameters<
        typeof ClassmojiService.pageComments.commentContext
      >[0]['classroom'],
      blocks,
      unlockedSectionIds,
    });
    if (!context.access.canRead) return undefined;
    const counts = await ClassmojiService.pageComments.countsForViewer(context);
    return readerCommentsFor({ signedIn: true, access: context.access, impersonated, counts });
  },
};

/**
 * Where a page directory's schedule tile goes in the pages app: the class
 * site's `/schedule`, when the classroom has a site that serves it (enabled,
 * the schedule switched on, the classroom neither archived nor unpublished —
 * the site's own conditions), else null and the tile is not drawn.
 */
export async function appScheduleHref(classroom: {
  id: string;
  status?: unknown;
  is_archived?: unknown;
}): Promise<string | null> {
  if (classroom.is_archived === true || classroom.status === 'UNPUBLISHED') return null;
  try {
    const site = await ClassmojiService.site.getSiteForClassroom(classroom.id);
    if (!site?.is_enabled || !site.show_schedule) return null;
    const origin = siteOrigin(site.subdomain);
    return origin ? `${origin}${NAV_GRID_SCHEDULE_PATH}` : null;
  } catch (error) {
    // A lookup failure costs the tile, never the page.
    console.warn('[pages] site lookup for the schedule tile failed:', error);
    return null;
  }
}
