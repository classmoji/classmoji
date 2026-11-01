import type { ActionFunctionArgs } from 'react-router';
import { prisma, requirePlatformAdmin } from '~/utils/db.server';
import { platformAudit } from '~/utils/audit.server';

/**
 * Step one of "View as": records who is about to be impersonated, where, and
 * why, and answers with the webapp path to land on. The browser then starts
 * the better-auth impersonation itself (it needs the admin's cookie) and goes
 * there.
 *
 * Everything that decides the landing comes from the database, never from the
 * request: the classroom's slug is looked up, and the role is the target's
 * highest membership in it.
 */
const ROLE_ORDER = ['OWNER', 'TEACHER', 'ASSISTANT', 'STUDENT'] as const;
const LANDING: Record<(typeof ROLE_ORDER)[number], (slug: string) => string> = {
  OWNER: slug => `/admin/${slug}/dashboard`,
  TEACHER: slug => `/teacher/${slug}`,
  ASSISTANT: slug => `/assistant/${slug}`,
  STUDENT: slug => `/student/${slug}`,
};
const REASON_MAX = 200;

export async function action({ request }: ActionFunctionArgs) {
  const { user: admin } = await requirePlatformAdmin(request);
  const form = await request.formData();
  const userId = String(form.get('userId') ?? '');
  const classroomSlug = String(form.get('classroomSlug') ?? '');
  const reason = String(form.get('reason') ?? '').trim().slice(0, REASON_MAX);

  if (!userId) return Response.json({ error: 'No person named.' }, { status: 400 });
  if (userId === admin.id) return Response.json({ error: 'That is you.' }, { status: 400 });

  const target = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, name: true, email: true },
  });
  if (!target) return Response.json({ error: 'That person no longer exists.' }, { status: 404 });

  let landing = '/';
  let classroom: { id: string; name: string; slug: string } | null = null;
  if (classroomSlug) {
    const memberships = await prisma.classroomMembership.findMany({
      where: { user_id: userId, classroom: { slug: classroomSlug } },
      select: { role: true, classroom: { select: { id: true, name: true, slug: true } } },
    });
    const role = ROLE_ORDER.find(r => memberships.some(m => m.role === r));
    if (role) {
      classroom = memberships[0].classroom;
      landing = LANDING[role](encodeURIComponent(classroom.slug));
    }
  }

  await platformAudit({
    actorId: admin.id,
    action: 'impersonate',
    targetType: 'user',
    targetId: target.id,
    classroomId: classroom?.id ?? null,
    data: {
      targetName: target.name ?? target.email ?? target.id,
      ...(classroom ? { classroomName: classroom.name } : {}),
      ...(reason ? { reason } : {}),
    },
  });

  return Response.json({ landing });
}
