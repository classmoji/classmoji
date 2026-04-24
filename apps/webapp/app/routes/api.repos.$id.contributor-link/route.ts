import { ClassmojiService } from '@classmoji/services';
import getPrisma from '@classmoji/database';
import { assertClassroomAccess } from '~/utils/routeAuth.server';
import type { Route } from './+types/route';

/**
 * POST /api/repos/:id/contributor-link
 *
 * `:id` is the Repository.id (NOT the repository_assignment id — the
 * `RepositoryContributorLink` table is keyed on `(repository_id, github_login)`).
 *
 * Body: `{ github_login: string, user_id: string | null }`.
 *
 * Upserts a manual GitHub-login → user mapping for the repo. Passing
 * `user_id: null` unlinks. Only OWNER/TEACHER/ASSISTANT of the owning
 * classroom may call this.
 */
export const action = async ({ params, request }: Route.ActionArgs) => {
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', {
      status: 405,
      headers: { 'Content-Type': 'text/plain', Allow: 'POST' },
    });
  }

  const repositoryId = params.id!;

  // Resolve the owning classroom so we can run auth against its slug.
  const repo = await getPrisma().repository.findUnique({
    where: { id: repositoryId },
    select: { id: true, classroom: { select: { id: true, slug: true } } },
  });

  if (!repo) {
    return new Response('Repository not found', {
      status: 404,
      headers: { 'Content-Type': 'text/plain' },
    });
  }

  await assertClassroomAccess({
    request,
    classroomSlug: repo.classroom.slug,
    allowedRoles: ['OWNER', 'TEACHER', 'ASSISTANT'],
    resourceType: 'REPOSITORY',
    attemptedAction: 'link_contributor',
    metadata: { repository_id: repositoryId },
  });

  let body: { github_login?: string; user_id?: string | null };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const githubLogin = body.github_login;
  const userId = body.user_id === undefined ? null : body.user_id;

  if (!githubLogin || typeof githubLogin !== 'string') {
    return Response.json(
      { error: 'github_login is required' },
      { status: 400 }
    );
  }
  if (userId !== null && typeof userId !== 'string') {
    return Response.json(
      { error: 'user_id must be a string or null' },
      { status: 400 }
    );
  }

  try {
    await ClassmojiService.repoAnalytics.linkContributor(
      repositoryId,
      githubLogin,
      userId
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ error: message }, { status: 400 });
  }

  return Response.json({ linked: true });
};
