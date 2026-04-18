import { Outlet, useNavigate, useParams } from 'react-router';
import { namedAction } from 'remix-utils/named-action';
import { tasks } from '@trigger.dev/sdk';

import { ClassmojiService } from '@classmoji/services';
import { ActionTypes } from '~/constants';
import { waitForRunCompletion } from '~/utils/helpers';
import { requireClassroomAdmin } from '~/utils/routeAuth.server';
import { loadRosterScreenData } from '~/utils/rosterScreen.server';
import { RosterScreen } from '~/components/features/roster';
import type { Route } from './+types/route';

export const loader = async ({ params, request }: Route.LoaderArgs) => {
  const classSlug = params.class!;

  const { classroom } = await requireClassroomAdmin(request, classSlug, {
    resourceType: 'STUDENT_ROSTER',
    action: 'view_roster',
  });

  const students = await loadRosterScreenData(classroom.id, classSlug);

  return { students };
};

const StudentsScreen = ({ loaderData }: Route.ComponentProps) => {
  const { students } = loaderData;
  const { class: classSlug } = useParams();
  const navigate = useNavigate();

  return (
    <>
      <Outlet />
      <RosterScreen
        students={students}
        onAddStudents={() => navigate(`/admin/${classSlug}/students/add`)}
      />
    </>
  );
};

export const action = async ({ request, params }: Route.ActionArgs) => {
  const classSlug = params.class!;

  const { classroom } = await requireClassroomAdmin(request, classSlug, {
    resourceType: 'STUDENT_ROSTER',
    action: 'remove_student',
  });

  const data = await request.json();

  return namedAction(request, {
    async removeStudent() {
      try {
        const run = await tasks.trigger('remove_user_from_organization', {
          payload: {
            user: data.user,
            organization: classroom,
          },
        });

        await waitForRunCompletion(run.id);

        return {
          success: 'Removed student',
          action: ActionTypes.REMOVE_USER,
        };
      } catch (error: unknown) {
        console.error('removeStudent failed:', error);
        return {
          action: ActionTypes.REMOVE_USER,
          error: 'Failed to remove student. Please try again.',
        };
      }
    },

    async revokeInvite() {
      try {
        await ClassmojiService.classroomInvite.deleteInvite(data.inviteId);

        return {
          success: 'Invite revoked',
          action: 'REVOKE_INVITE',
        };
      } catch (error: unknown) {
        console.error('revokeInvite failed:', error);
        return {
          action: 'REVOKE_INVITE',
          error: 'Failed to revoke invite. Please try again.',
        };
      }
    },
  });
};

export default StudentsScreen;
