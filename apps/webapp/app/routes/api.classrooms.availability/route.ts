/**
 * Classroom availability check.
 *
 * GET /api/classrooms/availability?git_org_id=...&slug=...
 * GET /api/classrooms/availability?org_provider_id=...&slug=...
 *
 * Returns `{ slug_available, slug_suggestion? }`. When the slug is already taken
 * inside the org, the loader returns the first free `slug-N` suggestion (N up to 99).
 *
 * `git_org_id` is our GitOrganization UUID. The GitHub Classroom import flow
 * doesn't have one yet (the org row is created at import time), so it can pass
 * `org_provider_id` (the GitHub org id) instead — we resolve it to a git_org_id,
 * and treat an as-yet-unknown org as fully available (no classrooms under it).
 */

import { requireAuth } from '@classmoji/auth/server';
import getPrisma from '@classmoji/database';
import type { Route } from './+types/route';

export const loader = async ({ request }: Route.LoaderArgs) => {
  await requireAuth(request);

  const url = new URL(request.url);
  let git_org_id = url.searchParams.get('git_org_id') ?? '';
  const org_provider_id = url.searchParams.get('org_provider_id') ?? '';
  const slug = url.searchParams.get('slug') ?? '';

  const prisma = getPrisma();

  // Resolve a GitHub org id to our GitOrganization UUID when given.
  if (!git_org_id && org_provider_id) {
    const org = await prisma.gitOrganization.findUnique({
      where: { provider_provider_id: { provider: 'GITHUB', provider_id: org_provider_id } },
      select: { id: true },
    });
    // No org row yet → nothing can collide → slug is available.
    if (!org) return Response.json({ slug_available: true });
    git_org_id = org.id;
  }

  if (!git_org_id || !slug) {
    return Response.json({ slug_available: true });
  }
  const bySlug = await prisma.classroom.findFirst({
    where: { git_org_id, slug },
    select: { id: true },
  });

  let slug_suggestion: string | undefined;
  if (bySlug) {
    for (let n = 2; n < 100; n++) {
      const candidate = `${slug}-${n}`;
      const hit = await prisma.classroom.findFirst({
        where: { git_org_id, slug: candidate },
        select: { id: true },
      });
      if (!hit) {
        slug_suggestion = candidate;
        break;
      }
    }
  }

  return Response.json({ slug_available: !bySlug, slug_suggestion });
};
