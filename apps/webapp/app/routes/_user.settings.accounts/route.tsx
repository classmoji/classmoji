import { useEffect, useState } from 'react';
import { useFetcher, useSearchParams } from 'react-router';
import { Alert, Button, Input } from 'antd';
import { GithubOutlined, MailOutlined } from '@ant-design/icons';

import useStore from '~/store';
import { auth, requireAuth } from '@classmoji/auth/server';
import { authClient } from '@classmoji/auth/client';
import type { Route } from './+types/route';

const MIN_PASSWORD_LENGTH = 8;

const LINK_ERRORS: Record<string, string> = {
  account_already_linked_to_different_user:
    'That Github account already belongs to another Classmoji account.',
};

/**
 * set-password: add an email+password sign-in to an account that has none
 * (a Github sign-up). Changing an existing password happens client-side
 * through better-auth, which checks the current one.
 */
export const action = async ({ request }: Route.ActionArgs) => {
  await requireAuth(request);
  const body = (await request.json()) as { intent?: string; password?: unknown };

  if (body.intent === 'set-password') {
    const password = typeof body.password === 'string' ? body.password : '';
    if (password.length < MIN_PASSWORD_LENGTH) {
      return { error: `Use at least ${MIN_PASSWORD_LENGTH} characters.` };
    }
    try {
      // Server-only: fails if the account already has a password.
      await auth.api.setPassword({ body: { newPassword: password }, headers: request.headers });
    } catch (error) {
      console.error('[settings] set-password failed', error);
      return { error: 'Could not set a password. Sign in again and retry.' };
    }
    return { passwordSet: true };
  }

  return { error: 'Unknown action.' };
};

/** One sign-in method: icon, name and status on the left, its controls on the right. */
const MethodRow = ({
  icon,
  name,
  status,
  children,
}: {
  icon: React.ReactNode;
  name: string;
  status: string;
  children?: React.ReactNode;
}) => (
  <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4 py-5 border-b border-line last:border-b-0">
    <div className="flex items-center gap-3">
      <span className="text-lg text-gray-500 dark:text-gray-400">{icon}</span>
      <div>
        <p className="text-sm font-medium text-ink-1">{name}</p>
        <p className="text-sm text-ink-3">{status}</p>
      </div>
    </div>
    {children}
  </div>
);

const SettingsAccounts = () => {
  const { user } = useStore();
  const [searchParams] = useSearchParams();
  const passwordFetcher = useFetcher<{ passwordSet?: boolean; error?: string }>();
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [changing, setChanging] = useState(false);
  const linkError = searchParams.get('error');
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(
    linkError
      ? { type: 'error', text: LINK_ERRORS[linkError] ?? 'Connecting Github failed.' }
      : null
  );

  useEffect(() => {
    if (passwordFetcher.data?.passwordSet) {
      setPassword('');
      setConfirmPassword('');
      setMessage({ type: 'success', text: `You can now sign in with ${user?.email}.` });
    } else if (passwordFetcher.data?.error) {
      setMessage({ type: 'error', text: passwordFetcher.data.error });
    }
  }, [passwordFetcher.data, user?.email]);

  const connectGithub = () =>
    authClient.linkSocial({
      provider: 'github',
      callbackURL: '/settings/accounts',
      errorCallbackURL: '/settings/accounts',
    });

  const passwordsMatch = password === confirmPassword;
  const passwordReady = password.length >= MIN_PASSWORD_LENGTH && passwordsMatch;

  const setNewPassword = () =>
    passwordFetcher.submit(
      { intent: 'set-password', password },
      { method: 'POST', encType: 'application/json' }
    );

  const changePassword = async () => {
    setChanging(true);
    const { error } = await authClient.changePassword({
      currentPassword,
      newPassword: password,
      revokeOtherSessions: true,
    });
    setChanging(false);
    if (error) {
      setMessage({ type: 'error', text: error.message || 'Could not change your password.' });
      return;
    }
    setPassword('');
    setConfirmPassword('');
    setCurrentPassword('');
    setMessage({ type: 'success', text: 'Password changed.' });
  };

  return (
    <div className="max-w-2xl">
      <h2 className="text-base font-semibold text-gray-800 dark:text-gray-100 mb-1">
        Sign-in methods
      </h2>
      <p className="text-sm text-ink-3 mb-4">The accounts you can use to sign in to Classmoji.</p>

      {message && (
        <Alert
          type={message.type}
          showIcon
          closable
          onClose={() => setMessage(null)}
          style={{ marginBottom: 8 }}
          message={message.text}
        />
      )}

      <MethodRow
        icon={<GithubOutlined />}
        name="Github"
        status={user?.has_github ? `Connected as @${user.login}` : 'Not connected'}
      >
        {!user?.has_github && (
          <Button type="primary" onClick={connectGithub}>
            Connect Github
          </Button>
        )}
      </MethodRow>

      <MethodRow
        icon={<MailOutlined />}
        name="Email and password"
        status={
          user?.has_password
            ? `Sign in with ${user.email}`
            : 'Add a password to sign in with your email.'
        }
      >
        <div className="flex flex-col gap-2 w-full sm:w-72">
          {user?.has_password && (
            <Input.Password
              placeholder="Current password"
              autoComplete="current-password"
              value={currentPassword}
              onChange={e => setCurrentPassword(e.target.value)}
            />
          )}
          <Input.Password
            placeholder={`New password (${MIN_PASSWORD_LENGTH}+ characters)`}
            autoComplete="new-password"
            value={password}
            onChange={e => setPassword(e.target.value)}
          />
          <Input.Password
            placeholder="Confirm new password"
            autoComplete="new-password"
            value={confirmPassword}
            onChange={e => setConfirmPassword(e.target.value)}
            status={confirmPassword && !passwordsMatch ? 'error' : undefined}
          />
          {confirmPassword && !passwordsMatch && (
            <p className="text-xs text-red-500 dark:text-red-400">The passwords do not match.</p>
          )}
          {user?.has_password ? (
            <Button
              onClick={changePassword}
              loading={changing}
              disabled={!passwordReady || !currentPassword}
            >
              Change password
            </Button>
          ) : (
            <Button
              onClick={setNewPassword}
              loading={passwordFetcher.state !== 'idle'}
              disabled={!passwordReady || !user?.email}
            >
              Set password
            </Button>
          )}
        </div>
      </MethodRow>
    </div>
  );
};

export default SettingsAccounts;
