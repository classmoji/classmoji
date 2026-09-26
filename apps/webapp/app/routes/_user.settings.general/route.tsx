import { useEffect, useState } from 'react';
import { GitlabLogo } from '~/components/ui/display/GitlabLogo';
import { useFetcher, useSearchParams } from 'react-router';
import { Avatar, Input, Card, Button, Alert } from 'antd';
import { GithubOutlined, MailOutlined, UserOutlined } from '@ant-design/icons';
import { IconId } from '@tabler/icons-react';

import useStore from '~/store';
import { useGitProvider } from '~/hooks';
import { authClient } from '@classmoji/auth/client';
import { useCallout } from '@classmoji/ui-components';
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

type LinkProvider = 'github' | 'gitlab';

/** Sign-in methods on this account, for the Connected accounts section. */
export const loader = async ({ request }: Route.LoaderArgs) => {
  const { userId } = await requireAuth(request);
  const accounts = await getPrisma().account.findMany({
    where: { user_id: userId, provider_id: { in: ['github', 'gitlab'] } },
    select: { provider_id: true, username: true },
  });
  const connected = accounts.map(a => ({
    provider: a.provider_id as LinkProvider,
    username: a.username,
  }));

  // Github is connected but its username could not become the main login
  // because another user holds it, so Github courses are closed to this user.
  // Unknown username (connected before usernames were recorded) is not "taken":
  // the next Github sign-in records it and promotes it.
  const githubUsername = connected.find(a => a.provider === 'github')?.username;
  const githubLoginTaken = githubUsername
    ? Boolean(
        await getPrisma().user.findFirst({
          where: { login: githubUsername, NOT: { id: userId } },
          select: { id: true },
        })
      )
    : false;

  return {
    connected,
    githubLoginTaken,
    // Only offer providers this deployment has configured.
    available: ['github', ...(process.env.GITLAB_CLIENT_ID ? ['gitlab'] : [])] as LinkProvider[],
  };
};

const PROVIDER_LABEL: Record<LinkProvider, string> = { github: 'Github', gitlab: 'Gitlab' };

/** better-auth's link errors (its callback appends `?error=`), in plain words. */
const LINK_ERRORS: Record<string, string> = {
  account_already_linked_to_different_user:
    'That account is already connected to a different Classmoji account.',
  unable_to_link_account: 'We could not connect that account. Please try again.',
  access_denied: 'Connection cancelled.',
};

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

/** Label on the left, an action or marker on the right, input below. */
const FieldRow = ({
  htmlFor,
  label,
  aside,
  children,
}: {
  htmlFor: string;
  label: string;
  aside?: React.ReactNode;
  children: React.ReactNode;
}) => (
  <div className="mb-6">
    <div className="flex items-center justify-between mb-2 min-h-6">
      <label htmlFor={htmlFor} className="text-ink-1 font-medium text-sm">
        {label}
      </label>
      {aside}
    </div>
    {children}
  </div>
);

const linkButton = 'text-xs font-medium text-accent hover:underline cursor-pointer';

const ConnectedAccounts = ({
  connected,
  available,
  githubLoginTaken,
}: {
  connected: { provider: LinkProvider; username: string | null }[];
  available: LinkProvider[];
  githubLoginTaken: boolean;
}) => {
  const [searchParams, setSearchParams] = useSearchParams();
  const [connecting, setConnecting] = useState<LinkProvider | null>(null);
  const linkError = searchParams.get('error');
  const justConnected = searchParams.get('connected') as LinkProvider | null;

  const connect = async (provider: LinkProvider) => {
    setConnecting(provider);
    // Links to the SIGNED-IN user; better-auth sends them to the provider and
    // back here, with `?error=` on failure.
    await authClient.linkSocial({
      provider,
      callbackURL: `/settings/general?connected=${provider}`,
      errorCallbackURL: '/settings/general',
    });
  };

  const dismiss = () => setSearchParams({}, { replace: true });

  return (
    <div className="mt-8">
      <h4 className="text-base font-semibold text-gray-800 dark:text-gray-100 mb-1">
        Connected accounts
      </h4>
      <p className="text-sm text-ink-3 mb-4">
        Sign in to this Classmoji account with any account connected here.
      </p>

      {linkError && (
        <Alert
          type="error"
          showIcon
          closable
          onClose={dismiss}
          style={{ marginBottom: 16 }}
          message={LINK_ERRORS[linkError] ?? `We could not connect that account (${linkError}).`}
        />
      )}
      {justConnected && connected.some(a => a.provider === justConnected) && (
        <Alert
          type="success"
          showIcon
          closable
          onClose={dismiss}
          style={{ marginBottom: 16 }}
          message={`${PROVIDER_LABEL[justConnected]} connected. You can now sign in with it.`}
        />
      )}

      {githubLoginTaken && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message="Your Github username is already used by another Classmoji account."
          description="You can sign in with Github, but you can't join Github courses until this is sorted out. Contact support."
        />
      )}

      <div className="divide-y divide-stone-200 dark:divide-neutral-800 rounded-lg ring-1 ring-stone-200 dark:ring-neutral-800">
        {available.map(provider => {
          const account = connected.find(a => a.provider === provider);
          return (
            <div key={provider} className="flex items-center justify-between px-4 py-3">
              <span className="flex items-center gap-2 text-sm font-medium text-ink-1">
                {provider === 'gitlab' ? (
                  <GitlabLogo size={14} />
                ) : (
                  <GithubOutlined />
                )}
                {PROVIDER_LABEL[provider]}
                {account?.username && (
                  <span className="font-normal text-ink-3">@{account.username}</span>
                )}
              </span>
              {account ? (
                <span className="text-xs font-medium text-green-700 dark:text-green-400">
                  Connected
                </span>
              ) : (
                <Button
                  size="small"
                  onClick={() => connect(provider)}
                  loading={connecting === provider}
                >
                  Connect
                </Button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};

const SettingsGeneral = ({ loaderData }: Route.ComponentProps) => {
  const { user, setUser } = useStore();
  const isGitLab = useGitProvider() === 'GITLAB';
  const providerName = isGitLab ? 'Gitlab' : 'Github';
  const ProviderIcon = isGitLab
    ? ({ className }: { className?: string }) => <GitlabLogo size={14} className={className} />
    : GithubOutlined;

  const codeFetcher = useFetcher<{ codeSent?: boolean; error?: string }>();
  const saveFetcher = useFetcher<{ changed?: boolean; error?: string }>();
  const callout = useCallout();
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

  // Seed the editable field once user data is in the store (after hydration).
  useEffect(() => {
    if (user) setSchoolId(user.school_id ?? '');
  }, [user]);

  // Confirm a School ID save out loud, and write it into the store so the
  // field reads as clean at once rather than after the root loader refreshes.
  useEffect(() => {
    if (schoolIdFetcher.state !== 'idle' || !schoolIdFetcher.data?.schoolIdSaved) return;
    const value = schoolId.trim();
    if (user) setUser({ ...user, school_id: value || null });
    callout.show({
      variant: 'success',
      title: value ? `School ID saved as ${value}.` : 'School ID cleared.',
      autoDismissMs: 4000,
    });
    // `callout` is stable per CalloutProvider; `schoolId` is read, not tracked.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schoolIdFetcher.state, schoolIdFetcher.data]);

  // Saved: close the editor. The root loader revalidates and the store picks up
  // the new address; `changedTo` keeps the confirmation on screen meanwhile.
  useEffect(() => {
    if (saveFetcher.state === 'idle' && saveFetcher.data?.changed) {
      const email = newEmail.trim();
      setChangedTo(email);
      if (user) setUser({ ...user, email });
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
              <ProviderIcon className="text-gray-400" />
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
              // Inline: antd's own margin rule outranks a Tailwind utility here.
              style={{ marginBottom: 32 }}
              message={`Email updated to ${changedTo}.`}
              description="Any classroom invitations sent to this address have been added to your account."
            />
          )}

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <FieldRow htmlFor="account-name" label="Full Name">
              <Input
                id="account-name"
                readOnly
                variant="filled"
                value={user?.name ?? ''}
                prefix={<UserOutlined className="text-gray-400" />}
                className={readOnlyInput}
              />
            </FieldRow>

            <FieldRow
              htmlFor="account-email"
              label="Email Address"
              aside={
                !editing && (
                  <button type="button" onClick={() => setEditing(true)} className={linkButton}>
                    Change
                  </button>
                )
              }
            >
              <Input
                id="account-email"
                readOnly
                variant="filled"
                value={user?.email ?? ''}
                prefix={<MailOutlined className="text-gray-400" />}
                className={readOnlyInput}
              />
            </FieldRow>

            {/* School ID: the one plain editable field, saved on its own (#343). */}
            <FieldRow
              htmlFor="school-id"
              label="School ID"
              aside={
                schoolIdDirty || savingSchoolId ? (
                  <Button
                    size="small"
                    type="primary"
                    onClick={saveSchoolId}
                    loading={savingSchoolId}
                  >
                    Save
                  </Button>
                ) : null
              }
            >
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
            </FieldRow>
          </div>

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
                <p className="text-yellow-800 dark:text-yellow-200 font-medium mb-1 text-sm">
                  From your {providerName} account
                </p>
                <p className="text-yellow-700 dark:text-yellow-300 text-sm leading-relaxed">
                  Your name comes from the account you signed up with and cannot be edited here.
                  Your usernames are listed under Connected accounts.
                </p>
              </div>
            </div>
          </div>

          <ConnectedAccounts
            connected={loaderData.connected}
            available={loaderData.available}
            githubLoginTaken={loaderData.githubLoginTaken}
          />
        </div>
      </Card>
    </div>
  );
};

export default SettingsGeneral;
