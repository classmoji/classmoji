import { Modal, Form, Select, Radio } from 'antd';
import { useState, useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router';
import { nanoid } from 'nanoid';
import { auth } from '@trigger.dev/sdk';

import { useDisclosure, useGlobalFetcher } from '~/hooks';
import { useGitWeb } from '~/hooks/useGitWeb';
import { AssignGradersError, ClassmojiService } from '@classmoji/services';
import { useCallout } from '@classmoji/ui-components';
import { assignGradersToAssignmentsHandler } from './utils';
import { requireClassroomAdmin, assertClassroomMutationAllowed } from '~/utils/routeAuth.server';
import type { Route } from './+types/route';

/**
 * Bulk grader assignment for ONE assignment (the page it opens over): spread
 * the grader pool randomly, or copy the grader of each student repo from a
 * sibling assignment on the same repository.
 */
export const loader = async ({ params, request }: Route.LoaderArgs) => {
  const { class: classSlug, id } = params;

  const { classroom } = await requireClassroomAdmin(request, classSlug!, {
    resourceType: 'ASSIGNMENTS',
    action: 'view_grader_assignment',
  });

  const assignment = await ClassmojiService.assignment.findByIdInClassroom(id!, classroom.id);
  if (!assignment?.repository) throw new Response('Assignment not found', { status: 404 });

  const siblings = (await ClassmojiService.assignment.findByRepositoryId(assignment.repository.id))
    .filter(a => a.id !== assignment.id)
    .map(a => ({ id: a.id, title: a.title }));

  return { assignment: { id: assignment.id, title: assignment.title }, siblings };
};

const AssignGraders = ({ loaderData }: Route.ComponentProps) => {
  const { assignment, siblings } = loaderData;
  const web = useGitWeb();

  const [templateAssignmentId, setTemplateAssignmentId] = useState<string | null>(null);
  const [method, setMethod] = useState('RANDOM');
  const { show, visible } = useDisclosure();
  const navigate = useNavigate();
  const { fetcher } = useGlobalFetcher();
  const { pathname } = useLocation();
  const callout = useCallout();

  useEffect(() => {
    show();
  }, []);

  const back = () => navigate(pathname.replace(/\/assign-graders\/?$/, ''));

  const onSubmit = () => {
    if (method === 'EXISTING' && !templateAssignmentId) {
      callout.show({ variant: 'error', title: 'Please select a template assignment' });
      return;
    }

    fetcher!.submit(
      JSON.stringify({ selectedAssignmentId: assignment.id, method, templateAssignmentId }),
      { method: 'post', action: pathname, encType: 'application/json' }
    );

    back();
  };

  return (
    <Modal
      open={visible}
      onOk={onSubmit}
      onCancel={back}
      okText="Assign"
      title={`Assign graders to ${assignment.title}`}
    >
      <Form layout="vertical">
        <Form.Item label="How would you like to assign graders?">
          <Radio.Group value={method} onChange={e => setMethod(e.target.value)}>
            <Radio value="RANDOM">Randomly</Radio>
            <Radio value="EXISTING" disabled={siblings.length === 0}>
              Same graders as another assignment on this {web.terms.repo}
            </Radio>
          </Radio.Group>
        </Form.Item>
        {method === 'EXISTING' && (
          <Form.Item label="Copy each student's grader from">
            <Select
              placeholder="Select assignment"
              options={siblings.map(a => ({ label: a.title, value: a.id }))}
              value={templateAssignmentId}
              onChange={setTemplateAssignmentId}
            />
          </Form.Item>
        )}
      </Form>
    </Modal>
  );
};

export const action = async ({ params, request }: Route.ActionArgs) => {
  const { class: classSlug } = params;

  const { classroom, membership } = await requireClassroomAdmin(request, classSlug!, {
    resourceType: 'ASSIGNMENTS',
    action: 'assign_graders',
  });
  assertClassroomMutationAllowed({ status: classroom.status, role: membership!.role });

  const data = await request.json();
  const sessionId = nanoid();

  const accessToken = await auth.createPublicToken({
    scopes: { read: { tags: [`session_${sessionId}`] } },
  });

  let numAssignmentsToAddGradersTo: number;
  try {
    ({ numAssignmentsToAddGradersTo } = await assignGradersToAssignmentsHandler(
      { ...data, classroomId: classroom.id },
      sessionId
    ));
  } catch (error: unknown) {
    // The service's caller-fixable failures (no graders flagged, missing
    // template) carry a usable message; surface it as a callout instead of
    // letting it reach the route error boundary. Anything else still throws.
    if (error instanceof AssignGradersError) {
      console.error('assignGraders failed:', error);
      return { error: error.message };
    }
    throw error;
  }

  return { triggerSession: { accessToken, id: sessionId, numAssignmentsToAddGradersTo } };
};

export default AssignGraders;
