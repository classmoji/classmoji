import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { Alert, Button, Input } from 'antd';
import { GithubOutlined } from '@ant-design/icons';

import { requireAuth } from '@classmoji/auth/server';
import { authClient } from '@classmoji/auth/client';
import getPrisma from '@classmoji/database';
import { ClassmojiService } from '@classmoji/services';
import { parseGitlabId } from '@classmoji/utils';
import { GitlabLogo } from '~/components/ui/display/GitlabLogo';
import type { Route } from './+types/route';

const CALLBACK_URL = '/settings/connections';

/** The signed-in user's git accounts, and whether Gitlab can be connected here. */
export const loader = async ({ request }: Route.LoaderArgs) => {
  const { userId } = await requireAuth(request);
  const accounts = await getPrisma().account.findMany({
    where: { user_id: userId, provider_id: { in: ['github', 'gitlab'] } },
    select: { provider_id: true, username: true, account_id: true },
  });
  const instances = ClassmojiService.gitlabInstance;
  const gitlabAccount = accounts.find(a => a.provider_id === 'gitlab');
  // A self-managed Gitlab account names its server; gitlab.com's doesn't.
  const instanceId = gitlabAccount ? parseGitlabId(gitlabAccount.account_id).instanceId : null;
  const instanceHost = instanceId ? await instances.hostFor(instanceId).catch(() => null) : null;

  // Gitlab can be connected through gitlab.com (when configured) or any
  // self-managed instance set up at /gitlab/setup and approved.
  const gitlabDefaultHost = instances.defaultConfigured() ? instances.defaultHost() : null;
  const hasInstances =
    (await getPrisma().gitLabInstance.count({
      where: { disabled_at: null, approved_at: { not: null } },
    })) > 0;

  return {
    github: accounts.find(a => a.provider_id === 'github')?.username ?? null,
    gitlab: gitlabAccount
      ? {
          username: gitlabAccount.username,
          host: instanceHost ? new URL(instanceHost).host : null,
        }
      : null,
    gitlabAvailable: Boolean(gitlabDefaultHost) || hasInstances,
    gitlabDefaultHost,
  };
};

/** better-auth's link errors (its callback appends `?error=`), in plain words. */
const LINK_ERRORS: Record<string, string> = {
  account_already_linked_to_different_user:
    'That account already belongs to another Classmoji account.',
  gitlab_already_connected: 'This account already has a Gitlab account connected.',
  gitlab_instance_unavailable: 'That Gitlab is no longer available.',
  unable_to_link_account: 'We could not connect that account. Please try again.',
  access_denied: 'Connection cancelled.',
};

/** One connected provider: icon, name and status on the left, its action on the right. */
const ConnectionRow = ({
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
  <div className="flex items-center justify-between gap-4 py-5">
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

/**
 * Which Gitlab to connect: gitlab.com, or a school's own address (the same
 * choice as the sign-in page). A self-managed one links through the
 * gitlab-instance plugin; gitlab.com through better-auth's own provider.
 */
const GitLabConnectChooser = ({
  defaultHost,
  onCancel,
}: {
  defaultHost: string | null;
  onCancel: () => void;
}) => {
  const [host, setHost] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  // A Gitlab Classmoji doesn't know yet: offer to set it up.
  const [unknownHost, setUnknownHost] = useState<string | null>(null);

  const linkInstance = async (instanceId: string) => {
    const response = await fetch('/api/auth/gitlab-instance/link', {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        instanceId,
        callbackURL: CALLBACK_URL,
        errorCallbackURL: CALLBACK_URL,
      }),
    });
    const body = (await response.json().catch(() => null)) as {
      url?: string;
      message?: string;
    } | null;
    if (response.ok && body?.url) {
      window.location.href = body.url;
      return;
    }
    setMessage(body?.message ?? 'Could not start connecting Gitlab.');
    setBusy(false);
  };

  const connectDefault = async () => {
    setBusy(true);
    await authClient.linkSocial({
      provider: 'gitlab',
      callbackURL: CALLBACK_URL,
      errorCallbackURL: CALLBACK_URL,
    });
  };

  const connectHost = async () => {
    if (!host.trim()) return;
    setBusy(true);
    setMessage(null);
    setUnknownHost(null);
    const response = await fetch(
      `/api/gitlab-instances/lookup?host=${encodeURIComponent(host.trim())}`
    );
    const body = (await response.json().catch(() => null)) as
      | { status: 'ok'; instance: { id: string | null; host: string } }
      | { status: 'unknown' | 'disabled' | 'pending'; host: string }
      | { status: 'invalid' }
      | null;
    if (body?.status === 'ok') {
      if (body.instance.id === null) await connectDefault();
      else await linkInstance(body.instance.id);
      return;
    }
    setBusy(false);
    if (body?.status === 'unknown') {
      setUnknownHost(body.host);
      return;
    }
    setMessage(
      body?.status === 'pending'
        ? `${new URL(body.host).host} is waiting for Classmoji's approval. You can connect it once it is approved.`
        : body?.status === 'disabled'
          ? 'Sign-in with that Gitlab is turned off.'
          : 'Enter your Gitlab address, like gitlab.school.edu'
    );
  };

  return (
    <div className="pb-5 flex flex-col gap-2">
      {defaultHost && (
        <Button onClick={connectDefault} disabled={busy} className="self-start">
          {new URL(defaultHost).host}
        </Button>
      )}
      <div className="flex gap-2">
        <Input
          value={host}
          onChange={e => setHost(e.target.value)}
          onPressEnter={connectHost}
          placeholder="Self-hosted Gitlab address, e.g. gitlab.school.edu"
        />
        <Button type="primary" onClick={connectHost} loading={busy}>
          Connect
        </Button>
        <Button onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
      </div>
      {message && <p className="text-xs text-red-600 dark:text-red-400">{message}</p>}
      {unknownHost && (
        <p className="text-xs text-ink-3">
          {new URL(unknownHost).host} isn&apos;t connected to Classmoji yet.{' '}
          <a
            href={`/gitlab/setup?host=${encodeURIComponent(unknownHost)}`}
            className="font-medium text-accent hover:underline"
          >
            Set it up
          </a>
        </p>
      )}
    </div>
  );
};

const SettingsConnections = ({ loaderData }: Route.ComponentProps) => {
  const { github, gitlab, gitlabAvailable, gitlabDefaultHost } = loaderData;
  const [searchParams] = useSearchParams();
  const linkError = searchParams.get('error');
  const [error, setError] = useState<string | null>(
    linkError ? (LINK_ERRORS[linkError] ?? 'Connecting that account failed.') : null
  );
  const [choosingGitLab, setChoosingGitLab] = useState(false);

  const connectGithub = () =>
    authClient.linkSocial({
      provider: 'github',
      callbackURL: CALLBACK_URL,
      errorCallbackURL: CALLBACK_URL,
    });

  const gitlabStatus = gitlab
    ? `Connected as @${gitlab.username ?? 'unknown'}${gitlab.host ? ` on ${gitlab.host}` : ''}`
    : gitlabAvailable
      ? 'Connect a gitlab.com or self-hosted Gitlab account.'
      : 'Not available on this Classmoji.';

  return (
    <div className="max-w-2xl">
      <h2 className="text-base font-semibold text-gray-800 dark:text-gray-100 mb-1">
        Connected accounts
      </h2>
      <p className="text-sm text-ink-3 mb-4">
        Git accounts your classrooms run on. You can also sign in with them.
      </p>

      {error && (
        <Alert
          type="error"
          showIcon
          closable
          onClose={() => setError(null)}
          style={{ marginBottom: 8 }}
          message={error}
        />
      )}

      <div className="divide-y divide-line">
        <ConnectionRow
          icon={<GithubOutlined className="text-gray-900 dark:text-gray-100" />}
          name="Github"
          status={github ? `Connected as @${github}` : 'Not connected'}
        >
          {!github && (
            <Button type="primary" onClick={connectGithub}>
              Connect Github
            </Button>
          )}
        </ConnectionRow>

        <div>
          <ConnectionRow icon={<GitlabLogo size={18} />} name="Gitlab" status={gitlabStatus}>
            {!gitlab && gitlabAvailable && (
              <Button
                type="primary"
                onClick={() => setChoosingGitLab(true)}
                disabled={choosingGitLab}
              >
                Connect Gitlab
              </Button>
            )}
          </ConnectionRow>
          {!gitlab && choosingGitLab && (
            <GitLabConnectChooser
              defaultHost={gitlabDefaultHost}
              onCancel={() => setChoosingGitLab(false)}
            />
          )}
        </div>
      </div>
    </div>
  );
};

export default SettingsConnections;
