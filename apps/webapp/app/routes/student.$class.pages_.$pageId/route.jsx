import { useLoaderData, useParams } from 'react-router';
import { ClassmojiService } from '@classmoji/services';
import { requireStudentAccess } from '~/utils/helpers';

export const loader = async ({ params, request }) => {
  const { class: classSlug, pageId } = params;

  // Require student access
  await requireStudentAccess(request, classSlug);

  // Fetch page to verify it exists and check permissions
  const page = await ClassmojiService.page.findById(pageId, {
    includeClassroom: false,
  });

  if (!page) {
    throw new Response('Page not found', { status: 404 });
  }

  // Block access to draft pages (students can't view drafts)
  if (page.is_draft) {
    throw new Response('This page is not yet published', { status: 403 });
  }

  // Get pages URL from environment (works in both dev and production)
  const pagesUrl = process.env.PAGES_URL || 'http://localhost:7100';

  return { page, pagesUrl };
};

const Component = () => {
  const { page, pagesUrl } = useLoaderData();
  const params = useParams();

  const iframeUrl = `${pagesUrl}/${params.class}/${params.pageId}?embed=true`;

  return (
    <div className="h-full w-full">
      <iframe
        src={iframeUrl}
        className="w-full h-full border-0"
        style={{ minHeight: 'calc(100vh - 64px)' }}
        title={page.title}
      />
    </div>
  );
};

export default Component;
