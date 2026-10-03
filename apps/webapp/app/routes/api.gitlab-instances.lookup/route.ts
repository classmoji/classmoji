import { data } from 'react-router';
import { ClassmojiService } from '@classmoji/services';
import type { Route } from './+types/route';

/**
 * GET /api/gitlab-instances/lookup?host=gitlab.school.edu
 *
 * PUBLIC (the sign-in page calls it before anyone is signed in). Says whether
 * a GitLab is set up with Classmoji, and returns only its id and host.
 */
export const loader = async ({ request }: Route.LoaderArgs) => {
  const input = new URL(request.url).searchParams.get('host') ?? '';
  const svc = ClassmojiService.gitlabInstance;
  const host = svc.normalizeHost(input);
  if (!host) return data({ status: 'invalid' as const }, { status: 400 });

  const found = await svc.findByHost(host);
  if (!found) return { status: 'unknown' as const, host };
  if (found.pending) return { status: 'pending' as const, host };
  if (found.disabled) return { status: 'disabled' as const, host };
  return { status: 'ok' as const, instance: { id: found.id, host: found.host } };
};
