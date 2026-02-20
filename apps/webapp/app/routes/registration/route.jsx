import { useState, useEffect } from 'react';
import { Button, Form, Input, Spin, Card, Alert, Space } from 'antd';
import { redirect, useFetcher, useNavigate } from 'react-router';
import { UserOutlined, MailOutlined, GithubOutlined, CheckCircleFilled } from '@ant-design/icons';
import { IconId } from '@tabler/icons-react';

import { Logo } from '@classmoji/ui-components';
import { getAuthSession } from '@classmoji/auth/server';
import prisma from '@classmoji/database';
import { generateId } from '@classmoji/utils';
import { GitHubProvider, ClassmojiService } from '@classmoji/services';
import Tasks from '@classmoji/tasks';

export const loader = async ({ request }) => {
  const authData = await getAuthSession(request);

  if (!authData?.token) return redirect('/');

  // Get GitHub user info from the token
  const octokit = GitHubProvider.getUserOctokit(authData.token);
  const { data: githubUser } = await octokit.rest.users.getAuthenticated();

  return {
    githubLogin: githubUser.login,
    githubId: String(githubUser.id),
    githubEmail: githubUser.email || null,
  };
};

const Registration = ({ loaderData }) => {
  const { githubLogin, githubId, githubEmail } = loaderData;
  const fetcher = useFetcher();
  const codeFetcher = useFetcher();
  const verifyFetcher = useFetcher();
  const navigate = useNavigate();
  const [form] = Form.useForm();
  const [verifiedEmail, setVerifiedEmail] = useState(null);

  const codeSent = codeFetcher.data?.codeSent === true;
  const emailVerified = verifyFetcher.data?.verified === true || verifiedEmail !== null;
  const verifyError = verifyFetcher.data?.verifyError;

  const isSubmitting = ['submitting', 'loading'].includes(fetcher.state);
  const actionError = fetcher.data?.error;

  // Handle successful registration redirect
  useEffect(() => {
    if (fetcher.state === 'idle' && fetcher.data && !fetcher.data.error) {
      navigate('/select-organization');
    }
  }, [fetcher.state, fetcher.data, navigate]);

  const handleSendCode = () => {
    const email = form.getFieldValue('email');
    if (!email) {
      form.validateFields(['email']);
      return;
    }
    codeFetcher.submit(
      { intent: 'send-code', email },
      { method: 'POST', encType: 'application/json' }
    );
  };

  const handleVerify = () => {
    const email = form.getFieldValue('email');
    const code = form.getFieldValue('code');
    verifyFetcher.submit(
      { intent: 'verify-code', email, code },
      { method: 'POST', encType: 'application/json' }
    );
  };

  // Track verified email to re-send code if email changes
  if (verifyFetcher.data?.verified && !verifiedEmail) {
    setVerifiedEmail(form.getFieldValue('email'));
  }

  const onFinish = values => {
    fetcher.submit(
      { ...values, githubEmail, intent: 'register' },
      {
        method: 'POST',
        encType: 'application/json',
      }
    );
  };

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
        <Card className="shadow-xs border border-gray-200" styles={{ body: { padding: '24px' } }}>
          <Spin spinning={isSubmitting} tip="Setting up your account..." fullscreen />

          {actionError && (
            <Alert message={actionError} type="error" showIcon style={{ marginBottom: 12 }} />
          )}

          <Form
            form={form}
            layout="vertical"
            onFinish={onFinish}
            size="middle"
            initialValues={{ githubId, login: githubLogin }}
            disabled={isSubmitting}
          >
            <Form.Item label="GitHub ID" name="githubId" className="hidden">
              <Input readOnly />
            </Form.Item>

            {/* School Email + Send Code */}
            <Form.Item
              label={
                <span className="flex items-center gap-2 font-medium text-gray-700 text-sm">
                  <MailOutlined />
                  School Email
                  {emailVerified && <CheckCircleFilled style={{ color: '#22c55e' }} />}
                </span>
              }
              name="email"
              rules={[
                { required: true, message: 'Please enter your school email' },
                { type: 'email', message: 'Please enter a valid email address' },
              ]}
              className="mb-3"
            >
              <Space.Compact style={{ width: '100%' }}>
                <Input
                  placeholder="your.email@university.edu"
                  prefix={<MailOutlined className="text-gray-400" />}
                  readOnly={emailVerified}
                  className={emailVerified ? 'bg-gray-50' : ''}
                />
                {!emailVerified && (
                  <Button
                    onClick={handleSendCode}
                    loading={codeFetcher.state === 'submitting'}
                  >
                    {codeSent ? 'Resend' : 'Send Code'}
                  </Button>
                )}
              </Space.Compact>
            </Form.Item>

            {!emailVerified && codeSent && (
              <div className="mb-6">
                <Form.Item
                  name="code"
                  rules={[{ required: true, message: 'Please enter the verification code' }]}
                  className="mb-2"
                  validateStatus={verifyError ? 'error' : undefined}
                  help={verifyError}
                >
                  <Input
                    placeholder="6-digit code"
                    maxLength={6}
                    className="text-center tracking-widest font-mono text-lg"
                  />
                </Form.Item>
                <Button
                  onClick={handleVerify}
                  loading={verifyFetcher.state === 'submitting'}
                  type="primary"
                  className="w-full"
                >
                  Verify Code
                </Button>
              </div>
            )}

            {/* Rest of form — only shown after email verified */}
            {emailVerified && (
              <>
                {/* Hidden code field to carry through on submit */}
                <Form.Item name="code" className="hidden">
                  <Input />
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

                {/* School ID */}
                <Form.Item
                  label={
                    <span className="flex items-center gap-2 font-medium text-gray-700 text-sm">
                      <IconId size={14} />
                      School ID
                    </span>
                  }
                  name="school_id"
                  rules={[{ required: true, message: 'Please enter your school ID' }]}
                  className="mb-6"
                >
                  <Input placeholder="Enter your school ID" />
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
              </>
            )}
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
  const { intent } = formData;

  // ── Send verification code ──────────────────────────────────────────────
  if (intent === 'send-code') {
    const code = String(Math.floor(100000 + Math.random() * 900000));
    await prisma.verification.deleteMany({ where: { identifier: formData.email } });
    await prisma.verification.create({
      data: {
        identifier: formData.email,
        value: code,
        expires_at: new Date(Date.now() + 10 * 60 * 1000),
      },
    });
    await Tasks.sendEmailTask.trigger({
      to: formData.email,
      subject: '[Classmoji] Verify your school email',
      html: `<p>Your verification code is: <strong style="font-size:24px;letter-spacing:4px">${code}</strong></p><p>It expires in 10 minutes.</p>`,
    });
    return { codeSent: true };
  }

  // ── Verify code inline ──────────────────────────────────────────────────
  if (intent === 'verify-code') {
    const v = await prisma.verification.findFirst({
      where: {
        identifier: formData.email,
        value: formData.code,
        expires_at: { gt: new Date() },
      },
    });
    if (!v) return { verifyError: 'Invalid or expired code. Try resending.' };
    return { verified: true };
  }

  // ── Register (re-validate + create user) ────────────────────────────────
  const verification = await prisma.verification.findFirst({
    where: {
      identifier: formData.email,
      value: formData.code,
      expires_at: { gt: new Date() },
    },
  });
  if (!verification) {
    return { error: 'Verification code is invalid or expired. Please verify your email again.' };
  }
  await prisma.verification.deleteMany({ where: { identifier: formData.email } });

  // Check if email is already in use by another user
  const existingUserWithEmail = await prisma.user.findFirst({
    where: {
      email: formData.email,
      NOT: {
        AND: [{ provider: 'GITHUB' }, { provider_id: formData.githubId }],
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
      school_id: formData.school_id || null,
    },
    create: {
      provider: 'GITHUB',
      provider_id: formData.githubId,
      login: formData.login,
      name: formData.name,
      email: formData.email,
      provider_email: formData.githubEmail || null,
      school_id: formData.school_id || null,
      subscriptions: {
        create: {
          id: String(generateId()),
          tier: 'FREE',
        },
      },
    },
  });

  // Update BetterAuth session to point to the new user
  if (authData?.session?.session?.id) {
    await prisma.session.updateMany({
      where: { id: authData.session.session.id },
      data: { user_id: user.id },
    });
  }

  // Link the GitHub account to the new user
  await prisma.account.updateMany({
    where: {
      provider_id: 'github',
      account_id: formData.githubId,
    },
    data: { user_id: user.id },
  });

  // Claim any pending classroom invites matching email
  const invites = await ClassmojiService.classroomInvite.findInvitesByEmail(formData.email);
  if (invites.length > 0) {
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

  return redirect('/select-organization');
};

export default Registration;
