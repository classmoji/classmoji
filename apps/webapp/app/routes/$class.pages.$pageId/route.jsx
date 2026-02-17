import { redirect } from 'react-router';

export const loader = async ({ params }) => {
  const { class: classSlug, pageId } = params;

  // Redirect to apps/pages (no auth check - apps/pages handles public/private access)
  const pagesUrl = process.env.PAGES_URL || 'http://localhost:7100';
  return redirect(`${pagesUrl}/${classSlug}/${pageId}`);
};

export default function Component() {
  return null;
}
