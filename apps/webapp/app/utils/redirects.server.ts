import { redirect } from 'react-router';

export function redirectModulesToRepos(
  rolePrefix: 'admin' | 'assistant' | 'student',
  classParam: string | undefined,
  splat: string | undefined,
  request: Request
) {
  const qIdx = request.url.indexOf('?');
  const search = qIdx >= 0 ? request.url.slice(qIdx) : '';
  const tail = splat ? `/${splat}` : '';
  return redirect(`/${rolePrefix}/${classParam}/repos${tail}${search}`, {
    status: 301,
    headers: { 'Cache-Control': 'public, max-age=31536000, immutable' },
  });
}
