import { redirect, type LoaderFunctionArgs } from 'react-router';
import { requirePlatformAdmin } from '~/utils/db.server';

/** Insights moved onto Home; old links keep their range. */
export async function loader({ request }: LoaderFunctionArgs) {
  await requirePlatformAdmin(request);
  const range = new URL(request.url).searchParams.get('range');
  return redirect(range ? `/?range=${encodeURIComponent(range)}` : '/');
}
