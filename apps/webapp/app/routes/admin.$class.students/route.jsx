import { Outlet, useNavigate, useParams } from 'react-router';
import { namedAction } from 'remix-utils/named-action';
import invariant from 'tiny-invariant';
import { tasks } from '@trigger.dev/sdk';
import { useState, useMemo } from 'react';
import { Button } from 'antd';
import { PlusCircleOutlined } from '@ant-design/icons';

import { ClassmojiService } from '@classmoji/services';
import StudentsTable from './StudentsTable';
import { ActionTypes } from '~/constants';
import { waitForRunCompletion } from '~/utils/helpers';
import { requireClassroomAdmin } from '~/utils/routeAuth.server';
import { PageHeader, RequireRole, SearchInput } from '~/components';

export const loader = async ({ params, request }) => {
  const { class: classSlug } = params;

  const { classroom } = await requireClassroomAdmin(request, classSlug, {
    resourceType: 'STUDENT_ROSTER',
    action: 'view_roster',
  });

  const students = await ClassmojiService.classroomMembership.findUsersByRole(
    classroom.id,
    'STUDENT'
  );
  invariant(students, 'Error fetching students');

  const invitations = await ClassmojiService.classroomInvite.findInvitesByClassroomId(classroom.id);

  return { students, classroom, invitations };
};

const StudentsScreen = ({ loaderData }) => {
  const { students, classroom, invitations } = loaderData;
  const { class: classSlug } = useParams();
  const navigate = useNavigate();
  const [query, setQuery] = useState('');

  // Merge students and invitations into unified list
  const allStudents = useMemo(() => {
    const inviteList = invitations.map(inv => ({
      id: inv.id,
      name: inv.student_name,
      email: inv.school_email,
      student_id: inv.student_id,
      login: 'pending-invite',
      has_accepted_invite: false,
      avatar_url: 'https://github.com/github.png?size=460',
      _isInvite: true,
    }));
    return [...students, ...inviteList];
  }, [students, invitations]);

  const filteredStudents = !query
    ? allStudents
    : allStudents.filter(
        student =>
          student.name?.toLowerCase().includes(query.toLowerCase()) ||
          student?.login?.toLowerCase().includes(query.toLowerCase())
      );

  return (
    <>
      <Outlet />
      <div className="flex justify-between items-center">
        <PageHeader title="Students" routeName="students" />

        <div className="flex gap-4">
          <SearchInput
            query={query}
            setQuery={setQuery}
            placeholder="Search by name or login..."
            className="w-64"
          />

          <RequireRole roles={['OWNER']}>
            <Button
              icon={<PlusCircleOutlined />}
              onClick={() => navigate(`/admin/${classSlug}/students/add`)}
              type="primary"
            >
              Add Students
            </Button>
          </RequireRole>
        </div>
      </div>

      <StudentsTable students={filteredStudents} classroom={classroom} query={query} />
    </>
  );
};

export const action = async ({ request, params }) => {
  const { class: classSlug } = params;

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
      } catch (error) {
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
      } catch (error) {
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
