import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { Alert, Button } from 'antd';
import { GithubOutlined } from '@ant-design/icons';

import useStore from '~/store';
import { authClient } from '@classmoji/auth/client';
import GitLabIcon from '~/components/ui/display/gitlab.svg';

const LINK_ERRORS: Record<string, string> = {
  account_already_linked_to_different_user:
    'That Github account already belongs to another Classmoji account.',
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
  <div className="flex items-center justify-between gap-4 py-5 border-b border-line last:border-b-0">
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

const SettingsConnections = () => {
  const { user } = useStore();
  const [searchParams] = useSearchParams();
  const linkError = searchParams.get('error');
  const [error, setError] = useState<string | null>(
    linkError ? (LINK_ERRORS[linkError] ?? 'Connecting Github failed.') : null
  );

  const connectGithub = () =>
    authClient.linkSocial({
      provider: 'github',
      callbackURL: '/settings/connections',
      errorCallbackURL: '/settings/connections',
    });

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

      <ConnectionRow
        icon={<GithubOutlined />}
        name="Github"
        status={user?.has_github ? `Connected as @${user.login}` : 'Not connected'}
      >
        {!user?.has_github && (
          <Button type="primary" onClick={connectGithub}>
            Connect Github
          </Button>
        )}
      </ConnectionRow>

      <ConnectionRow
        icon={<img src={GitLabIcon} alt="" className="w-[18px] h-[18px] opacity-60" />}
        name="Gitlab"
        status="Connect a gitlab.com or self-hosted Gitlab account."
      >
        <span className="rounded-full bg-stone-100 dark:bg-neutral-800 px-2.5 py-1 text-xs font-medium text-gray-500 dark:text-gray-400">
          Coming soon
        </span>
      </ConnectionRow>
    </div>
  );
};

export default SettingsConnections;
