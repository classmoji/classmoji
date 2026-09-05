import { ClassmojiService } from '~/utils/db.server.ts';
import { assertPageAccess, pageMutationBlocked } from '~/utils/auth.server.ts';
import { uploadPageAsset } from '~/utils/content.server.ts';

/**
 * Image/file upload endpoint.
 * Uploads to the page's assets folder on GitHub.
 *
 * POST /api/upload
 * Body: FormData with 'file' and 'pageId'
 * Returns: `{ url, path, displayUrl }` — `url`/`path` are the repo path the
 * editor stores in the block; `displayUrl` is the signed URL it displays with
 * (null when the delivery layer is off, in which case the editor shows the
 * path and the legacy proxy resolves it).
 */
export const action = async ({ request }: { request: Request }) => {
  const formData = await request.formData();
  const file = formData.get('file');
  const pageId = formData.get('pageId');

  if (!file || typeof file === 'string') {
    return Response.json({ error: 'No file provided' }, { status: 400 });
  }

  if (!pageId) {
    return Response.json({ error: 'No pageId provided' }, { status: 400 });
  }

  // Fetch page with classroom context
  const page = await ClassmojiService.page.findById(pageId as string, {
    includeClassroom: true,
  });

  if (!page) {
    return Response.json({ error: 'Page not found' }, { status: 404 });
  }

  // Require edit permission (staff in the page's classroom)
  const { membership } = await assertPageAccess({ request, page, accessType: 'edit' });

  // SEC4: uploads write to the content repo — enforce the platform-wide
  // classroom status gate (LOCKED/UNPUBLISHED are read-only for non-owners).
  // accessType 'edit' guarantees a membership (assertPageAccess threw otherwise).
  const blocked = membership ? pageMutationBlocked(page.classroom, membership.role) : null;
  if (blocked) return blocked;

  try {
    const { url, path, displayUrl } = await uploadPageAsset(page, file);
    return Response.json({ success: true, url, path, displayUrl });
  } catch (error: unknown) {
    console.error('[upload] Failed:', error);
    return Response.json(
      { error: error instanceof Error ? error.message : 'Upload failed' },
      { status: 500 }
    );
  }
};
