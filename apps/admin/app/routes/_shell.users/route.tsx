import { redirect, type LoaderFunctionArgs } from 'react-router';
import { requirePlatformAdmin } from '~/utils/db.server';

/** Users is now People; old links (and bookmarks with ?q=) keep working. */
export async function loader({ request }: LoaderFunctionArgs) {
  await requirePlatformAdmin(request);
  const url = new URL(request.url);
  return redirect(`/people${url.search}`, 301);
}

export default function UsersRedirect() {
  return null;
}
