import { marked } from 'marked';
import { checkAuth } from '~/utils/helpers';

export const action = checkAuth(async ({ request }) => {
  const data = await request.clone().json();
  return { html: marked.parse(data.markdown) };
});
