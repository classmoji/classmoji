import { Modal, Input } from 'antd';
import { useNavigate } from 'react-router';
import { useState, useEffect } from 'react';

import { ClassmojiService } from '@classmoji/services';
import { useGlobalFetcher } from '~/hooks';
import { UserThumbnailView } from '~/components';
import { assertClassroomAccess, assertClassroomMutationAllowed } from '~/utils/helpers';
import type { Route } from './+types/route';

export const loader = async ({ params, request }: Route.LoaderArgs) => {
  const { login, class: classSlug } = params;

  // Authorize: OWNER/TEACHER can view student grade comments. Same list as the
  // parent grades route, which is what lets this drawer be served under both
  // the /admin and /teacher prefixes.
  const { classroom } = await assertClassroomAccess({
    request,
    classroomSlug: classSlug!,
    allowedRoles: ['OWNER', 'TEACHER'],
    resourceType: 'GRADES',
    attemptedAction: 'view_student_grade',
  });

  // One classroom-scoped, role-pinned, projected lookup.
  //
  // This used to resolve the student with the GLOBAL `user.findByLogin`, which
  // includes every classroom that student belongs to, each one's
  // git_organization row and each one's owner memberships — and this route
  // returned it. There is no entry.server.tsx here, so React Router's default
  // entry serialises whatever a loader returns straight into the page: the
  // drawer was shipping other classrooms' data to render a comment box.
  //
  // The membership was then read with no role filter. One person can hold
  // several roles in a classroom, so the unfiltered lookup could return, say,
  // their grader row — and the drawer both reads the comment from it and posts
  // its id back as the write target.
  const enrollment = await ClassmojiService.classroomMembership.findStudentByLoginInClassroom(
    classroom.id,
    login!
  );

  // No such student in THIS classroom. An unknown login and a login that
  // belongs to someone outside the classroom are indistinguishable from here,
  // which is the intent. Previously this dereferenced a null user and answered
  // with a 500.
  if (!enrollment) {
    throw new Response('Student not found', { status: 404 });
  }

  return {
    student: {
      id: enrollment.user.id,
      name: enrollment.user.name,
      login: enrollment.user.login,
      // UserThumbnailView reads `avatar_url`; the User column is `image`.
      avatar_url: enrollment.user.image,
    },
    membership: { id: enrollment.id, comment: enrollment.comment },
  };
};

const GradeComment = ({ loaderData }: Route.ComponentProps) => {
  const { student, membership } = loaderData;
  const [comment, setComment] = useState(membership?.comment || '');
  const [visible, setVisible] = useState(false);
  const { fetcher, notify } = useGlobalFetcher();

  const navigate = useNavigate();
  useEffect(() => {
    setVisible(true);
  }, []);

  const handleSave = () => {
    setVisible(false);
    navigate(-1);

    notify('ADD_GRADE_COMMENT', 'Saving comment...');

    fetcher!.submit(
      {
        membershipId: membership!.id,
        comment,
      },
      { method: 'post', encType: 'application/json', action: '?/action' }
    );
  };

  return (
    <Modal
      title="Student Performance Feedback"
      open={visible}
      onOk={handleSave}
      onCancel={() => {
        setVisible(false);
        navigate(-1);
      }}
      okText="Save"
    >
      <div className="py-4">
        <UserThumbnailView user={student} />
      </div>
      <p className="pb-4 text-gray-500 text-sm">
        You can provide comments on <span className=" underline text-sm">{student?.name}</span>
        &rsquo;s performance
      </p>
      <Input.TextArea rows={8} value={comment} onChange={e => setComment(e.target.value)} />
    </Modal>
  );
};

export const action = async ({ params, request }: Route.ActionArgs) => {
  const { class: classSlug } = params;

  // Authorize: OWNER/TEACHER can modify student grade comments. This action
  // carries its own gate — a layout loader does not gate it, because React
  // Router runs the leaf action before any loader.
  const { classroom, membership } = await assertClassroomAccess({
    request,
    classroomSlug: classSlug!,
    allowedRoles: ['OWNER', 'TEACHER'],
    resourceType: 'GRADES',
    attemptedAction: 'modify_student_grade',
  });
  assertClassroomMutationAllowed({ status: classroom.status, role: membership!.role });

  const data = await request.json();
  const membershipId = typeof data?.membershipId === 'string' ? data.membershipId : null;
  // An empty comment is legitimate — it clears the note — so this checks the
  // type, not the truthiness.
  const comment = typeof data?.comment === 'string' ? data.comment : null;

  if (!membershipId || comment === null) {
    return { action: 'ADD_GRADE_COMMENT', error: 'Invalid request.' };
  }

  // Authorization binds to `params.class`, but the membership id arrives in the
  // JSON body — so the write is bound to `{ id, classroom_id }` and only counts
  // when it matched exactly one row. Same shape as the page and quiz writes on
  // this branch.
  const updated = await ClassmojiService.classroomMembership.updateInClassroom(
    membershipId,
    classroom.id,
    { comment }
  );

  if (!updated) {
    return { action: 'ADD_GRADE_COMMENT', error: 'Student not found.' };
  }

  return { action: 'ADD_GRADE_COMMENT', success: 'Saved comment.' };
};

export default GradeComment;
