import { data } from 'react-router';

import { ClassmojiService } from '@classmoji/services';
import { requireClassroomStaff } from '~/utils/routeAuth.server';
import { addClassroomAuditLog } from '~/utils/helpers';
import type { Route } from './+types/route';

/**
 * POST /api/classrooms/:class/github-installation
 *
 * "Check again" behind the install banner: ask GitHub whether the Classmoji App
 * is installed on this classroom's org and, if it is, reconnect the row.
 *
 * OWNER/TEACHER only. Assistants are deliberately excluded — they cannot install
 * the app on the org either, so the button is never offered to them, and this
 * gate is what actually enforces that rather than the button's absence.
 *
 * Every outcome that reached GitHub comes back 200 with a `status` the client
 * renders as a sentence; only a request that could never have reached it is a
 * 4xx, and those two cases are told apart: `not-github` for a classroom hosted
 * somewhere else, `not-eligible` for the example classroom, which IS on GitHub
 * and would be misdescribed by the first. Everything else is
 * `repairInstallation`'s own status, unchanged, so the banner, the import
 * wizard, the create-classroom guard and the operator sweep all describe
 * installations in the same words.
 */
export const action = async ({ params, request }: Route.ActionArgs) => {
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', {
      status: 405,
      headers: { 'Content-Type': 'text/plain', Allow: 'POST' },
    });
  }

  const classSlug = params.class!;

  const { userId, classroom, membership } = await requireClassroomStaff(request, classSlug, {
    resourceType: 'GIT_ORGANIZATION',
    action: 'check_github_installation',
  });

  const org = classroom.git_organization;

  // Nothing to look up: a non-GitHub provider has no App to install.
  if (!org || org.provider !== 'GITHUB') {
    return data({ status: 'not-github' as const, login: org?.login ?? null }, { status: 400 });
  }

  // The example classroom's org is a fixture that must never be reconciled
  // against a real GitHub account. It is not "not on GitHub" — telling its
  // owner that would be a lie about a classroom they can see the org login of —
  // so it gets its own status and its own sentence.
  if (classroom.is_example) {
    return data({ status: 'not-eligible' as const, login: org.login }, { status: 400 });
  }

  const result = await ClassmojiService.gitOrganization.repairInstallation(org.id);

  // An UPDATE row exactly when this check saved the installation id
  // (`claimed`), whatever the final status: the id can be saved and the
  // follow-up read still fail. Every other answer (already connected, not
  // installed, rate limited, a check that joined another's lookup) changed
  // nothing. This never fails the request — `addClassroomAuditLog` contains
  // its write errors.
  if (result.claimed) {
    await addClassroomAuditLog({
      request,
      classroomId: classroom.id,
      userId,
      role: membership?.role,
      action: 'UPDATE',
      resourceType: 'GIT_ORGANIZATION',
      resourceId: org.id,
      metadata: {
        tool: 'api.classrooms.github-installation',
        git_org_login: org.login,
        outcome: result.status,
      },
    });
  }

  return data({
    status: result.status,
    login: org.login,
    ...(result.status === 'rate-limited' ? { retryAfterSeconds: result.retryAfterSeconds } : {}),
  });
};
