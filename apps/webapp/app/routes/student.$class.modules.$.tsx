import { redirect, type LoaderFunctionArgs } from 'react-router';

export async function loader({ params, request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  const splat = params['*'] ?? '';
  const target = `/student/${params.class}/repos${splat ? `/${splat}` : ''}${url.search}`;
  return redirect(target, { status: 301 });
}
