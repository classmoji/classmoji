import { useState, useEffect } from 'react';
import { GitlabLogo } from '~/components/ui/display/GitlabLogo';
import { Button, Form, Input, Spin, Card, Alert, Space } from 'antd';
import { redirect, useFetcher, useNavigate } from 'react-router';
import { UserOutlined, MailOutlined, GithubOutlined, CheckCircleFilled } from '@ant-design/icons';
import { IconId } from '@tabler/icons-react';

import type { Route } from './+types/route';
import { Logo } from '@classmoji/ui-components';
import { getAuthSession } from '@classmoji/auth/server';
import getPrisma, { GIT_IDENTITY, whereGitUsername } from '@classmoji/database';
import { generateId, gitUsername } from '@classmoji/utils';
import { ClassmojiService } from '@classmoji/services';
import {
  sendEmailVerificationCode,
  isEmailVerificationCodeValid,
  consumeEmailVerificationCode,
} from '~/utils/emailVerification.server';
import { verifyInviteToken, inviteTokenMatchesEmail } from '@classmoji/auth/invite-token';

/** Where to go once registered: a same-site path from `?next=`, else the picker. */
const safeNext = (value: string | null | undefined): string =>
  value && value.startsWith('/') && !value.startsWith('//') ? value : '/select-organization';

export const loader = async ({ request }: Route.LoaderArgs) => {
  const authData = await getAuthSession(request);
  if (!authData?.userId) return redirect('/');

  const url = new URL(request.url);
  const next = safeNext(url.searchParams.get('next'));

  const user = await getPrisma().user.findUnique({
    where: { id: authData.userId },
    include: GIT_IDENTITY,
  });
  if (!user) return redirect('/');
  const githubLogin = gitUsername(user, 'GITHUB');

  // Already registered: nothing to do here.
  if (user.email && user.emailVerified) return redirect(next);

  // In local dev, skip the registration form entirely — auto-register using GitHub profile data.
  // Gated on an explicit allow flag in addition to NODE_ENV to avoid a misconfigured
  // production (NODE_ENV unset) silently turning into a no-form auto-register backdoor.
  if (
    process.env.NODE_ENV === 'development' &&
    process.env.ENABLE_DEV_AUTO_REGISTER === 'true' &&
    githubLogin
  ) {
    const email = (user.email || `${githubLogin}@dev.local`).toLowerCase();
    await getPrisma().user.update({
      where: { id: user.id },
      data: {
        email,
        emailVerified: true,
        name: user.name || githubLogin,
        school_id: user.school_id || 'dev',
      },
    });
    const hasSubscription = await getPrisma().subscription.count({ where: { user_id: user.id } });
    if (!hasSubscription) {
      await getPrisma().subscription.create({
        data: { id: String(generateId()), tier: 'PRO', user_id: user.id },
      });
    }

    // Auto-join the dev classroom as OWNER + ASSISTANT + STUDENT
    const devClassroom = await getPrisma().classroom.findFirst({
      where: { slug: 'classmoji-dev-winter-2025' },
      include: {
        repositories: {
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
      const helloWorldModule = devClassroom.repositories.find(m => m.title === 'hello-world');
      const [assignment1, assignment2] = helloWorldModule?.assignments ?? [];
      const fakeTA = await getPrisma().user.findFirst({ where: whereGitUsername('fake-ta') });

      if (helloWorldModule && assignment1 && fakeTA) {
        // Repo for the real user
        const repo = await getPrisma().gitRepo.upsert({
          where: {
            provider_provider_id: {
              provider: 'GITHUB',
              provider_id: `fake-repo-${githubLogin}`,
            },
          },
          update: {},
          create: {
            classroom_id: devClassroom.id,
            repository_id: helloWorldModule.id,
            provider: 'GITHUB',
            provider_id: `fake-repo-${githubLogin}`,
            name: `${githubLogin}-hello-world`,
            student_id: user.id,
          },
        });

        // Part 1: closed + graded ⭐
        const repoAssignment1 = await getPrisma().gitRepoAssignment.upsert({
          where: {
            provider_provider_id: {
              provider: 'GITHUB',
              provider_id: `fake-issue-${githubLogin}`,
            },
          },
          update: {},
          create: {
            git_repo_id: repo.id,
            assignment_id: assignment1.id,
            provider: 'GITHUB',
            provider_id: `fake-issue-${githubLogin}`,
            provider_issue_number: 999,
            status: 'CLOSED',
          },
        });

        const existingGrade = await getPrisma().assignmentGrade.findFirst({
          where: { git_repo_assignment_id: repoAssignment1.id },
        });
        if (!existingGrade) {
          await getPrisma().assignmentGrade.create({
            data: {
              git_repo_assignment_id: repoAssignment1.id,
              grader_id: fakeTA.id,
              emoji: '⭐',
            },
          });
          await getPrisma().tokenTransaction.create({
            data: {
              classroom_id: devClassroom.id,
              student_id: user.id,
              git_repo_assignment_id: repoAssignment1.id,
              amount: 110,
              type: 'GAIN',
              balance_after: 110,
            },
          });
        }

        // Part 2: open (unsubmitted) — something still to do as a student
        if (assignment2) {
          await getPrisma().gitRepoAssignment.upsert({
            where: {
              provider_provider_id: {
                provider: 'GITHUB',
                provider_id: `fake-issue-p2-${githubLogin}`,
              },
            },
            update: {},
            create: {
              git_repo_id: repo.id,
              assignment_id: assignment2.id,
              provider: 'GITHUB',
              provider_id: `fake-issue-p2-${githubLogin}`,
              provider_issue_number: 998,
              status: 'OPEN',
            },
          });
        }
      }
    }
    return redirect(next);
  }

  // From the roster invite link (#343). Opening that mail already proved the
  // address, so the token stands in for the code — for that address only. A
  // token that fails to verify is simply ignored and the code flow applies.
  const inviteToken = url.searchParams.get('invite');
  const invite = inviteToken ? verifyInviteToken(inviteToken) : null;

  return {
    githubLogin,
    gitlabLogin: gitUsername(user, 'GITLAB'),
    name: user.name,
    // A Github sign-up arrives with its Github email; it still needs a code.
    suggestedEmail: invite?.email ?? user.email ?? null,
    invitedEmail: invite?.email ?? null,
    inviteToken: invite ? inviteToken : null,
    next,
  };
};

const Registration = ({ loaderData }: Route.ComponentProps) => {
  const { githubLogin, gitlabLogin, name, suggestedEmail, invitedEmail, inviteToken, next } =
    loaderData;
  // The provider username shown (display only; the server never reads it back).
  const gitLogin = githubLogin ?? gitlabLogin;
  const isGitLab = !githubLogin && Boolean(gitlabLogin);
  const fetcher = useFetcher();
  const codeFetcher = useFetcher();
  const verifyFetcher = useFetcher();
  const navigate = useNavigate();
  const [form] = Form.useForm();
  // An invite token pre-verifies the invited address. Choosing a different
  // address drops it, and the code flow takes over for the new one.
  const [useInvite, setUseInvite] = useState(inviteToken !== null);
  const [verifiedEmail, setVerifiedEmail] = useState<string | null>(
    inviteToken ? invitedEmail : null
  );

  const codeSent = codeFetcher.data?.codeSent === true;
  const emailVerified = verifyFetcher.data?.verified === true || verifiedEmail !== null;
  const verifyError = verifyFetcher.data?.verifyError;

  const useDifferentEmail = () => {
    setUseInvite(false);
    setVerifiedEmail(null);
    form.setFieldsValue({ email: '' });
  };

  const isSubmitting = ['submitting', 'loading'].includes(fetcher.state);
  const actionError = fetcher.data?.error;

  // Handle successful registration redirect
  useEffect(() => {
    if (fetcher.state === 'idle' && fetcher.data && !fetcher.data.error) {
      navigate(next);
    }
  }, [fetcher.state, fetcher.data, navigate, next]);

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
      { ...values, intent: 'register', invite_token: useInvite ? inviteToken : null, next },
      {
        method: 'POST',
        encType: 'application/json',
      }
    );
  };

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-neutral-950 flex flex-col items-center justify-center p-4">
      <div className="w-full max-w-md">
        {/* Header */}
        <div className="text-center mb-6">
          <div className="flex justify-center mb-4">
            <Logo size={48} />
          </div>
          <h1 className="text-xl font-semibold mb-2 dark:text-gray-100">Create Your Account</h1>
          <p className="text-gray-600 dark:text-gray-400 text-sm">
            Complete your profile to get started
          </p>
        </div>

        {/* Main Form Card */}
        <Card
          className="shadow-xs border border-gray-200 dark:border-neutral-800"
          styles={{ body: { padding: '24px' } }}
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
              login: gitLogin ?? undefined,
              email: suggestedEmail ?? undefined,
              name: name ?? undefined,
            }}
            disabled={isSubmitting}
          >
            {/* School Email + Send Code */}
            <Form.Item
              label={
                <span className="flex items-center gap-2 font-medium text-gray-700 text-sm">
                  <MailOutlined />
                  School Email
                  {emailVerified && <CheckCircleFilled style={{ color: '#22c55e' }} />}
                </span>
              }
              required
              className="mb-3"
            >
              {/* The field is its own Form.Item so the Input is the direct child
                  and receives the form value. Wrapped in Space.Compact it did
                  not: the value landed on Compact's div, so typing worked but a
                  prefilled address (invite link) never showed. */}
              <Space.Compact style={{ width: '100%' }}>
                <Form.Item
                  name="email"
                  noStyle
                  rules={[
                    { required: true, message: 'Please enter your school email' },
                    { type: 'email', message: 'Please enter a valid email address' },
                  ]}
                >
                  <Input
                    placeholder="your.email@university.edu"
                    prefix={<MailOutlined className="text-gray-400" />}
                    readOnly={emailVerified}
                    className={emailVerified ? 'bg-gray-50' : ''}
                  />
                </Form.Item>
                {!emailVerified && (
                  <Button onClick={handleSendCode} loading={codeFetcher.state === 'submitting'}>
                    {codeSent ? 'Resend' : 'Send Code'}
                  </Button>
                )}
              </Space.Compact>
            </Form.Item>

            {useInvite && emailVerified && (
              <p className="-mt-1 mb-4 text-xs text-gray-500">
                Verified through your invitation.{' '}
                <button
                  type="button"
                  onClick={useDifferentEmail}
                  className="text-accent hover:underline cursor-pointer"
                >
                  Use a different email
                </button>
              </p>
            )}

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

                {/* Github or Gitlab username */}
                {gitLogin && (
                  <Form.Item
                    label={
                      <span className="flex items-center gap-2 font-medium text-gray-700 text-sm">
                        {isGitLab ? (
                          <GitlabLogo size={14} />
                        ) : (
                          <GithubOutlined className="text-gray-900 dark:text-gray-100" />
                        )}
                        {isGitLab ? 'Gitlab Username' : 'Github Username'}
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
                )}

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
            By registering, you agree to our{' '}
            <a
              href="https://classmoji.io/terms"
              target="_blank"
              rel="noopener noreferrer"
              className="underline hover:text-gray-700 dark:hover:text-gray-300"
            >
              Terms of Service
            </a>{' '}
            and{' '}
            <a
              href="https://classmoji.io/privacy"
              target="_blank"
              rel="noopener noreferrer"
              className="underline hover:text-gray-700 dark:hover:text-gray-300"
            >
              Privacy Policy
            </a>
            .
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
    await sendEmailVerificationCode(formData.email);
    return { codeSent: true };
  }

  // ── Verify code inline ──────────────────────────────────────────────────
  if (intent === 'verify-code') {
    if (!(await isEmailVerificationCodeValid(formData.email, formData.code))) {
      return { verifyError: 'Invalid or expired code. Try resending.' };
    }
    return { verified: true };
  }

  // ── Register (re-validate + create user) ────────────────────────────────
  // Either a signed invite token for exactly this address, or a code.
  const invite = formData.invite_token ? verifyInviteToken(formData.invite_token) : null;
  const provenByInvite = invite !== null && inviteTokenMatchesEmail(invite, formData.email);
  if (!provenByInvite && !(await consumeEmailVerificationCode(formData.email, formData.code))) {
    return { error: 'Verification code is invalid or expired. Please verify your email again.' };
  }

  if (!authData?.userId) return redirect('/');
  const email = String(formData.email).trim().toLowerCase();

  // Check if email is already in use by another user
  const existingUserWithEmail = await getPrisma().user.findFirst({
    where: {
      email: { equals: email, mode: 'insensitive' },
      NOT: { id: authData.userId },
    },
  });
  if (existingUserWithEmail) {
    return { error: 'This email is already in use by another account.' };
  }

  const user = await getPrisma().user.update({
    where: { id: authData.userId },
    data: {
      name: formData.name,
      email,
      emailVerified: true,
      school_id: formData.school_id || null,
    },
  });
  const hasSubscription = await getPrisma().subscription.count({ where: { user_id: user.id } });
  if (!hasSubscription) {
    await getPrisma().subscription.create({
      data: { id: String(generateId()), tier: 'FREE', user_id: user.id },
    });
  }

  // Claim any pending classroom invites addressed to either email we now hold
  // for this user. The same call runs on login and on an email change, so a
  // student invited at an address they did not register with is no longer
  // stranded (#307).
  await ClassmojiService.classroomInvite.claimPendingInvites(user.id);

  // The "Example Course" sandbox is no longer provisioned here: it is created
  // on demand when someone starts the tour (POST /api/example-classroom).
  // Most accounts are students, who never needed one.

  return redirect(safeNext(formData.next));
};

export default Registration;
