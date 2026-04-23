import { redirect } from 'react-router';
import type { Route } from './+types/route';

export const loader = async ({ params }: Route.LoaderArgs) => {
  const classSlug = params.class!;
  const pageId = params.pageId!;

  // Redirect to apps/pages (no auth check - apps/pages handles public/private access)
  const pagesUrl = process.env.PAGES_URL || 'http://localhost:7100';
  return redirect(`${pagesUrl}/${classSlug}/${pageId}`);
};

export default function Component() {
  return null;
}
