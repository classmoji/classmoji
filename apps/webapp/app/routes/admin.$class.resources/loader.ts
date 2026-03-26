import { ClassmojiService } from '@classmoji/services';
import prisma from '@classmoji/database';
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
    // @ts-expect-error - service method accepts options parameter at runtime but types don't reflect it
    ClassmojiService.module.findByClassroomSlug(classSlug, { includeAssignments: true }),
    ClassmojiService.page.findByClassroomId(classroom.id, { includeLinks: true }),
    prisma!.slide.findMany({
      where: { classroom_id: classroom.id },
      include: { links: true },
      orderBy: { title: 'asc' },
    }),
  ]);

  return { modules, pages, slides };
};
