import DOMPurify from 'isomorphic-dompurify';
import { marked } from 'marked';
import { checkAuth } from '~/utils/helpers';

export const action = checkAuth(async ({ request }: { request: Request }) => {
  const data = await request.clone().json();
  const rawHtml = await marked.parse(data.markdown ?? '');
  const html = DOMPurify.sanitize(rawHtml, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ['style', 'iframe', 'object', 'embed', 'form'],
    FORBID_ATTR: ['style', 'onerror', 'onload', 'onclick'],
  });
  return { html };
});
