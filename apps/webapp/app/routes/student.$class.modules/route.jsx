import prisma from '@classmoji/database';
import { ClassmojiService } from '@classmoji/services';
import { assertClassroomAccess } from '~/utils/helpers';
import { PageHeader } from '~/components';
import ModuleAccordion from './ModuleAccordion';

export const loader = async ({ params, request }) => {
  const { class: classSlug } = params;

  const { userId, classroom } = await assertClassroomAccess({
    request,
    classroomSlug: classSlug,
    allowedRoles: ['OWNER', 'TEACHER', 'ASSISTANT', 'STUDENT'],
    resourceType: 'STUDENT_MODULES',
    attemptedAction: 'view_modules',
  });

  const modules = await prisma.module.findMany({
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
    },
    orderBy: { created_at: 'desc' },
  });

  // For self-formed team modules, check if user has a team
  const userTeamsByModuleSlug = {};
  const selfFormedModules = modules.filter(m => m.team_formation_mode === 'SELF_FORMED');

  for (const module of selfFormedModules) {
    const tag = await ClassmojiService.organizationTag.findByClassroomIdAndName(classroom.id, module.slug);
    if (tag) {
      const userTeam = await ClassmojiService.team.findUserTeamByTag(classroom.id, tag.id, userId);
      userTeamsByModuleSlug[module.slug] = userTeam;
    }
  }

  // Fetch both individual AND team assignments so View Issue button works for group assignments
  const repoAssignments = await ClassmojiService.helper.findAllAssignmentsForStudent(
    userId,
    classSlug
  );

  const repoAssignmentsByAssignmentId = {};
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

const StudentModules = ({ loaderData }) => {
  const { modules, repoAssignmentsByAssignmentId, userTeamsByModuleSlug, slidesUrl, pagesUrl, classSlug } = loaderData;

  return (
    <div>
      <PageHeader title="Modules" routeName="modules" />

      {modules.length === 0 ? (
        <div className="text-center py-12 text-gray-500">
          <div className="text-6xl mb-4">📚</div>
          <h3 className="text-xl font-semibold text-gray-700 dark:text-gray-300 mb-2">
            No modules available
          </h3>
          <p className="dark:text-gray-400">Modules will appear here once published</p>
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
