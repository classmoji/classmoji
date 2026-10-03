/**
 * Provision the caller's "Example Course" sandbox, on demand.
 *
 * POST /api/example-classroom  →  { slug }
 *
 * Called by the onboarding tour when it hands off from the landing steps into
 * the classroom steps. Idempotent: an existing sandbox is returned as is, so
 * a repeat tour (or one whose sandbox the nightly cleanup removed) costs one
 * provisioning at most. Sandboxes used to be created for every account at
 * registration; most accounts are students, who never opened theirs.
 *
 * Auth: any signed-in user — only ever their own sandbox.
 */

import { requireAuth } from '@classmoji/auth/server';
import getPrisma, { GIT_IDENTITY } from '@classmoji/database';
import { displayUsername } from '@classmoji/utils';
import { provisionExampleClassroom } from '@classmoji/services';
import type { Route } from './+types/route';

export const action = async ({ request }: Route.ActionArgs) => {
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  const { userId } = await requireAuth(request);
  const user = await getPrisma().user.findUnique({
    where: { id: userId },
    select: GIT_IDENTITY,
  });
  const ownerLogin = displayUsername(user);
  if (!ownerLogin) {
    return Response.json({ error: 'Account has no Github or Gitlab username yet.' }, { status: 400 });
  }

  // Optional form field: the tour sends the browser's zone. Absent (an older
  // client, or an empty body) simply means no initial zone.
  const form = await request.formData().catch(() => null);
  const timezone = form?.get('timezone');

  const sandbox = await provisionExampleClassroom({
    ownerUserId: userId,
    ownerLogin,
    timezone: typeof timezone === 'string' ? timezone : null,
  });
  if (!sandbox) {
    return Response.json({ error: 'Could not create the example course.' }, { status: 500 });
  }
  return Response.json({ slug: sandbox.slug });
};
