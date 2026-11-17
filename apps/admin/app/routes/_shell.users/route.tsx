import { redirect, type LoaderFunctionArgs } from 'react-router';
import { requirePlatformAdmin } from '~/utils/db.server';

/** Users is now People; old links (and bookmarks with ?q=) keep working. */
export async function loader({ request, url }: LoaderFunctionArgs) {
  await requirePlatformAdmin(request);
  return redirect(`/people${url.search}`, 301);
}

export default function UsersRedirect() {
  return null;
}
