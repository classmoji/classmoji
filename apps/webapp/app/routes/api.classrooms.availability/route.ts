/**
 * Classroom slug availability check.
 *
 * GET /api/classrooms/availability?slug=...
 *   &git_org_id=...       our GitOrganization UUID (the create flow), or
 *   &org_provider_id=...  the GitHub org id (the import flow — that org row is
 *                         only created at import time), optionally with
 *   &org_login=...        the GitHub org login, so the suggestion can still be
 *                         org-qualified before that row exists.
 *
 * Returns `{ slug_available, slug_suggestion? }`.
 *
 * The check is GLOBAL, not org-scoped: `Classroom.slug` is globally unique
 * because it is the sole key in every app URL. An unknown org, or no org at
 * all, therefore no longer means "available" — the org is used only to build
 * the suggestion.
 *
 * The slug is normalized before checking. The create and import paths both
 * store a slugified value, so checking the raw text would report `CS 101` free
 * and then store a colliding `cs-101`.
 */

import { requireAuth } from '@classmoji/auth/server';
import { classroomSlugCandidates, slugify } from '@classmoji/services';
import getPrisma from '@classmoji/database';
import type { Route } from './+types/route';

export const loader = async ({ request }: Route.LoaderArgs) => {
  await requireAuth(request);

  const url = new URL(request.url);
  const git_org_id = url.searchParams.get('git_org_id') ?? '';
  const org_provider_id = url.searchParams.get('org_provider_id') ?? '';
  const slug = slugify(url.searchParams.get('slug') ?? '');

  // Nothing typed yet — no claim to make either way.
  if (!slug) return Response.json({ slug_available: true });

  const prisma = getPrisma();

  // Resolve the org for the SUGGESTION only. A missing row is fine: the import
  // flow can pass the login directly, and without either we fall back to
  // numeric suggestions.
  const org = git_org_id
    ? await prisma.gitOrganization.findUnique({
        where: { id: git_org_id },
        select: { login: true },
      })
    : org_provider_id
      ? await prisma.gitOrganization.findUnique({
          where: { provider_provider_id: { provider: 'GITHUB', provider_id: org_provider_id } },
          select: { login: true },
        })
      : null;
  const orgLogin = org?.login ?? url.searchParams.get('org_login') ?? '';

  // One query for the whole candidate list. Candidate 0 is the bare slug, so
  // this answers availability and picks the suggestion at the same time — and
  // because the list comes from the same helper the create retries on, the
  // suggestion is the slug a create would actually land on.
  const candidates = classroomSlugCandidates(slug, orgLogin);
  const taken = new Set(
    (
      await prisma.classroom.findMany({
        where: { slug: { in: candidates } },
        select: { slug: true },
      })
    ).map(c => c.slug)
  );

  const slug_available = !taken.has(slug);
  return Response.json({
    slug_available,
    slug_suggestion: slug_available ? undefined : candidates.find(c => !taken.has(c)),
  });
};
