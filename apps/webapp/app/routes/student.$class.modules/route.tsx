import getPrisma from '@classmoji/database';
import type { Route } from './+types/route';
import { ClassmojiService } from '@classmoji/services';
import { assertClassroomAccess } from '~/utils/helpers';
import { ModulesScreen, buildModuleCards } from '~/components/features/modules';

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
    },
    orderBy: { created_at: 'desc' },
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

  const moduleCards = buildModuleCards(
    modules.map(m => ({
      id: m.id,
      title: m.title,
      slug: m.slug,
      updated_at: m.updated_at,
      assignments: m.assignments.map(a => ({
        id: a.id,
        student_deadline: a.student_deadline,
      })),
      pages: m.pages,
      slides: m.slides,
    })),
    {
      rolePrefix: 'student',
      classSlug,
      classroomStart: null,
      isAssignmentDone: assignmentId => {
        const ra = repoAssignmentsByAssignmentId[assignmentId];
        return !!ra && ra.status === 'CLOSED';
      },
    }
  );

  return {
    moduleCards,
  };
};

const StudentModules = ({ loaderData }: Route.ComponentProps) => {
  const { moduleCards } = loaderData;
  return <ModulesScreen modules={moduleCards} />;
};

export default StudentModules;
