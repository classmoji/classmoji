import { Button, Form, Input, Spin, Card, Alert, Select } from 'antd';
import { redirect, useFetcher } from 'react-router';
import { UserOutlined, MailOutlined, GithubOutlined } from '@ant-design/icons';
import { IconId, IconUsers } from '@tabler/icons-react';

import { Logo } from '@classmoji/ui-components';
import { getAuthSession } from '@classmoji/auth/server';
import prisma from '@classmoji/database';
import { generateId } from '@classmoji/utils';
import { GitHubProvider, ClassmojiService } from '@classmoji/services';

export const loader = async ({ request }) => {
  const authData = await getAuthSession(request);

  if (!authData?.token) return redirect('/');

  const url = new URL(request.url);
  const next = url.searchParams.get('next') || '';

  // Get GitHub user info from the token
  const octokit = GitHubProvider.getUserOctokit(authData.token);
  const { data: githubUser } = await octokit.rest.users.getAuthenticated();

  return {
    githubLogin: githubUser.login,
    githubId: String(githubUser.id), // GitHub provider ID
    githubEmail: githubUser.email || null, // GitHub profile email (may be null if private)
    next,
  };
};

const Registration = ({ loaderData }) => {
  const { githubLogin, githubId, githubEmail, next } = loaderData;
  const fetcher = useFetcher();
  const [form] = Form.useForm();
  const role = Form.useWatch('role', form);
  const isStudentOrTA = role === 'STUDENT' || role === 'TA';

  const onFinish = async values => {
    fetcher.submit({ ...values, githubEmail, next }, {
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
          <h1 className="text-2xl font-bold mb-2">Create Your Account</h1>
          <p className="text-gray-600 text-sm">Complete your profile to get started</p>
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
            <Alert message={actionError} type="error" showIcon style={{ marginBottom: 12 }} />
          )}

          <Form
            form={form}
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

            {/* Role */}
            <Form.Item
              label={
                <span className="flex items-center gap-2 font-medium text-gray-700 text-sm">
                  <IconUsers size={14} />
                  Your Role
                </span>
              }
              name="role"
              rules={[{ required: true, message: 'Please select your role' }]}
              className="mb-6"
            >
              <Select placeholder="Select your role">
                <Select.Option value="STUDENT">Student</Select.Option>
                <Select.Option value="TA">Teaching Assistant</Select.Option>
                <Select.Option value="INSTRUCTOR">Instructor / Other</Select.Option>
              </Select>
            </Form.Item>

            {/* Student ID — shown for students and TAs */}
            {isStudentOrTA && (
              <Form.Item
                label={
                  <span className="flex items-center gap-2 font-medium text-gray-700 text-sm">
                    <IconId size={14} />
                    Student ID
                  </span>
                }
                name="student_id"
                rules={[{ required: true, message: 'Please enter your student ID' }]}
                className="mb-6"
              >
                <Input placeholder="Enter your student ID" />
              </Form.Item>
            )}

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
              You can create and join classrooms after registration.
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
      student_id: formData.student_id || null,
    },
    create: {
      provider: 'GITHUB',
      provider_id: formData.githubId,
      login: formData.login,
      name: formData.name,
      email: formData.email,
      provider_email: formData.githubEmail || null,
      student_id: formData.student_id || null,
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

  // Auto-claim any pending classroom invites matching this email
  const invites = await ClassmojiService.classroomInvite.findInvitesByEmail(formData.email);
  if (invites.length > 0) {
    // Store student_id from invite on the user record
    await prisma.user.update({
      where: { id: user.id },
      data: { student_id: invites[0].student_id },
    });
    for (const invite of invites) {
      await ClassmojiService.classroomMembership.create({
        classroom_id: invite.classroom_id,
        user_id: user.id,
        role: 'STUDENT',
        has_accepted_invite: false,
      });
    }
    await ClassmojiService.classroomInvite.deleteManyInvites(invites.map(i => i.id));
  }

  const next = formData.next;
  return redirect(next || '/select-organization');
};

export default Registration;
