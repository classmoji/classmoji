import { ClassmojiService } from '@classmoji/services';
import getPrisma from '@classmoji/database';
import { assertClassroomAccess } from '~/utils/helpers';
import type { Route } from './+types/route';

export const loader = async ({ request, params }: Route.LoaderArgs) => {
  const classSlug = params.class!;

  const { classroom } = await assertClassroomAccess({
    request,
    classroomSlug: classSlug,
    allowedRoles: ['OWNER', 'TEACHER'],
    resourceType: 'RESOURCES',
    attemptedAction: 'view_resources',
  });

  const [modules, pages, slides] = await Promise.all([
    ClassmojiService.module.findByClassroomSlug(classSlug, { includeAssignments: true }),
    ClassmojiService.page.findByClassroomId(classroom.id, { includeLinks: true }),
    getPrisma().slide.findMany({
      where: { classroom_id: classroom.id },
      include: { links: true },
      orderBy: { title: 'asc' },
    }),
  ]);

  return { modules, pages, slides };
};
