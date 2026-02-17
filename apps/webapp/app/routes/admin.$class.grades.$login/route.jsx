import { Modal, Input } from 'antd';
import { useNavigate } from 'react-router';
import { useState, useEffect } from 'react';

import { ClassmojiService } from '@classmoji/services';
import { useGlobalFetcher } from '~/hooks';
import { UserThumbnailView } from '~/components';
import { assertClassroomAccess } from '~/utils/helpers';

export const loader = async ({ params, request }) => {
  const { login, class: classSlug } = params;

  // Authorize: only OWNER/ASSISTANT can view student grade comments
  const { classroom } = await assertClassroomAccess({
    request,
    classroomSlug: classSlug,
    allowedRoles: ['OWNER', 'ASSISTANT'],
    resourceType: 'GRADES',
    attemptedAction: 'view_student_grade',
  });

  const student = await ClassmojiService.user.findByLogin(login);
  const membership = await ClassmojiService.classroomMembership.findByClassroomAndUser(
    classroom.id,
    student.id
  );

  // Only return what the component needs - organization not needed in UI
  return { student, membership };
};

const GradeComment = ({ loaderData }) => {
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

    fetcher.submit(
      {
        membershipId: membership.id,
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
      <p className="pb-4 text-gray-500 text-[13px]">
        You can provide comments on <span className=" underline text-[13px]">{student?.name}</span>
        &rsquo;s performance
      </p>
      <Input.TextArea rows={8} value={comment} onChange={e => setComment(e.target.value)} />
    </Modal>
  );
};

export const action = async ({ params, request }) => {
  const { class: classSlug } = params;

  // Authorize: only OWNER/ASSISTANT can modify student grade comments
  await assertClassroomAccess({
    request,
    classroomSlug: classSlug,
    allowedRoles: ['OWNER', 'ASSISTANT'],
    resourceType: 'GRADES',
    attemptedAction: 'modify_student_grade',
  });

  const data = await request.json();
  const { membershipId, comment } = data;
  await ClassmojiService.classroomMembership.updateById(membershipId, { comment });

  return { action: 'ADD_GRADE_COMMENT', success: 'Saved comment.' };
};

export default GradeComment;
