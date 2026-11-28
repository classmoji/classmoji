/**
 * The platform admin behind a "View As" session: the admin's user id while
 * one is viewing as the signed-in user, else null. For the services that
 * write their own audit row (`impersonatedBy` on their actor); the webapp's
 * audit funnel (`~/utils/helpers`) reads it for every row it writes.
 */
import { getAuthSession } from '@classmoji/auth/server';

import { sessionImpersonator } from '~/utils/impersonationSession';

export const impersonatedBy = async (request: Request): Promise<string | null> =>
  sessionImpersonator(await getAuthSession(request));
