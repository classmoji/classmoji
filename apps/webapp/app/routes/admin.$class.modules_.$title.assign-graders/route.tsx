import { Modal, Form, Select, Radio } from 'antd';
import { useState, useEffect } from 'react';
import { useNavigate, useLocation, useParams } from 'react-router';
import { nanoid } from 'nanoid';
import { auth } from '@trigger.dev/sdk';

import { useDisclosure, useGlobalFetcher } from '~/hooks';
import { ClassmojiService } from '@classmoji/services';
import { useCallout } from '@classmoji/ui-components';
import { assignGradersToAssignmentsHandler } from './utils';
import { requireClassroomAdmin } from '~/utils/routeAuth.server';
import type { Route } from './+types/route';

export const loader = async ({ params, request }: Route.LoaderArgs) => {
  const { class: classSlug, title } = params;

  await requireClassroomAdmin(request, classSlug!, {
    resourceType: 'MODULES',
    action: 'view_grader_assignment',
  });

  const module = await ClassmojiService.module.findBySlugAndTitle(classSlug!, title!);
  return { module };
};

const AssignGraders = ({ loaderData }: Route.ComponentProps) => {
  const { module } = loaderData;
  const { class: classSlug, title } = useParams();

  const [selectedAssignmentId, setSelectedAssignmentId] = useState(null);
  const [templateAssignmentId, setTemplateAssignmentId] = useState(null);
  const [method, setMethod] = useState('RANDOM');
  const { show, visible } = useDisclosure();
  const navigate = useNavigate();
  const { fetcher } = useGlobalFetcher();
  const { pathname } = useLocation();
  const callout = useCallout();

  useEffect(() => {
    show();
  }, []);

  const reset = () => {
    setSelectedAssignmentId(null);
    setTemplateAssignmentId(null);
    setMethod('RANDOM');
  };

  useEffect(() => {
    setTemplateAssignmentId(null);
  }, [selectedAssignmentId]);

  const onSubmit = () => {
    if (!selectedAssignmentId) {
      callout.show({ variant: 'error', title: 'Please select an assignment' });
      return;
    }

    if (method === 'EXISTING' && !templateAssignmentId) {
      callout.show({ variant: 'error', title: 'Please select a template assignment' });
      return;
    }

    handleOk({ selectedAssignmentId, method, templateAssignmentId });

    reset();

    navigate(`/admin/${classSlug}/modules/${title}`);
  };

  const handleCancel = () => {
    navigate(-1);
  };

  const handleOk = (values: Record<string, unknown>) => {
    fetcher!.submit(JSON.stringify(values), {
      method: 'post',
      action: pathname,
      encType: 'application/json',
    });

    navigate(-1);
  };

  return (
    <Modal
      open={visible}
      onOk={onSubmit}
      onCancel={handleCancel}
      okText="Assign"
      title="Assign graders to assignment"
    >
      <Form layout="vertical">
        <Form.Item label="Assignment title">
          <Select
            placeholder="Select assignment"
            options={module!.assignments.map((assignment: { title: string; id: string }) => ({
              label: assignment.title,
              value: assignment.id,
            }))}
            value={selectedAssignmentId}
            onChange={setSelectedAssignmentId}
          />
        </Form.Item>
        <Form.Item label="How would you like to assign graders?">
          <Radio.Group value={method} onChange={e => setMethod(e.target.value)}>
            <Radio value="RANDOM">Randomly</Radio>
            <Radio value="EXISTING">From existing assignment</Radio>
          </Radio.Group>
        </Form.Item>
        {method === 'EXISTING' && (
          <Form.Item label="Select assignment from which grader assignment should be based on?">
            <Select
              placeholder="Select template assignment"
              options={module!.assignments
                .map((assignment: { title: string; id: string }) => ({
                  label: assignment.title,
                  value: assignment.id,
                }))
                .filter((a: { value: string }) => a.value !== selectedAssignmentId)}
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

  const { classroom: _classroom, userId: _userId } = await requireClassroomAdmin(
    request,
    classSlug!,
    {
      resourceType: 'MODULES',
      action: 'assign_graders',
    }
  );

  const data = await request.json();
  const sessionId = nanoid();

  const accessToken = await auth.createPublicToken({
    scopes: {
      read: {
        tags: [`session_${sessionId}`],
      },
    },
  });

  const { numAssignmentsToAddGradersTo } = await assignGradersToAssignmentsHandler(
    { ...data, classroomSlug: classSlug },
    sessionId
  );

  const triggerSession = {
    accessToken,
    id: sessionId,
    numAssignmentsToAddGradersTo,
  };

  return { triggerSession };
};

export default AssignGraders;
