import { Outlet } from 'react-router';
import { UserHeader } from '~/components';
import { getAuthSession } from '@classmoji/auth/server';
import { notificationService } from '@classmoji/services';
import getPrisma from '@classmoji/database';
import type { NotificationRole, BellNotification } from '~/components/features/notifications';
import type { Route } from './+types/route';

export const loader = async ({ request }: Route.LoaderArgs) => {
  const authData = await getAuthSession(request);
  const userId = authData?.userId ?? null;

  if (!userId) {
    return {
      notifications: [] as BellNotification[],
      unreadCount: 0,
      membershipRoles: {} as Record<string, NotificationRole[]>,
    };
  }

  const [{ items, unreadCount }, memberships] = await Promise.all([
    notificationService.getForBell(userId),
    getPrisma().classroomMembership.findMany({
      where: { user_id: userId },
      select: { classroom_id: true, role: true },
    }),
  ]);

  const notifications: BellNotification[] = items.map(n => ({
    id: n.id,
    type: n.type,
    title: n.title,
    resource_type: n.resource_type,
    resource_id: n.resource_id,
    read_at: n.read_at ? n.read_at.toISOString() : null,
    created_at: n.created_at.toISOString(),
    classroom: n.classroom,
    metadata: (n.metadata ?? null) as Record<string, unknown> | null,
  }));

  const membershipRoles: Record<string, NotificationRole[]> = {};
  for (const m of memberships) {
    const role = m.role as NotificationRole;
    if (!membershipRoles[m.classroom_id]?.includes(role)) {
      membershipRoles[m.classroom_id] = [...(membershipRoles[m.classroom_id] ?? []), role];
    }
  }

  return { notifications, unreadCount, membershipRoles };
};

const UserLayout = () => {
  return (
    <div
      className="min-h-screen bg-[#FDFDFD] dark:bg-[#1d1d1d]"
    >
      <UserHeader />
      <div className="max-w-[1200px] mx-auto pt-4 sm:pt-7 pb-20">
        <Outlet />
      </div>
    </div>
  );
};

export default UserLayout;
