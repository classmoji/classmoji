import { Form, Input, Button, Card } from 'antd';
import { redirect, useFetcher } from 'react-router';
import { useState } from 'react';
import { toast } from 'react-toastify';
import emailValidator from 'email-validator';
import { UserOutlined, MailOutlined, IdcardOutlined, GithubOutlined } from '@ant-design/icons';

import { getAuthSession } from '@classmoji/auth/server';
import prisma from '@classmoji/database';
import { ClassmojiService } from '@classmoji/services';
import { checkAuth } from '~/utils/helpers';
import { Logo } from '@classmoji/ui-components';

export const loader = async ({ request }) => {
  const authData = await getAuthSession(request);
  if (!authData?.userId) return redirect('/');

  // Get the OAuth user's login (populated by mapProfileToUser during OAuth)
  const oauthUser = await prisma.user.findUnique({
    where: { id: authData.userId },
    select: {
      login: true,
      provider_id: true,
    },
  });

  if (!oauthUser?.login) {
    // User doesn't have GitHub login - redirect to try again
    return redirect('/');
  }

  return {
    user: {
      login: oauthUser.login,
      id: oauthUser.provider_id,
    },
  };
};

const SyncAccounts = ({ loaderData }) => {
  const { user } = loaderData;
  const [email, setEmail] = useState('');
  const [studentId, setStudentId] = useState('');

  const fetcher = useFetcher();

  const onSubmit = async () => {
    if (!email || !studentId) {
      toast.error('Please fill in all fields.');
      return;
    }

    if (!emailValidator.validate(email)) {
      toast.error('Invalid email address.');
      return;
    }

    fetcher.submit(
      {
        email,
        student_id: studentId.toUpperCase(),
        login: user.login,
        githubId: String(user.id), // GitHub user ID as string
      },
      { method: 'post', encType: 'application/json' }
    );
  };

  const isFormValid = email && studentId && emailValidator.validate(email);

  return (
    <div className="min-h-screen bg-lightGray flex flex-col items-center justify-center p-4">
      <div className="w-full max-w-md">
        {/* Header */}
        <div className="text-center mb-6">
          <div className="flex justify-center mb-4">
            <Logo size={48} variant="icon" />
          </div>
          <h1 className="text-2xl font-bold mb-2">Connect Your Account</h1>
          <p className="text-gray-600 text-sm">
            Link your GitHub account with your student information
          </p>
        </div>

        {/* Main Form Card */}
        <Card
          className="shadow-xs border border-gray-200"
          styles={{
            body: { padding: '24px' },
          }}
        >
          <Form layout="vertical" size="middle">
            {/* GitHub Username */}
            <Form.Item
              label={
                <span className="flex items-center gap-2 font-medium text-gray-700 text-sm">
                  <GithubOutlined />
                  GitHub Username
                </span>
              }
              className="mb-6"
            >
              <Input
                value={`@${user.login}`}
                readOnly={true}
                className="bg-gray-50"
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
              validateStatus={email && !emailValidator.validate(email) ? 'error' : ''}
              help={
                email && !emailValidator.validate(email) ? 'Please enter a valid email address' : ''
              }
              className="mb-6"
            >
              <Input
                value={email}
                onChange={e => setEmail(e.target.value)}
                placeholder="your.email@university.edu"
                prefix={<MailOutlined className="text-gray-400" />}
              />
            </Form.Item>

            {/* Student ID */}
            <Form.Item
              label={
                <span className="flex items-center gap-2 font-medium text-gray-700 text-sm">
                  <IdcardOutlined />
                  Student ID
                </span>
              }
              className="mb-6"
            >
              <Input
                value={studentId}
                onChange={e => setStudentId(e.target.value.toUpperCase())}
                placeholder="Enter your student ID"
                prefix={<IdcardOutlined className="text-gray-400" />}
              />
            </Form.Item>
          </Form>

          {/* Error Display */}
          {fetcher.data?.error && (
            <div className="bg-red-50 border border-red-200 rounded-lg p-3 mb-4">
              <div className="flex items-center gap-2">
                <div className="font-medium text-red-900 text-sm">Connection Failed</div>
              </div>
              <div className="text-red-700 text-sm mt-1">{fetcher.data.error}</div>
            </div>
          )}

          {/* Submit Button */}
          <Button
            onClick={onSubmit}
            loading={['submitting', 'loading'].includes(fetcher.state)}
            disabled={!isFormValid}
            className="w-full h-10 text-sm font-medium !text-white"
            type="primary"
          >
            {['submitting', 'loading'].includes(fetcher.state)
              ? 'Connecting...'
              : 'Connect Account'}
          </Button>

          {/* Help Text */}
          <div className="mt-4 text-center">
            <p className="text-xs text-gray-500">
              Having trouble? Make sure your email and student ID match your school records.
            </p>
          </div>
        </Card>

        {/* Footer */}
        <div className="text-center mt-4">
          <p className="text-xs text-gray-500">
            Your information is secure and will only be used to verify your student status.
          </p>
        </div>
      </div>
    </div>
  );
};

export const action = checkAuth(async ({ request }) => {
  const authData = await getAuthSession(request);
  const { githubId, email, student_id, login } = await request.json();

  // 1. Find all invites matching email + student_id
  const invites = await ClassmojiService.classroomInvite.findInvitesByEmailAndStudentId(
    email,
    student_id
  );

  if (invites.length === 0) {
    return {
      error:
        'No invites found. Make sure your school email and student ID match what your instructor used.',
    };
  }

  // 2. Update the OAuth user with school email and student_id
  await prisma.user.update({
    where: { id: authData.userId },
    data: {
      email,
      school_id: student_id,
      login,
      provider: 'GITHUB',
      provider_id: githubId,
    },
  });

  // 3. Create ClassroomMembership for each invite
  for (const invite of invites) {
    await ClassmojiService.classroomMembership.create({
      classroom_id: invite.classroom_id,
      user_id: authData.userId,
      role: 'STUDENT',
      has_accepted_invite: false,
    });
  }

  // 4. Delete claimed invites
  await ClassmojiService.classroomInvite.deleteManyInvites(invites.map(i => i.id));

  return redirect('/select-organization');
});

export default SyncAccounts;
