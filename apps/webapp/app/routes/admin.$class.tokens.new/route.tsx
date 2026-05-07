import { Modal, Form, InputNumber, Button, Select, Checkbox, Input } from 'antd';
import { IconCoin, IconUsers, IconInfoCircle } from '@tabler/icons-react';

import { useState, useEffect } from 'react';
import { auth } from '@trigger.dev/sdk';
import { namedAction } from 'remix-utils/named-action';
import { nanoid } from 'nanoid';

import { ClassmojiService } from '@classmoji/services';
import { useGlobalFetcher, useRouteDrawer } from '~/hooks';
import Tasks from '@classmoji/tasks';
import { requireClassroomAdmin } from '~/utils/routeAuth.server';
import type { Route } from './+types/route';

const InlineRow = ({
  icon: Icon,
  children,
}: {
  icon: React.ComponentType<{ size?: number; className?: string; strokeWidth?: number }>;
  children: React.ReactNode;
}) => (
  <div className="flex items-start gap-3 py-1.5">
    <Icon
      size={18}
      strokeWidth={1.75}
      className="shrink-0 mt-2.5 text-gray-400 dark:text-gray-500"
    />
    <div className="flex-1 min-w-0">{children}</div>
  </div>
);

export const loader = async ({ params, request }: Route.LoaderArgs) => {
  const { class: classSlug } = params;

  const { classroom } = await requireClassroomAdmin(request, classSlug!, {
    resourceType: 'TOKEN_GRANT',
    action: 'view_form',
  });

  const students = await ClassmojiService.classroomMembership.findUsersByRole(
    classroom.id,
    'STUDENT'
  );
  return { students };
};

const AdminTokensNew = ({ loaderData }: Route.ComponentProps) => {
  const { opened, close } = useRouteDrawer({});
  const { students } = loaderData;
  const [form] = Form.useForm();
  const [allStudents, setAllStudents] = useState(false);
  const { fetcher } = useGlobalFetcher();

  const isLoading = fetcher!.state === 'submitting';

  useEffect(() => {
    if (allStudents) {
      form.setFieldValue('students', []);
    }
  }, [allStudents]); // form instance is stable and doesn't need to be in dependencies

  const onFinish = (values: Record<string, unknown>) => {
    const body = {
      ...values,
      students: allStudents
        ? students.map((student: { name: string | null; id: string }) => JSON.stringify(student))
        : (values.students as string[]) || [],
    };

    fetcher!.submit(body, {
      method: 'post',
      action: '?/assignTokens',
      encType: 'application/json',
    });

    close();
  };

  const validateTokens = (_: unknown, value: number | null) => {
    if (!value || value <= 0) {
      return Promise.reject(new Error('Number of tokens must be greater than zero'));
    }
    return Promise.resolve();
  };

  const validateStudents = (_: unknown, value: string[] | null) => {
    if (!allStudents && (!value || value.length === 0)) {
      return Promise.reject(
        new Error('Please select at least one student or check "All students"')
      );
    }
    return Promise.resolve();
  };

  const handleAllStudentsChange = (e: { target: { checked: boolean } }) => {
    const checked = e.target.checked;
    setAllStudents(checked);

    if (checked) {
      form.setFieldValue('students', []);
      form.validateFields(['students']);
    }
  };

  return (
    <Modal
      open={opened}
      onCancel={close}
      title={null}
      footer={null}
      width={560}
      centered
      closable={false}
      maskClosable
      destroyOnClose
      styles={{
        content: { padding: 0, borderRadius: 16, overflow: 'hidden' },
        body: { padding: 0 },
        header: { display: 'none' },
        footer: { display: 'none' },
      }}
    >
      <Form
        form={form}
        layout="vertical"
        onFinish={onFinish}
        disabled={isLoading}
        requiredMark={false}
      >
        {/* Gmail-style header */}
        <div className="flex items-center justify-between gap-3 px-5 py-3 bg-stone-50 dark:bg-neutral-800/60 border-b border-stone-200 dark:border-neutral-800">
          <span className="text-sm font-semibold text-gray-900 dark:text-gray-100">
            Assign tokens
          </span>
          <button
            type="button"
            onClick={close}
            aria-label="Close"
            className="p-1 rounded hover:bg-stone-200 dark:hover:bg-neutral-700 text-gray-500 dark:text-gray-400 transition-colors"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
              <path
                d="M4 4l8 8M12 4l-8 8"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="px-5 pt-4 pb-2 max-h-[70vh] overflow-y-auto">
          {/* Big amount field — Gmail "Subject" style */}
          <Form.Item
            name="num_tokens"
            rules={[
              { required: true, message: 'Please enter number of tokens' },
              { validator: validateTokens },
            ]}
            className="!mb-3"
          >
            <InputNumber
              min={1}
              variant="borderless"
              placeholder="Number of tokens"
              className="!text-lg !font-semibold !px-0"
              style={{ width: '100%' }}
            />
          </Form.Item>

          <div className="h-px bg-stone-200 dark:bg-neutral-800" />

          <InlineRow icon={IconCoin}>
            <div className="flex items-center gap-2 py-2 text-sm text-gray-600 dark:text-gray-400">
              {students.length > 0
                ? `${students.length} student${students.length !== 1 ? 's' : ''} in this class`
                : 'No students enrolled yet'}
            </div>
          </InlineRow>

          <InlineRow icon={IconUsers}>
            <Form.Item className="!mb-1 !mt-1">
              <Checkbox checked={allStudents} onChange={handleAllStudentsChange}>
                <span className="text-sm">Assign to all students</span>
              </Checkbox>
            </Form.Item>

            {!allStudents && (
              <Form.Item
                name="students"
                className="!mb-0"
                rules={[{ validator: validateStudents }]}
              >
                <Select
                  mode="multiple"
                  placeholder="Search and select students…"
                  showSearch
                  allowClear
                  maxTagCount="responsive"
                  className="w-full"
                  options={students.map((student: { name: string | null; id: string }) => ({
                    label: student.name,
                    value: JSON.stringify(student),
                  }))}
                  filterOption={(input, option) => {
                    return (option as { label: string })!.label
                      .toLowerCase()
                      .includes(input.toLowerCase());
                  }}
                />
              </Form.Item>
            )}
          </InlineRow>

          <InlineRow icon={IconInfoCircle}>
            <Form.Item name="description" className="!mb-0 !mt-1">
              <Input.TextArea
                variant="borderless"
                autoSize={{ minRows: 1, maxRows: 4 }}
                placeholder="Add description"
                className="!px-0"
                maxLength={500}
              />
            </Form.Item>
          </InlineRow>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-stone-200 dark:border-neutral-800 bg-stone-50/60 dark:bg-neutral-800/40">
          <Button onClick={close} type="text" disabled={isLoading}>
            Discard
          </Button>
          <Button
            type="primary"
            htmlType="submit"
            loading={isLoading}
            disabled={students.length === 0}
            style={{ backgroundColor: '#619462', borderColor: '#619462' }}
          >
            {isLoading ? 'Assigning…' : 'Assign tokens'}
          </Button>
        </div>
      </Form>
    </Modal>
  );
};

export const action = async ({ params, request }: Route.ActionArgs) => {
  const { class: classSlug } = params;

  const { classroom, userId: _userId } = await requireClassroomAdmin(request, classSlug!, {
    resourceType: 'TOKEN_GRANT',
    action: 'assign_tokens_bulk',
  });

  const data = await request.json();
  const sessionId = nanoid();

  const accessToken = await auth.createPublicToken({
    scopes: {
      read: {
        tags: [`session_${sessionId}`],
      },
    },
  });

  return namedAction(request, {
    async assignTokens() {
      const { num_tokens, students, description } = data;

      if (!students || students.length === 0) {
        throw new Error('No students selected for token assignment');
      }

      const payloads = students.map((student: string) => ({
        payload: {
          student: typeof student === 'string' ? JSON.parse(student) : student,
          classroomId: classroom.id,
          amount: parseInt(num_tokens, 10),
          description: description || null,
        },
        options: {
          tags: [`session_${sessionId}`],
        },
      }));

      await Tasks.assignTokensToStudentTask.batchTrigger(payloads);

      return {
        triggerSession: {
          accessToken,
          id: sessionId,
          numStudentsToAssignTokens: payloads.length,
        },
      };
    },
  });
};

export default AdminTokensNew;
