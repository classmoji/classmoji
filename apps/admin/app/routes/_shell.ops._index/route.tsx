import { redirect, type LoaderFunctionArgs } from 'react-router';
import { requirePlatformAdmin } from '~/utils/db.server';

export async function loader({ request }: LoaderFunctionArgs) {
  await requirePlatformAdmin(request);
  return redirect('/ops/delivery');
}

export default function OpsIndex() {
  return null;
}
