import { useState, useEffect } from 'react';
import { Button, Form, Input, Spin, Card, Alert, Space } from 'antd';
import { redirect, useFetcher, useNavigate } from 'react-router';
import { UserOutlined, MailOutlined, GithubOutlined, CheckCircleFilled } from '@ant-design/icons';
import { IconId } from '@tabler/icons-react';

import type { Route } from './+types/route';
import { Logo } from '@classmoji/ui-components';
import { getAuthSession } from '@classmoji/auth/server';
import getPrisma from '@classmoji/database';
import { generateId } from '@classmoji/utils';
import { GitHubProvider, ClassmojiService } from '@classmoji/services';
import Tasks from '@classmoji/tasks';

export const loader = async ({ request }: Route.LoaderArgs) => {
  const authData = await getAuthSession(request);

  if (!authData?.token) return redirect('/');

  // Get GitHub user info from the token
  const octokit = GitHubProvider.getUserOctokit(authData.token);
  const { data: githubUser } = await octokit.rest.users.getAuthenticated();

  // In local dev, skip the registration form entirely — auto-register using GitHub profile data.
  if (process.env.NODE_ENV === 'development') {
    const githubId = String(githubUser.id);
    const email = githubUser.email || `${githubUser.login}@dev.local`;

    const user = await getPrisma().user.upsert({
      where: { provider_provider_id: { provider: 'GITHUB', provider_id: githubId } },
      update: { email, name: githubUser.name || githubUser.login },
      create: {
        provider: 'GITHUB',
        provider_id: githubId,
        login: githubUser.login,
        name: githubUser.name || githubUser.login,
        email,
        provider_email: githubUser.email || null,
        school_id: 'dev',
        subscriptions: { create: { id: String(generateId()), tier: 'PRO' } },
      },
    });

    const sessionId = (authData as { session?: { session?: { id?: string } } })?.session?.session
      ?.id;
    if (sessionId) {
      await getPrisma().session.updateMany({
        where: { id: sessionId },
        data: { user_id: user.id },
      });
    }
    await getPrisma().account.updateMany({
      where: { provider_id: 'github', account_id: githubId },
      data: { user_id: user.id },
    });

    // Auto-join the dev classroom as OWNER + ASSISTANT + STUDENT
    const devClassroom = await getPrisma().classroom.findFirst({
      where: { slug: 'classmoji-dev-winter-2025' },
      include: {
        modules: {
          include: {
            assignments: { orderBy: { created_at: 'asc' } },
          },
        },
      },
    });
    if (devClassroom) {
      for (const role of ['OWNER', 'ASSISTANT', 'STUDENT']) {
        await getPrisma().classroomMembership.upsert({
          where: {
            classroom_id_user_id_role: {
              classroom_id: devClassroom.id,
              user_id: user.id,
              role: role as 'OWNER' | 'ASSISTANT' | 'STUDENT',
            },
          },
          update: {},
          create: {
            classroom_id: devClassroom.id,
            user_id: user.id,
            role: role as 'OWNER' | 'ASSISTANT' | 'STUDENT',
            has_accepted_invite: true,
          },
        });
      }

      // Seed student data for the real user so the student view is non-empty
      const helloWorldModule = devClassroom.modules.find(m => m.title === 'hello-world');
      const [assignment1, assignment2] = helloWorldModule?.assignments ?? [];
      const fakeTA = await getPrisma().user.findFirst({ where: { login: 'fake-ta' } });

      if (helloWorldModule && assignment1 && fakeTA) {
        // Repo for the real user
        const repo = await getPrisma().repository.upsert({
          where: {
            provider_provider_id: {
              provider: 'GITHUB',
              provider_id: `fake-repo-${githubUser.login}`,
            },
          },
          update: {},
          create: {
            classroom_id: devClassroom.id,
            module_id: helloWorldModule.id,
            provider: 'GITHUB',
            provider_id: `fake-repo-${githubUser.login}`,
            name: `${githubUser.login}-hello-world`,
            student_id: user.id,
          },
        });

        // Part 1: closed + graded ⭐
        const repoAssignment1 = await getPrisma().repositoryAssignment.upsert({
          where: {
            provider_provider_id: {
              provider: 'GITHUB',
              provider_id: `fake-issue-${githubUser.login}`,
            },
          },
          update: {},
          create: {
            repository_id: repo.id,
            assignment_id: assignment1.id,
            provider: 'GITHUB',
            provider_id: `fake-issue-${githubUser.login}`,
            provider_issue_number: 999,
            status: 'CLOSED',
          },
        });

        const existingGrade = await getPrisma().assignmentGrade.findFirst({
          where: { repository_assignment_id: repoAssignment1.id },
        });
        if (!existingGrade) {
          await getPrisma().assignmentGrade.create({
            data: {
              repository_assignment_id: repoAssignment1.id,
              grader_id: fakeTA.id,
              emoji: '⭐',
            },
          });
          await getPrisma().tokenTransaction.create({
            data: {
              classroom_id: devClassroom.id,
              student_id: user.id,
              repository_assignment_id: repoAssignment1.id,
              amount: 110,
              type: 'GAIN',
              balance_after: 110,
            },
          });
        }

        // Part 2: open (unsubmitted) — something still to do as a student
        if (assignment2) {
          await getPrisma().repositoryAssignment.upsert({
            where: {
              provider_provider_id: {
                provider: 'GITHUB',
                provider_id: `fake-issue-p2-${githubUser.login}`,
              },
            },
            update: {},
            create: {
              repository_id: repo.id,
              assignment_id: assignment2.id,
              provider: 'GITHUB',
              provider_id: `fake-issue-p2-${githubUser.login}`,
              provider_issue_number: 998,
              status: 'OPEN',
            },
          });
        }
      }
    }
    return redirect('/select-organization');
  }

  return {
    githubLogin: githubUser.login,
    githubId: String(githubUser.id),
    githubEmail: githubUser.email || null,
  };
};

const Registration = ({ loaderData }: Route.ComponentProps) => {
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

  const onFinish = (values: Record<string, unknown>) => {
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
                  <Button onClick={handleSendCode} loading={codeFetcher.state === 'submitting'}>
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

export const action = async ({ request }: Route.ActionArgs) => {
  const authData = await getAuthSession(request);
  const formData = await request.json();
  const { intent } = formData;

  // ── Send verification code ──────────────────────────────────────────────
  if (intent === 'send-code') {
    const code = String(Math.floor(100000 + Math.random() * 900000));
    await getPrisma().verification.deleteMany({ where: { identifier: formData.email } });
    await getPrisma().verification.create({
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
    const v = await getPrisma().verification.findFirst({
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
  const verification = await getPrisma().verification.findFirst({
    where: {
      identifier: formData.email,
      value: formData.code,
      expires_at: { gt: new Date() },
    },
  });
  if (!verification) {
    return { error: 'Verification code is invalid or expired. Please verify your email again.' };
  }
  await getPrisma().verification.deleteMany({ where: { identifier: formData.email } });

  // Check if email is already in use by another user
  const existingUserWithEmail = await getPrisma().user.findFirst({
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
  const user = await getPrisma().user.upsert({
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
  const sessionId = (authData as { session?: { session?: { id?: string } } })?.session?.session?.id;
  if (sessionId) {
    await getPrisma().session.updateMany({
      where: { id: sessionId },
      data: { user_id: user.id },
    });
  }

  // Link the GitHub account to the new user
  await getPrisma().account.updateMany({
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
