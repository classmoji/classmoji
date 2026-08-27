import { Form, Input, Button, Space, Typography } from 'antd';
import { useState } from 'react';

import { IconMail, IconUser, IconBrandGithubCopilot } from '@tabler/icons-react';

import { useGlobalFetcher } from '~/hooks';
import { useCallout } from '@classmoji/ui-components';
import { ActionTypes } from '~/constants';

const { Text } = Typography;

interface FormStaffProps {
  close: () => void;
}

/**
 * Add a member of the teaching staff by git login.
 *
 * The GitHub profile is resolved SERVER-SIDE, inside ClassmojiService.staff
 * .addStaff. This form used to do its own `octokit.users.getByUsername` with the
 * requesting instructor's access token — which meant the loader had to ship that
 * token to the browser. The lookup was never authoritative (the service resolves
 * the profile again regardless, and only its answer is trusted), so it is gone
 * along with the token: an unknown login now comes back from the action as
 * `git_user_not_found`.
 */
const FormStaff = ({ close }: FormStaffProps) => {
  const { fetcher, notify } = useGlobalFetcher();
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const callout = useCallout();

  const onFinish = (values: { name?: string; login: string; email: string }) => {
    setLoading(true);

    // Only the login, and the instructor's optional overrides. Everything the
    // membership is keyed to — the provider id above all — is the server's to
    // decide from the login it resolves.
    const login = values.login.replace('@', '').trim();

    notify(ActionTypes.SAVE_USER, 'Adding new staff member...');

    fetcher!.submit(
      { login, name: values.name ?? null, email: values.email ?? null },
      {
        method: 'post',
        action: '?/createStaff',
        encType: 'application/json',
      }
    );

    setLoading(false);
    close();
  };

  const onFinishFailed = () => {
    callout.show({ variant: 'error', title: 'Please fill in all required fields' });
  };

  return (
    <Form
      form={form}
      layout="vertical"
      onFinish={onFinish}
      onFinishFailed={onFinishFailed}
      disabled={loading}
    >
      <Form.Item
        label="Name"
        name="name"
        rules={[
          { required: true, message: 'Please enter a name' },
          { min: 2, message: 'Name must be at least 2 characters' },
        ]}
      >
        <Input placeholder="Enter their full name" prefix={<IconUser size={16} />} />
      </Form.Item>

      <Form.Item
        label="Email"
        name="email"
        rules={[
          { required: true, message: 'Please enter an email' },
          { type: 'email', message: 'Please enter a valid email address' },
        ]}
      >
        <Input placeholder="Enter their email" prefix={<IconMail size={16} />} />
      </Form.Item>

      <Form.Item
        label="GitHub Username"
        name="login"
        rules={[
          { required: true, message: 'Please enter GitHub username' },
          {
            pattern: /^[a-zA-Z0-9]([a-zA-Z0-9]|-)*[a-zA-Z0-9]$/,
            message: 'Invalid GitHub username format',
          },
        ]}
        extra={
          <Text type="secondary" className="text-xs">
            Enter the GitHub username (without @)
          </Text>
        }
      >
        <Input placeholder="github-username" prefix={<IconBrandGithubCopilot size={16} />} />
      </Form.Item>

      <Form.Item className="mb-0 mt-6">
        <Space className="w-full justify-end">
          <Button onClick={close} disabled={loading}>
            Cancel
          </Button>
          <Button type="primary" htmlType="submit" loading={loading} icon={<IconUser size={16} />}>
            {loading ? 'Adding...' : 'Add staff member'}
          </Button>
        </Space>
      </Form.Item>
    </Form>
  );
};

export default FormStaff;
