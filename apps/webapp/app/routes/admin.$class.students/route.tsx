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
import { pickOwnerOnlyContactFields } from '~/utils/studentFields.server';
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
  /** UserThumbnailView reads `avatar_url`; the User model calls it `image`. */
  avatar_url: string | null;
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
  // `membership.role` is the caller's HIGHEST role in this classroom —
  // assertClassroomAccess resolves it in privilege order, so an owner who also
  // holds another role here still resolves as OWNER.
  const isRealOwner = membership?.role === 'OWNER';

  // This same loader serves /assistant/:class/students and
  // /teacher/:class/students, which is where an owner lands when they use
  // "Preview as". A preview that still showed them owner-only columns would
  // answer the wrong question — the control exists to show what that role
  // actually sees.
  const isAdminPrefix = new URL(request.url).pathname.startsWith('/admin/');

  // NARROWING ONLY, and it must stay that way: this can remove fields from a
  // response, never add them. A non-owner is not an owner on any prefix, so the
  // `isRealOwner &&` conjunct is what guarantees that — the prefix can only
  // subtract from what the role already allowed. (Pinned by the preview test in
  // __tests__/studentsRoster.test.ts.)
  const isOwner = isRealOwner && isAdminPrefix;

  // Whether the viewer may MUTATE the roster from this page. The /assistant and
  // /teacher routes export no `action` and have no nested detail route, so an
  // owner on those prefixes would otherwise be shown controls that post to a
  // route with no action (405) and a View button pointing at a route that does
  // not exist (404). Only the /admin prefix carries the mutations.
  const canManage = isOwner;

  const rosterStudents: RosterStudent[] = students.map(s => ({
    id: s.id,
    name: s.name,
    login: s.login,
    image: s.image,
    avatar_url: s.image,
    is_grader: s.is_grader,
    has_accepted_invite: s.has_accepted_invite,
    ...pickOwnerOnlyContactFields(s, isOwner),
    // The membership grade fields are gated HERE rather than in the shared
    // helper: they are OWNER-only on this roster, but they are the whole point
    // of the gradebook, which serves them to a TEACHER too. Only the contact
    // trio is a policy the two screens share.
    ...(isOwner ? { letter_grade: s.letter_grade, comment: s.comment } : {}),
  }));

  // Pending invites are shaped the same way: an invite's school_email is a
  // contact field, so only an OWNER receives it.
  const rosterInvitations = invitations.map(inv => ({
    id: inv.id,
    student_name: inv.student_name,
    ...(isOwner ? { school_email: inv.school_email } : {}),
  }));

  return {
    students: rosterStudents,
    classroom,
    invitations: rosterInvitations,
    isOwner,
    canManage,
  };
};

const StudentsScreen = ({ loaderData }: Route.ComponentProps) => {
  const { students, classroom, invitations, isOwner, canManage } = loaderData;
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

  // Search over the fields the row actually carries. Name and login are always
  // present; the contact fields exist only in an OWNER's payload, so they widen
  // the search for an owner and are simply absent for other staff — which is
  // why the placeholder promises name or login.
  const filteredStudents = !query
    ? allStudents
    : allStudents.filter(student => {
        const q = query.toLowerCase();
        const row = student as Record<string, unknown>;
        const haystack = [student.name, student.login, row.email, row.provider_email];
        return haystack.some(field => typeof field === 'string' && field.toLowerCase().includes(q));
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

          {canManage && (
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
        canManage={canManage}
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
