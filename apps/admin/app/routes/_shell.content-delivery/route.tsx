import { redirect, type LoaderFunctionArgs } from 'react-router';
import { requirePlatformAdmin } from '~/utils/db.server';

/** Moved under Ops. Old links (and the Gitlab request email) keep working. */
export async function loader({ request, url }: LoaderFunctionArgs) {
  await requirePlatformAdmin(request);
  return redirect(`/ops/delivery${url.search}`, 301);
}

export default function Moved() {
  return null;
}
