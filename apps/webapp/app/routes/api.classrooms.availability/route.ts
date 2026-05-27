/**
 * Classroom availability check.
 *
 * GET /api/classrooms/availability?git_org_id=...&slug=...
 *
 * Returns `{ slug_available, slug_suggestion? }`. When the slug is already taken
 * inside the org, the loader returns the first free `slug-N` suggestion (N up to 99).
 */

import { requireAuth } from '@classmoji/auth/server';
import getPrisma from '@classmoji/database';
import type { Route } from './+types/route';

export const loader = async ({ request }: Route.LoaderArgs) => {
  await requireAuth(request);

  const url = new URL(request.url);
  const git_org_id = url.searchParams.get('git_org_id') ?? '';
  const slug = url.searchParams.get('slug') ?? '';

  if (!git_org_id || !slug) {
    return Response.json({ slug_available: true });
  }

  const prisma = getPrisma();
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
