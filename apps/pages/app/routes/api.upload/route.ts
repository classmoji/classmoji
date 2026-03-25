import { ClassmojiService } from '~/utils/db.server.ts';
import { assertPageAccess } from '~/utils/auth.server.ts';
import { uploadPageAsset } from '~/utils/content.server.ts';

/**
 * Image/file upload endpoint.
 * Uploads to the page's assets folder on GitHub.
 *
 * POST /api/upload
 * Body: FormData with 'file' and 'pageId'
 * Returns: { url, path }
 */
export const action = async ({ request }: any) => {
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
  const page = await ClassmojiService.page.findById(pageId, {
    includeClassroom: true,
  });

  if (!page) {
    return Response.json({ error: 'Page not found' }, { status: 404 });
  }

  // Require edit permission (staff in the page's classroom)
  await assertPageAccess({ request, page, accessType: 'edit' });

  try {
    const { url, path } = await uploadPageAsset(page, file);
    return Response.json({ success: true, url, path });
  } catch (error: any) {
    console.error('[upload] Failed:', error);
    return Response.json(
      { error: error.message || 'Upload failed' },
      { status: 500 }
    );
  }
};
