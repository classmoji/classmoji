import { Modal, Alert, Input, Form, Select } from 'antd';
import { useEffect, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router';

import { tasks } from '@trigger.dev/sdk';

import { useDisclosure, useGlobalFetcher } from '~/hooks';
import { ClassmojiService } from '@classmoji/services';
import { requireStudentAccess, waitForRunCompletion } from '~/utils/helpers';

export const loader = async ({ params, request }) => {
  const { userId } = await requireStudentAccess(
    request,
    params.class,
    { resourceType: 'REGRADE_REQUESTS', action: 'view_new_regrade_form' }
  );

  // Fetch both individual AND team assignments so team assignments appear in dropdown
  const studentAssignments = await ClassmojiService.helper.findAllAssignmentsForStudent(
    userId,
    params.class
  );
  return { studentAssignments };
};

const NewRegradeRequest = ({ loaderData }) => {
  const { studentAssignments } = loaderData;
  const { show, close, visible } = useDisclosure();
  const [assignment, setAssignment] = useState(null);
  const [comment, setComment] = useState('');
  const { fetcher, notify } = useGlobalFetcher();
  const navigate = useNavigate();
  const { class: classSlug } = useParams();
  const { state } = useLocation();

  useEffect(() => {
    show();
  }, []);

  useEffect(() => {
    if (state?.assignment) {
      setAssignment(state.assignment.id);
    }
  }, [state]);

  const handleSubmit = () => {
    notify('REQUEST_REGRADE', 'Submitting resubmit request...');

    fetcher.submit(
      {
        student_comment: comment,
        repository_assignment_id: assignment,
      },
      {
        method: 'POST',
        action: `/student/${classSlug}/regrade-requests/new`,
        encType: 'application/json',
      }
    );

    close();
    navigate(`/student/${classSlug}/regrade-requests`);
  };

  return (
    <Modal
      open={visible}
      onCancel={() => {
        close();
        navigate(-1);
      }}
      onOk={handleSubmit}
      okText="Request a resubmit"
      title="Request a resubmit"
      destroyOnClose={true}
      okButtonProps={{
        disabled: !comment || !assignment,
      }}
      cancelButtonProps={{
        danger: true,
        type: 'primary',
      }}
    >
      <Alert message="Explain your resubmit request below." type="info" showIcon banner />

      <p className="my-4 text-[13px] text-gray-500">
        If you want to resubmit your assignment, you can use this form to contact the TA
        responsible. Make sure to review your course resubmit policy before submitting.
      </p>

      <Form layout="vertical">
        <Form.Item label="Assignment" name="assignment" required>
          <Select
            onChange={setAssignment}
            value={assignment}
            defaultValue={assignment}
            options={studentAssignments.map(repoAssignment => ({
              label: repoAssignment.assignment.title,
              value: repoAssignment.id,
            }))}
          />
        </Form.Item>

        <Form.Item label="Comment" name="comment" required>
          <Input.TextArea rows={8} value={comment} onChange={e => setComment(e.target.value)} />
        </Form.Item>
      </Form>
    </Modal>
  );
};

export const action = async ({ request, params }) => {
  const { userId, classroom } = await requireStudentAccess(
    request,
    params.class,
    { resourceType: 'REGRADE_REQUESTS', action: 'submit_regrade_request' }
  );

  const data = await request.json();
  const repositoryAssignment = await ClassmojiService.repositoryAssignment.findById(
    data.repository_assignment_id
  );

  // Verify assignment belongs to this classroom AND this user (IDOR protection)
  if (
    !repositoryAssignment ||
    repositoryAssignment.repository.classroom_id !== classroom.id ||
    repositoryAssignment.repository.student_id !== userId
  ) {
    throw new Response('Assignment not found or not yours', { status: 403 });
  }

  try {
    const run = await tasks.trigger('request_regrade', {
      classroom_id: classroom.id,
      repositoryAssignment: repositoryAssignment,
      student_id: userId, // Use authenticated userId, NOT data.student_id
      student_comment: data.student_comment,
      previous_grade: repositoryAssignment.grades.map(grade => grade.emoji),
    });

    await waitForRunCompletion(run.id);

    return {
      action: 'REQUEST_REGRADE',
      success: 'Regrade request submitted',
    };
  } catch (error) {
    console.error('request_regrade failed:', error);
    return {
      action: 'REQUEST_REGRADE',
      error: 'Failed to submit regrade request. Please try again.',
    };
  }
};

export default NewRegradeRequest;
