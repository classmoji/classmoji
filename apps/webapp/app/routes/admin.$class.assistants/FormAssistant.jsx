import { Form, Input, Button, Space, Typography } from 'antd';
import { useState } from 'react';
import { toast } from 'react-toastify';
import { Octokit } from '@octokit/rest';

import { IconMail, IconUser, IconBrandGithubCopilot } from '@tabler/icons-react';

import { useGlobalFetcher } from '~/hooks';
import { ActionTypes } from '~/constants';

const { Text } = Typography;

const FormAssistant = ({ close, token }) => {
  const { fetcher, notify } = useGlobalFetcher();
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const octokit = new Octokit({ auth: token });

  const validateGitHubUser = async login => {
    if (!login) return null;

    setVerifying(true);
    try {
      const { data: user } = await octokit.users.getByUsername({
        username: login.replace('@', ''), // Remove @ if present
      });
      setVerifying(false);
      return user;
    } catch {
      setVerifying(false);
      throw new Error('GitHub user not found');
    }
  };

  const onFinish = async values => {
    const { name, login } = values;
    setLoading(true);

    try {
      const user = await validateGitHubUser(login);

      if (!user) {
        toast.error('GitHub login is required');
        setLoading(false);
        return;
      }

      notify(ActionTypes.SAVE_USER, 'Adding new assistant...');

      const submissionValues = {
        id: user.id,
        name: name || user.name || user.login, // Fallback to GitHub name/login if name not provided
        login: user.login,
        avatar_url: user.avatar_url,
        provider_email: user.email,
        email: values.email,
      };

      console.log('submissionValues', submissionValues);

      fetcher.submit(submissionValues, {
        method: 'post',
        action: '?/createAssistant',
        encType: 'application/json',
      });

      close();
    } catch (error) {
      toast.error(error.message || 'Failed to verify GitHub user');
    } finally {
      setLoading(false);
    }
  };

  const onFinishFailed = () => {
    toast.error('Please fill in all required fields');
  };

  const handleGitHubLoginChange = async e => {
    const login = e.target.value.replace('@', '').trim();
    form.setFieldValue('login', login);

    // Auto-fill name if login is valid and name is empty
    if (login && !form.getFieldValue('name')) {
      try {
        const user = await validateGitHubUser(login);
        if (user && (user.name || user.login)) {
          form.setFieldValue('name', user.name || user.login);
        }
      } catch {
        // Silently fail for auto-fill
      }
    }
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
          { required: true, message: 'Please enter assistant name' },
          { min: 2, message: 'Name must be at least 2 characters' },
        ]}
      >
        <Input placeholder="Enter assistant's full name" prefix={<IconUser size={16} />} />
      </Form.Item>

      <Form.Item
        label="Email"
        name="email"
        rules={[
          { required: true, message: 'Please enter assistant email' },
          { type: 'email', message: 'Please enter a valid email address' },
        ]}
      >
        <Input placeholder="Enter assistant's email" prefix={<IconMail size={16} />} />
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
        <Input
          placeholder="github-username"
          prefix={<IconBrandGithubCopilot size={16} />}
          onChange={handleGitHubLoginChange}
          loading={verifying}
        />
      </Form.Item>

      <Form.Item className="mb-0 mt-6">
        <Space className="w-full justify-end">
          <Button onClick={close} disabled={loading}>
            Cancel
          </Button>
          <Button type="primary" htmlType="submit" loading={loading} icon={<IconUser size={16} />}>
            {loading ? 'Creating...' : 'Create Assistant'}
          </Button>
        </Space>
      </Form.Item>
    </Form>
  );
};

export default FormAssistant;
