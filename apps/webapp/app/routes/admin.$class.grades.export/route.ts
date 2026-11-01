import { ClassmojiService } from '@classmoji/services';
import { addClassroomAuditLog } from '~/utils/helpers';
import { requireClassroomStaff } from '~/utils/routeAuth.server';
import type { Route } from './+types/route';

/**
 * The gradebook as a CSV download (no page): OWNER and TEACHER, the
 * gradebook's own audience, under both the /admin and /teacher prefixes. The
 * file carries every current student's email and school id along with their
 * grades, so each download is audited.
 */
export const loader = async ({ request, params }: Route.LoaderArgs) => {
  const { userId, classroom, membership } = await requireClassroomStaff(request, params.class!, {
    resourceType: 'GRADES',
    action: 'export_grades',
  });

  const gradebook = await ClassmojiService.gradebookExport.buildGradebookExport(classroom);

  await addClassroomAuditLog({
    classroomId: classroom.id,
    userId,
    role: membership!.role,
    action: 'VIEW',
    resourceType: 'GRADES',
    metadata: {
      tool: 'web:grades.export_csv',
      students: gradebook.studentCount,
      assignments: gradebook.assignmentCount,
    },
    dedupe: false,
  });

  const date = new Date().toISOString().slice(0, 10);
  // A BOM, so Excel reads accented names as UTF-8.
  return new Response('﻿' + ClassmojiService.gradebookExport.toCsv(gradebook), {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${classroom.slug}-grades-${date}.csv"`,
      'Cache-Control': 'no-store',
    },
  });
};
