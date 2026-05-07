import getPrisma from '@classmoji/database';
import type { Route } from './+types/route';
import { ClassmojiService } from '@classmoji/services';
import { assertClassroomAccess } from '~/utils/helpers';
import ModuleAccordion from './ModuleAccordion';

type UserTeamResult = NonNullable<
  Awaited<ReturnType<typeof ClassmojiService.team.findUserTeamByTag>>
>;

export const loader = async ({ params, request }: Route.LoaderArgs) => {
  const classSlug = params.class!;

  const { userId, classroom } = await assertClassroomAccess({
    request,
    classroomSlug: classSlug,
    allowedRoles: ['OWNER', 'TEACHER', 'ASSISTANT', 'STUDENT'],
    resourceType: 'STUDENT_MODULES',
    attemptedAction: 'view_modules',
  });

  const modules = await getPrisma().module.findMany({
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

  // For self-formed team modules, check if user has a team
  const userTeamsByModuleSlug: Record<string, UserTeamResult> = {};
  const selfFormedModules = modules.filter(m => m.team_formation_mode === 'SELF_FORMED');

  for (const module of selfFormedModules) {
    const tag = await ClassmojiService.organizationTag.findByClassroomIdAndName(
      classroom.id,
      module.slug!
    );
    if (tag) {
      const userTeam = await ClassmojiService.team.findUserTeamByTag(classroom.id, tag.id, userId);
      if (userTeam) userTeamsByModuleSlug[module.slug!] = userTeam;
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
    modules,
    repoAssignmentsByAssignmentId,
    userTeamsByModuleSlug,
    slidesUrl: process.env.SLIDES_URL || 'http://localhost:6500',
    pagesUrl: process.env.PAGES_URL || 'http://localhost:7100',
    classSlug,
  };
};

const StudentModules = ({ loaderData }: Route.ComponentProps) => {
  const {
    modules,
    repoAssignmentsByAssignmentId,
    userTeamsByModuleSlug,
    slidesUrl,
    pagesUrl,
    classSlug,
  } = loaderData;

  return (
    <div className="min-h-full">
      <h1 className="mt-2 mb-4 text-base font-semibold text-gray-600 dark:text-gray-400">
        Modules
      </h1>

      {modules.length === 0 ? (
        <div className="rounded-2xl bg-panel ring-1 ring-stone-200 dark:ring-neutral-800 p-8 text-center">
          <h3 className="text-base font-semibold text-gray-800 dark:text-gray-200">
            No published modules yet
          </h3>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
            Modules will appear here once your instructor publishes them.
          </p>
        </div>
      ) : (
        <ModuleAccordion
          modules={modules}
          repoAssignmentsByAssignmentId={repoAssignmentsByAssignmentId}
          userTeamsByModuleSlug={userTeamsByModuleSlug}
          classSlug={classSlug}
          slidesUrl={slidesUrl}
          pagesUrl={pagesUrl}
        />
      )}
    </div>
  );
};

export default StudentModules;
