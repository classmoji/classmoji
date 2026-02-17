import { Button, Form, Input, Spin, Card, Alert } from 'antd';
import { redirect, useFetcher } from 'react-router';
import { UserOutlined, MailOutlined, GithubOutlined } from '@ant-design/icons';

import { Logo } from '@classmoji/ui-components';
import { getAuthSession } from '@classmoji/auth/server';
import prisma from '@classmoji/database';
import { generateId } from '@classmoji/utils';
import { GitHubProvider } from '@classmoji/services';

export const loader = async ({ request }) => {
  const authData = await getAuthSession(request);

  if (!authData?.token) return redirect('/');

  // Get GitHub user info from the token
  const octokit = GitHubProvider.getUserOctokit(authData.token);
  const { data: githubUser } = await octokit.rest.users.getAuthenticated();

  return {
    githubLogin: githubUser.login,
    githubId: String(githubUser.id), // GitHub provider ID
  };
};

const Registration = ({ loaderData }) => {
  const { githubLogin, githubId } = loaderData;
  const fetcher = useFetcher();

  const onFinish = async values => {
    fetcher.submit(values, {
      method: 'POST',
      encType: 'application/json',
    });
  };

  const isSubmitting = ['submitting', 'loading'].includes(fetcher.state);
  const actionError = fetcher.data?.error;

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col items-center justify-center p-4">
      <div className="w-full max-w-md">
        {/* Header */}
        <div className="text-center mb-6">
          <div className="flex justify-center mb-4">
            <Logo size={48} />
          </div>
          <h1 className="text-2xl font-bold mb-2">Instructor Registration</h1>
          <p className="text-gray-600 text-sm">Complete your instructor profile setup</p>
        </div>

        {/* Main Form Card */}
        <Card
          className="shadow-xs border border-gray-200"
          styles={{
            body: { padding: '24px' },
          }}
        >
          <Spin spinning={isSubmitting} tip="Setting up your account..." fullscreen />

          {actionError && (
            <Alert message={actionError} type="error" showIcon className="mb-4" />
          )}

          <Form
            layout="vertical"
            onFinish={onFinish}
            size="middle"
            initialValues={{
              githubId: githubId,
              login: githubLogin,
            }}
            disabled={isSubmitting}
          >
            <Form.Item label="GitHub ID" name="githubId" className="hidden">
              <Input value={`${githubId}`} readOnly />
            </Form.Item>

            {/* GitHub Username */}
            <Form.Item
              label={
                <span className="flex items-center gap-2 font-medium text-gray-700 text-sm">
                  <GithubOutlined />
                  GitHub Username
                </span>
              }
              name="login"
              className="mb-6"
            >
              <Input
                addonBefore="@"
                value={`${githubLogin}`}
                readOnly
                className="bg-gray-50"
                prefix={<UserOutlined className="text-gray-400" />}
              />
            </Form.Item>

            {/* Your Name */}
            <Form.Item
              label={
                <span className="flex items-center gap-2 font-medium text-gray-700 text-sm">
                  <UserOutlined />
                  Your Name
                </span>
              }
              name="name"
              rules={[{ required: true, message: 'Please enter your full name' }]}
              className="mb-6"
            >
              <Input
                placeholder="Enter your full name"
                prefix={<UserOutlined className="text-gray-400" />}
              />
            </Form.Item>

            {/* School Email */}
            <Form.Item
              label={
                <span className="flex items-center gap-2 font-medium text-gray-700 text-sm">
                  <MailOutlined />
                  School Email
                </span>
              }
              name="email"
              rules={[
                { required: true, message: 'Please enter your school email' },
                {
                  type: 'email',
                  message: 'Please enter a valid email address',
                },
              ]}
              className="mb-6"
            >
              <Input
                placeholder="your.email@university.edu"
                prefix={<MailOutlined className="text-gray-400" />}
              />
            </Form.Item>

            {/* Submit Button */}
            <Button
              className="w-full h-10 text-sm font-medium !text-white"
              htmlType="submit"
              disabled={isSubmitting}
              type="primary"
            >
              {isSubmitting ? 'Creating Account...' : 'Complete Registration'}
            </Button>
          </Form>

          {/* Help Text */}
          <div className="mt-4 text-center">
            <p className="text-xs text-gray-500">
              You will be able to create and manage classes after registration.
            </p>
          </div>
        </Card>

        {/* Footer */}
        <div className="text-center mt-4">
          <p className="text-xs text-gray-500">
            By registering, you agree to our terms of service and privacy policy.
          </p>
        </div>
      </div>
    </div>
  );
};

export const action = async ({ request }) => {
  const authData = await getAuthSession(request);
  const formData = await request.json();

  // Check if email is already in use by another user
  const existingUserWithEmail = await prisma.user.findFirst({
    where: {
      email: formData.email,
      NOT: {
        AND: [
          { provider: 'GITHUB' },
          { provider_id: formData.githubId },
        ],
      },
    },
  });

  if (existingUserWithEmail) {
    return { error: 'This email is already in use by another account.' };
  }

  // Create user with provider info
  const user = await prisma.user.upsert({
    where: {
      provider_provider_id: {
        provider: 'GITHUB',
        provider_id: formData.githubId,
      },
    },
    update: {
      name: formData.name,
      email: formData.email,
    },
    create: {
      provider: 'GITHUB',
      provider_id: formData.githubId,
      login: formData.login,
      name: formData.name,
      email: formData.email,
      is_admin: true,
      subscriptions: {
        create: {
          id: String(generateId()),
          tier: 'FREE',
        },
      },
    },
  });

  // Update BetterAuth session to point to the new user
  // The Account table already links the session to this user via provider_id
  // We need to update the Session.user_id to the new user's ID
  if (authData?.session?.session?.id) {
    await prisma.session.update({
      where: { id: authData.session.session.id },
      data: { user_id: user.id },
    });
  }

  // Also update the Account.user_id to link to the new user
  await prisma.account.updateMany({
    where: {
      provider_id: 'github',
      account_id: formData.githubId,
    },
    data: { user_id: user.id },
  });

  return redirect('/select-organization');
};

export default Registration;
