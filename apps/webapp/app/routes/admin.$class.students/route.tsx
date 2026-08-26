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
import {
  requireClassroomAdmin,
  requireClassroomTeachingTeam,
  assertClassroomMutationAllowed,
} from '~/utils/routeAuth.server';
import { SearchInput } from '~/components';
import type { Route } from './+types/route';

/**
 * A roster row as it leaves the loader.
 *
 * The contact and grade fields are OPTIONAL because they are only included for
 * an OWNER (see the loader). Typing them as optional — rather than sending
 * nulls — is what lets the payload omit the keys entirely for other staff.
 */
interface RosterStudent {
  id: string;
  name: string | null;
  login: string | null;
  image: string | null;
  is_grader: boolean;
  has_accepted_invite: boolean;
  email?: string | null;
  provider_email?: string | null;
  school_id?: string | null;
  letter_grade?: string | null;
  comment?: string | null;
}

export const loader = async ({ params, request }: Route.LoaderArgs) => {
  const classSlug = params.class!;

  // Reading the roster is a teaching-team right: OWNER, TEACHER and ASSISTANT
  // all need to know who is in the class. The MUTATIONS in this route stay
  // OWNER-only and carry their own gate — see the action below.
  const { classroom, membership } = await requireClassroomTeachingTeam(request, classSlug, {
    resourceType: 'STUDENT_ROSTER',
    action: 'view_roster',
  });

  const students = await ClassmojiService.classroomMembership.findUsersByRole(
    classroom.id,
    'STUDENT'
  );
  invariant(students, 'Error fetching students');

  const invitations = await ClassmojiService.classroomInvite.findInvitesByClassroomId(classroom.id);

  // Contact details (email, provider_email, school_id) and the membership grade
  // fields (letter_grade, comment) are OWNER-only, matching the MCP roster
  // resource. Non-OWNER staff get identity + status only, and the split is done
  // HERE, server-side: the fields are never serialized into the page, so there
  // is nothing for the client to hide.
  const isOwner = membership?.role === 'OWNER';

  const rosterStudents: RosterStudent[] = students.map(s => ({
    id: s.id,
    name: s.name,
    login: s.login,
    image: s.image,
    is_grader: s.is_grader,
    has_accepted_invite: s.has_accepted_invite,
    ...(isOwner
      ? {
          email: s.email,
          provider_email: s.provider_email,
          school_id: s.school_id,
          letter_grade: s.letter_grade,
          comment: s.comment,
        }
      : {}),
  }));

  // Pending invites are shaped the same way: an invite's school_email is a
  // contact field, so only an OWNER receives it.
  const rosterInvitations = invitations.map(inv => ({
    id: inv.id,
    student_name: inv.student_name,
    ...(isOwner ? { school_email: inv.school_email } : {}),
  }));

  return { students: rosterStudents, classroom, invitations: rosterInvitations, isOwner };
};

const StudentsScreen = ({ loaderData }: Route.ComponentProps) => {
  const { students, classroom, invitations, isOwner } = loaderData;
  const { class: classSlug } = useParams();
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  // Merge students and invitations into unified list
  const allStudents = useMemo(() => {
    const inviteList = invitations.map(inv => ({
      id: inv.id,
      name: inv.student_name,
      // Present for an OWNER only — the loader omits it for other staff.
      email: inv.school_email,
      school_id: null,
      login: 'pending-invite',
      has_accepted_invite: false,
      avatar_url: 'https://github.com/github.png?size=460',
      _isInvite: true,
    }));
    return [...students, ...inviteList];
  }, [students, invitations]);

  const filteredStudents = !query
    ? allStudents
    : allStudents.filter(student => {
        const q = query.toLowerCase();
        return (
          student.name?.toLowerCase().includes(q) ||
          student.login?.toLowerCase().includes(q) ||
          student.email?.toLowerCase().includes(q) ||
          (student as Record<string, unknown>).provider_email?.toString().toLowerCase().includes(q)
        );
      });

  return (
    <div className="min-h-full relative">
      <Outlet />
      <div className="flex flex-col gap-3 mt-2 mb-4 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="text-lg font-semibold text-ink-1">Students</h1>

        <div className="flex flex-wrap items-center gap-3">
          <span data-tour="students-search" className="w-full sm:w-auto">
            <SearchInput
              query={query}
              setQuery={setQuery}
              placeholder="Search by name or login..."
              className="w-full sm:w-64"
            />
          </span>

          {isOwner && (
            <Button
              icon={<PlusCircleOutlined />}
              onClick={() => navigate(`/admin/${classSlug}/students/add`)}
              type="primary"
              data-tour="students-add"
            >
              Add Students
            </Button>
          )}
        </div>
      </div>

      <StudentsTable
        students={filteredStudents}
        classroom={classroom}
        query={query}
        isOwner={isOwner}
      />
    </div>
  );
};

export const action = async ({ request, params }: Route.ActionArgs) => {
  const classSlug = params.class!;

  // OWNER-only, deliberately narrower than the loader above: removing a student
  // and revoking an invite are owner operations. This gate is the action's own —
  // widening the roster read must never widen these.
  const { classroom, membership } = await requireClassroomAdmin(request, classSlug, {
    resourceType: 'STUDENT_ROSTER',
    action: 'remove_student',
  });
  assertClassroomMutationAllowed({ status: classroom.status, role: membership!.role });

  const data = await request.json();

  return namedAction(request, {
    async removeStudent() {
      try {
        const run = await tasks.trigger('remove_user_from_organization', {
          payload: {
            user: data.user,
            organization: classroom,
            role: 'STUDENT',
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
