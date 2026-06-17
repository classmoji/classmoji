import getPrisma from '@classmoji/database';
import type { Route } from './+types/route';
import { ClassmojiService } from '@classmoji/services';
import { assertClassroomAccess } from '~/utils/helpers';
import ReadOnlyModulesTree from '~/components/features/modules/ReadOnlyModulesTree';
import {
  buildRepositoryNode,
  type AnyRepository,
  type AnyRepoAssignment,
} from '~/components/features/modules/studentTree';

type UserTeamResult = NonNullable<
  Awaited<ReturnType<typeof ClassmojiService.team.findUserTeamByTag>>
>;

export const loader = async ({ params, request }: Route.LoaderArgs) => {
  const classSlug = params.class!;

  const { userId, classroom } = await assertClassroomAccess({
    request,
    classroomSlug: classSlug,
    allowedRoles: ['OWNER', 'TEACHER', 'ASSISTANT', 'STUDENT'],
    resourceType: 'STUDENT_REPOSITORIES',
    attemptedAction: 'view_modules',
  });

  const repositories = await getPrisma().repository.findMany({
    where: { classroom_id: classroom.id, is_published: true },
    include: {
      assignments: {
        where: { is_published: true },
        include: {
          pages: { include: { page: true }, orderBy: { order: 'asc' } },
          slides: {
            where: { slide: { is_draft: false } },
            include: { slide: true },
            orderBy: { order: 'asc' },
          },
        },
        orderBy: { student_deadline: 'asc' },
      },
      pages: { include: { page: true }, orderBy: { order: 'asc' } },
      slides: {
        where: { slide: { is_draft: false } },
        include: { slide: true },
        orderBy: { order: 'asc' },
      },
      quizzes: {
        where: { status: 'PUBLISHED' },
        select: { id: true, name: true },
      },
    },
    orderBy: { created_at: 'asc' },
  });

  // For self-formed team repositories, check if user has a team
  const userTeamsByModuleSlug: Record<string, UserTeamResult> = {};
  const selfFormedModules = repositories.filter(m => m.team_formation_mode === 'SELF_FORMED');

  for (const repository of selfFormedModules) {
    const tag = await ClassmojiService.organizationTag.findByClassroomIdAndName(
      classroom.id,
      repository.slug!
    );
    if (tag) {
      const userTeam = await ClassmojiService.team.findUserTeamByTag(classroom.id, tag.id, userId);
      if (userTeam) userTeamsByModuleSlug[repository.slug!] = userTeam;
    }
  }

  // Fetch both individual AND team assignments so View Issue button works for group assignments
  const repoAssignments = await ClassmojiService.helper.findAllAssignmentsForStudent(
    userId,
    classSlug
  );

  const repoAssignmentsByAssignmentId: Record<string, (typeof repoAssignments)[number]> = {};
  repoAssignments.forEach(ra => {
    repoAssignmentsByAssignmentId[ra.assignment_id] = ra;
  });

  return {
    repositories,
    repoAssignmentsByAssignmentId,
    userTeamsByModuleSlug,
    slidesUrl: process.env.SLIDES_URL || 'http://localhost:6500',
    pagesUrl: process.env.PAGES_URL || 'http://localhost:7100',
    classSlug,
  };
};

const StudentRepositories = ({ loaderData }: Route.ComponentProps) => {
  const { repositories, repoAssignmentsByAssignmentId, slidesUrl, pagesUrl, classSlug } =
    loaderData;

  const ctx = { classSlug, slidesUrl, pagesUrl };
  const nodes = (repositories as AnyRepository[]).map(r =>
    buildRepositoryNode(
      r,
      repoAssignmentsByAssignmentId as Record<string, AnyRepoAssignment>,
      ctx,
      0
    )
  );

  return (
    <div className="min-h-full">
      <h1 className="mt-2 mb-4 text-base font-semibold text-ink-2">Repositories</h1>

      {repositories.length === 0 ? (
        <div className="rounded-2xl bg-panel ring-1 ring-line p-8 text-center">
          <h3 className="text-base font-semibold text-ink-1">No published repositories yet</h3>
          <p className="text-sm text-ink-3 mt-1">
            Repositories will appear here once your instructor publishes them.
          </p>
        </div>
      ) : (
        <div data-tour="repos-card">
          <ReadOnlyModulesTree key={classSlug} nodes={nodes} />
        </div>
      )}
    </div>
  );
};

export default StudentRepositories;
