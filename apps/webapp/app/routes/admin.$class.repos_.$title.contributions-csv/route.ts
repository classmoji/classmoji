import { ClassmojiService } from '@classmoji/services';
import { addClassroomAuditLog } from '~/utils/helpers';
import { requireClassroomAdmin } from '~/utils/routeAuth.server';
import type { Route } from './+types/route';

/**
 * Every student commit in a team repository's team repos, as a CSV download
 * (no page): the repository page's "Export commits (CSV)". OWNER only, like
 * "Calculate contributions" beside it. The rows are the last calculation's,
 * read by this classroom's id and the repository found inside it; each
 * download is audited (it names students and their work).
 */
export const loader = async ({ request, params }: Route.LoaderArgs) => {
  const { userId, classroom, membership } = await requireClassroomAdmin(request, params.class!, {
    resourceType: 'REPOSITORIES',
    action: 'export_contributions',
  });

  const repository = await ClassmojiService.repository.findByClassroomAndTitle(
    classroom.id,
    params.title!
  );
  if (!repository) throw new Response('Repository not found', { status: 404 });
  if (repository.type !== 'GROUP') {
    throw new Response('Commits are exported for team repositories only', { status: 400 });
  }

  const result = await ClassmojiService.repoContributions.listCommits({
    classroomId: classroom.id,
    repositoryId: repository.id,
  });

  await addClassroomAuditLog({
    classroomId: classroom.id,
    userId,
    role: membership!.role,
    action: 'VIEW',
    resourceType: 'REPOSITORIES',
    resourceId: repository.id,
    metadata: {
      tool: 'web:repos.contributions.export_csv',
      repos: result.repoCount,
      commits: result.rows.length,
    },
  });

  const date = new Date().toISOString().slice(0, 10);
  const name = `${classroom.slug}-${repository.slug ?? repository.id}-commits-${date}.csv`.replace(
    /[^\w.-]+/g,
    '-'
  );
  // A BOM, so Excel reads accented names as UTF-8.
  return new Response('\uFEFF' + ClassmojiService.repoContributions.commitsToCsv(result.rows), {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${name}"`,
      'Cache-Control': 'no-store',
    },
  });
};
