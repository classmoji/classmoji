import {
  Drawer,
  Form,
  InputNumber,
  Button,
  Select,
  Checkbox,
  Input,
  Space,
  Typography,
  Divider,
} from 'antd';

import { useState, useEffect } from 'react';
import { auth } from '@trigger.dev/sdk';
import { namedAction } from 'remix-utils/named-action';
import { nanoid } from 'nanoid';

import { ClassmojiService } from '@classmoji/services';
import { useGlobalFetcher, useRouteDrawer } from '~/hooks';
import Tasks from '@classmoji/tasks';
import { requireClassroomAdmin } from '~/utils/routeAuth.server';

const { Text } = Typography;

export const loader = async ({ params, request }) => {
  const { class: classSlug } = params;

  const { classroom } = await requireClassroomAdmin(request, classSlug, {
    resourceType: 'TOKEN_GRANT',
    action: 'view_form',
  });

  const students = await ClassmojiService.classroomMembership.findUsersByRole(classroom.id, 'STUDENT');
  return { students };
};

const AdminTokensNew = ({ loaderData }) => {
  const { opened, close } = useRouteDrawer({});
  const { students } = loaderData;
  const [form] = Form.useForm();
  const [allStudents, setAllStudents] = useState(false);
  const { fetcher } = useGlobalFetcher();

  const isLoading = fetcher.state === 'submitting';

  useEffect(() => {
    if (allStudents) {
      form.setFieldValue('students', []);
    }
  }, [allStudents]); // form instance is stable and doesn't need to be in dependencies

  const onFinish = values => {
    const body = {
      ...values,
      students: allStudents
        ? students.map(student => JSON.stringify(student))
        : values.students || [],
    };

    fetcher.submit(body, {
      method: 'post',
      action: '?/assignTokens',
      encType: 'application/json',
    });

    close();
  };

  const validateTokens = (_, value) => {
    if (!value || value <= 0) {
      return Promise.reject(new Error('Number of tokens must be greater than zero'));
    }
    return Promise.resolve();
  };

  const validateStudents = (_, value) => {
    if (!allStudents && (!value || value.length === 0)) {
      return Promise.reject(
        new Error('Please select at least one student or check "All students"')
      );
    }
    return Promise.resolve();
  };

  const handleAllStudentsChange = e => {
    const checked = e.target.checked;
    setAllStudents(checked);

    if (checked) {
      form.setFieldValue('students', []);
      form.validateFields(['students']);
    }
  };

  return (
    <Drawer title="Assign Tokens" open={opened} onClose={close} width={520} destroyOnClose>
      <Form form={form} layout="vertical" onFinish={onFinish} disabled={isLoading}>
        <Form.Item
          label="Number of Tokens"
          name="num_tokens"
          rules={[
            { required: true, message: 'Please enter number of tokens' },
            { validator: validateTokens },
          ]}
        >
          <InputNumber min={1} placeholder="Enter number of tokens" style={{ width: '100%' }} />
        </Form.Item>

        <Divider />

        <Form.Item>
          <Checkbox checked={allStudents} onChange={handleAllStudentsChange}>
            Assign tokens to all students
          </Checkbox>
          {students.length > 0 && (
            <Text type="secondary" className="block mt-1 text-sm">
              Total students available: {students.length}
            </Text>
          )}
        </Form.Item>

        {!allStudents && (
          <Form.Item
            label="Select Students"
            name="students"
            rules={[{ validator: validateStudents }]}
          >
            <Select
              mode="multiple"
              placeholder="Search and select students..."
              showSearch
              allowClear
              maxTagCount="responsive"
              options={students.map(student => ({
                label: student.name,
                value: JSON.stringify(student),
              }))}
              filterOption={(input, option) => {
                return option.label.toLowerCase().includes(input.toLowerCase());
              }}
            />
          </Form.Item>
        )}

        <Form.Item label="Description (Optional)" name="description">
          <Input.TextArea
            rows={3}
            placeholder="Add a description for this token assignment..."
            showCount
            maxLength={500}
          />
        </Form.Item>

        <Divider />

        <Form.Item className="mb-0">
          <Space className="w-full justify-end">
            <Button onClick={close} disabled={isLoading}>
              Cancel
            </Button>
            <Button
              type="primary"
              htmlType="submit"
              loading={isLoading}
              disabled={students.length === 0}
            >
              {isLoading ? 'Assigning...' : 'Assign Tokens'}
            </Button>
          </Space>
        </Form.Item>
      </Form>
    </Drawer>
  );
};

export const action = async ({ params, request }) => {
  const { class: classSlug } = params;

  const { classroom, userId } = await requireClassroomAdmin(request, classSlug, {
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

      const payloads = students.map(student => ({
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
