/**
 * Course-site subdomain availability check.
 *
 * GET /api/site/availability?subdomain=...&class=<classroom slug>
 *
 * Returns `{ subdomain_available, normalized, status, message }` — see
 * ./availability.ts for why `status` exists alongside the boolean.
 *
 * The classroom is identified by SLUG, not id, because the slug is what the
 * app's authorization helpers key on: `assertClassroomAccess` resolves the
 * classroom and the caller's membership in one step, and OWNER is required.
 * The resolved id is then passed as `excludeClassroomId`, so a classroom
 * re-checking the subdomain it already holds is told "available" instead of
 * being told it is taken by itself.
 *
 * Normalization and validation both happen inside
 * `checkSubdomainAvailability`, before any DB read — `CS 52!` is answered
 * `invalid` without a query, and `App` is answered `reserved` the same way
 * `app` is.
 */

import { ClassmojiService } from '@classmoji/services';
import { assertClassroomAccess } from '~/utils/routeAuth.server';
import { buildAvailabilityResponse } from './availability.ts';
import type { Route } from './+types/route';

export const loader = async ({ request }: Route.LoaderArgs) => {
  const url = new URL(request.url);
  const classroomSlug = (url.searchParams.get('class') ?? '').trim();
  const subdomain = url.searchParams.get('subdomain') ?? '';

  // Guarded before the auth call, not by it: assertClassroomAccess treats a
  // missing slug as a CONFIGURATION error and throws a 500. That is right for a
  // route that hardcodes its own slug and wrong for one that reads a query
  // param, where an absent `class` is simply a bad request.
  if (!classroomSlug) {
    return Response.json({ error: 'A `class` slug is required.' }, { status: 400 });
  }

  // Fails closed on an unknown slug or a non-owner: assertClassroomAccess
  // throws rather than returning, so there is no path here that answers
  // without an OWNER of this classroom.
  const { classroom } = await assertClassroomAccess({
    request,
    classroomSlug,
    allowedRoles: ['OWNER'],
    resourceType: 'SITE_SETTINGS',
    attemptedAction: 'check_subdomain',
  });

  if (!subdomain.trim()) return Response.json(buildAvailabilityResponse(null));

  const availability = await ClassmojiService.site.checkSubdomainAvailability(
    subdomain,
    classroom.id
  );
  return Response.json(buildAvailabilityResponse(availability));
};
