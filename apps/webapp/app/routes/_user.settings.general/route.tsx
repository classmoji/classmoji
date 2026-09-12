import { useEffect, useState } from 'react';
import { useFetcher } from 'react-router';
import { Avatar, Form, Input, Card, Button, Alert } from 'antd';
import { GithubOutlined, MailOutlined, UserOutlined, LockOutlined } from '@ant-design/icons';
import { IconId } from '@tabler/icons-react';

import useStore from '~/store';
import { requireAuth } from '@classmoji/auth/server';
import getPrisma from '@classmoji/database';
import { ClassmojiService } from '@classmoji/services';
import {
  sendEmailVerificationCode,
  consumeEmailVerificationCode,
} from '~/utils/emailVerification.server';
import { normalizeSchoolId, SCHOOL_ID_MAX_LENGTH } from '~/utils/schoolId';
import type { Route } from './+types/route';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Account edits, all scoped to the signed-in user's own row (#343):
 *  - update-school-id: the contact detail set once at registration
 *  - send-code: mail a one-time code to a NEW email address
 *  - change-email: burn the code and write the address; ClassmojiService.user
 *    .update then claims any classroom invite sent to it (#307), which is the
 *    whole point — a student who mistyped their address at sign-up gets into
 *    the classroom they were invited to.
 * `provider_email` (the Github one) is never touched here.
 */
export const action = async ({ request }: Route.ActionArgs) => {
  const { userId } = await requireAuth(request);
  const body = (await request.json()) as {
    intent?: string;
    email?: unknown;
    code?: unknown;
    school_id?: unknown;
  };

  if (body.intent === 'update-school-id') {
    const schoolId = normalizeSchoolId(body.school_id);
    if (schoolId === undefined) {
      return { error: `School ID must be ${SCHOOL_ID_MAX_LENGTH} characters or fewer.` };
    }
    await ClassmojiService.user.update(userId, { school_id: schoolId });
    return { schoolIdSaved: true };
  }

  const email = typeof body.email === 'string' ? body.email.trim() : '';

  if (!EMAIL_RE.test(email)) {
    return { error: 'Please enter a valid email address.' };
  }

  // Refuse an address another account already holds, before spending a code
  // on it. Case-insensitive: `email` is unique as typed, but two casings of
  // one mailbox are one mailbox.
  const taken = await getPrisma().user.findFirst({
    where: { email: { equals: email, mode: 'insensitive' }, NOT: { id: userId } },
    select: { id: true },
  });
  if (taken) {
    return { error: 'This email is already in use by another account.' };
  }

  if (body.intent === 'send-code') {
    await sendEmailVerificationCode(email);
    return { codeSent: true };
  }

  if (body.intent === 'change-email') {
    const code = typeof body.code === 'string' ? body.code.trim() : '';
    if (!(await consumeEmailVerificationCode(email, code))) {
      return { error: 'Invalid or expired code. Try resending.' };
    }
    await ClassmojiService.user.update(userId, { email, emailVerified: true });
    return { changed: true };
  }

  return { error: 'Unknown action.' };
};

const readOnlyInput = 'h-12 rounded-md cursor-not-allowed';

/** Field label with a muted "Read-only" marker beside it. */
const ReadOnlyLabel = ({ children }: { children: string }) => (
  <span className="flex items-center gap-3">
    <span className="text-ink-1 font-medium text-sm">{children}</span>
    <span className="inline-flex items-center gap-1 text-xs text-ink-3">
      <LockOutlined /> Read-only
    </span>
  </span>
);

const SettingsGeneral = () => {
  const { user } = useStore();
  const [form] = Form.useForm();

  const codeFetcher = useFetcher<{ codeSent?: boolean; error?: string }>();
  const saveFetcher = useFetcher<{ changed?: boolean; error?: string }>();
  const schoolIdFetcher = useFetcher<{ schoolIdSaved?: boolean; error?: string }>();
  const [schoolId, setSchoolId] = useState('');
  const schoolIdDirty = schoolId.trim() !== (user?.school_id ?? '');
  const savingSchoolId = schoolIdFetcher.state !== 'idle';
  const [editing, setEditing] = useState(false);
  const [newEmail, setNewEmail] = useState('');
  const [code, setCode] = useState('');
  const [changedTo, setChangedTo] = useState<string | null>(null);

  const codeSent = codeFetcher.data?.codeSent === true;
  const error = saveFetcher.data?.error ?? codeFetcher.data?.error;
  const sending = codeFetcher.state !== 'idle';
  const saving = saveFetcher.state !== 'idle';

  // Update form values when user data becomes available (after Zustand hydrates)
  useEffect(() => {
    if (user) {
      form.setFieldsValue({
        name: user.name,
        github_username: user.login,
      });
      setSchoolId(user.school_id ?? '');
    }
  }, [user, form]);

  // Saved: close the editor. The root loader revalidates and the store picks up
  // the new address; `changedTo` keeps the confirmation on screen meanwhile.
  useEffect(() => {
    if (saveFetcher.state === 'idle' && saveFetcher.data?.changed) {
      setChangedTo(newEmail);
      setEditing(false);
      setNewEmail('');
      setCode('');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saveFetcher.state, saveFetcher.data]);

  const submit = (intent: 'send-code' | 'change-email') => {
    const fetcher = intent === 'send-code' ? codeFetcher : saveFetcher;
    fetcher.submit(
      { intent, email: newEmail, code },
      { method: 'POST', encType: 'application/json' }
    );
  };

  const saveSchoolId = () =>
    schoolIdFetcher.submit(
      { intent: 'update-school-id', school_id: schoolId },
      { method: 'POST', encType: 'application/json' }
    );

  const cancelEdit = () => {
    setEditing(false);
    setNewEmail('');
    setCode('');
  };

  return (
    <div className="w-2/3">
      <Card className="">
        {/* Profile Header */}
        <div className="flex items-start gap-6 mb-8">
          <div className="relative">
            <Avatar
              src={user?.avatar_url}
              size={120}
              className="shadow-sm"
              style={{
                border: '4px solid var(--line)',
              }}
            />
          </div>
          <div className="flex-1">
            <h3 className="text-lg font-semibold text-gray-800 dark:text-gray-100 mb-2">
              {user?.name || 'User Name'}
            </h3>
            <p className="text-ink-2 text-base mb-3">{user?.email}</p>
            <div className="flex items-center gap-2 text-sm text-gray-500">
              <GithubOutlined className="text-gray-400" />
              <span>@{user?.login}</span>
            </div>
          </div>
        </div>

        <div className="border-t border-gray-200 dark:border-neutral-700 my-8"></div>

        {/* Form Section */}
        <div>
          <h4
            data-onboarding="settings-general"
            className="text-base font-semibold text-gray-800 dark:text-gray-100 mb-6"
          >
            Profile Information
          </h4>

          {changedTo && (
            <Alert
              type="success"
              showIcon
              closable
              onClose={() => setChangedTo(null)}
              className="mb-6"
              message={`Email updated to ${changedTo}.`}
              description="Any classroom invitations sent to this address have been added to your account."
            />
          )}

          <Form
            form={form}
            layout="vertical"
            initialValues={{
              name: user?.name,
              github_username: user?.login,
            }}
            className="w-full"
          >
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <Form.Item
                label={<ReadOnlyLabel>Full Name</ReadOnlyLabel>}
                name="name"
                className="mb-6"
              >
                <Input
                  readOnly
                  variant="filled"
                  prefix={<UserOutlined className="text-gray-400" />}
                  className={readOnlyInput}
                />
              </Form.Item>

              {/* Email: read-only box, with the change flow opened from the
                  button on the label row (same layout as School ID below). */}
              <div className="mb-6">
                <div className="flex items-center justify-between mb-2 min-h-6">
                  <label htmlFor="account-email" className="text-ink-1 font-medium text-sm">
                    Email Address
                  </label>
                  {!editing && (
                    <Button size="small" onClick={() => setEditing(true)}>
                      Change
                    </Button>
                  )}
                </div>
                <Input
                  id="account-email"
                  readOnly
                  variant="filled"
                  value={user?.email ?? ''}
                  prefix={<MailOutlined className="text-gray-400" />}
                  className={readOnlyInput}
                />
              </div>

              <Form.Item
                label={<ReadOnlyLabel>Github Username</ReadOnlyLabel>}
                name="github_username"
                className="mb-6"
              >
                <Input
                  readOnly
                  variant="filled"
                  prefix={<GithubOutlined className="text-gray-400" />}
                  className={readOnlyInput}
                />
              </Form.Item>

              {/* School ID: editable, saved on its own (#343). Not a Form.Item,
                  since unlike the read-only fields above it has its own state.
                  Same shape as Email: the action lives on the label row. */}
              <div className="mb-6">
                <div className="flex items-center justify-between mb-2 min-h-6">
                  <label htmlFor="school-id" className="text-ink-1 font-medium text-sm">
                    School ID
                  </label>
                  {schoolIdDirty || savingSchoolId ? (
                    <Button
                      size="small"
                      type="primary"
                      onClick={saveSchoolId}
                      loading={savingSchoolId}
                    >
                      Save
                    </Button>
                  ) : schoolIdFetcher.data?.schoolIdSaved ? (
                    <span className="text-xs font-medium text-ink-3">Saved</span>
                  ) : null}
                </div>
                <Input
                  id="school-id"
                  prefix={<IconId size={16} className="text-gray-400" />}
                  placeholder="Your student ID"
                  maxLength={SCHOOL_ID_MAX_LENGTH}
                  value={schoolId}
                  onChange={e => setSchoolId(e.target.value)}
                  onPressEnter={() => schoolIdDirty && !savingSchoolId && saveSchoolId()}
                  status={schoolIdFetcher.data?.error ? 'error' : undefined}
                  className="h-12 rounded-md"
                />
                {schoolIdFetcher.data?.error && (
                  <p className="text-xs text-red-500 dark:text-red-400 mt-1">
                    {schoolIdFetcher.data.error}
                  </p>
                )}
              </div>
            </div>
          </Form>

          {editing && (
            <div className="mb-8 p-5 rounded-lg border border-line bg-bg-1">
              <p className="text-sm font-semibold text-ink-0 mb-1">Change email address</p>
              <p className="text-sm text-ink-3 mb-4">
                We will send a code to the new address to confirm it is yours. Classroom invitations
                sent to that address are picked up automatically once it is verified.
              </p>

              {error && <Alert type="error" showIcon message={error} className="mb-4" />}

              <div className="flex flex-col gap-3 max-w-md">
                <div className="flex gap-2">
                  <Input
                    type="email"
                    autoFocus
                    prefix={<MailOutlined className="text-gray-400" />}
                    placeholder="new.email@university.edu"
                    value={newEmail}
                    readOnly={codeSent}
                    onChange={e => setNewEmail(e.target.value)}
                    onPressEnter={() => !codeSent && newEmail && submit('send-code')}
                  />
                  {!codeSent && (
                    <Button
                      onClick={() => submit('send-code')}
                      loading={sending}
                      disabled={!newEmail}
                    >
                      Send code
                    </Button>
                  )}
                </div>

                {codeSent && (
                  <div className="flex gap-2">
                    <Input
                      placeholder="6-digit code"
                      maxLength={6}
                      value={code}
                      onChange={e => setCode(e.target.value)}
                      onPressEnter={() => code && submit('change-email')}
                    />
                    <Button
                      type="primary"
                      onClick={() => submit('change-email')}
                      loading={saving}
                      disabled={code.length < 6}
                    >
                      Verify and save
                    </Button>
                    <Button type="text" onClick={() => submit('send-code')} loading={sending}>
                      Resend
                    </Button>
                  </div>
                )}

                <div>
                  <Button type="text" size="small" onClick={cancelEdit}>
                    Cancel
                  </Button>
                </div>
              </div>
            </div>
          )}

          <div className="p-4 bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-lg">
            <div className="flex items-start gap-3">
              <div>
                <p className="text-yellow-800 font-medium mb-1 text-sm">From your Github account</p>
                <p className="text-yellow-700 text-sm leading-relaxed">
                  Your name and Github username come from Github and cannot be edited here.
                </p>
              </div>
            </div>
          </div>
        </div>
      </Card>
    </div>
  );
};

export default SettingsGeneral;
