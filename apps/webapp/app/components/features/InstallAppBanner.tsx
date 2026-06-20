import { useState } from 'react';
import { Alert, Button } from 'antd';
import { useGitHubAppInstallPopup } from '~/hooks';

interface Props {
  /** The GitHub org login this classroom belongs to. */
  orgLogin: string;
  /** Classmoji GitHub App name (from the loader's process.env.GITHUB_APP_NAME). */
  githubAppName?: string;
}

/**
 * Non-blocking, dismissible prompt to install the Classmoji GitHub App on a
 * classroom's org. Shown on classrooms with no app installation (e.g. ones
 * imported from GitHub Classroom), where the live GitHub features are dormant
 * until the app is installed. Installing fills in the org's
 * `github_installation_id` (via the existing installation webhook), after which
 * every GitHub-touching view lights up — no re-import needed.
 *
 * Dismissal is remembered per org in localStorage so it doesn't nag each visit.
 */
export default function InstallAppBanner({ orgLogin, githubAppName }: Props) {
  const { openInstallPopup, isRefreshing } = useGitHubAppInstallPopup(githubAppName);
  const storageKey = `cm-install-banner-dismissed:${orgLogin}`;

  const [dismissed, setDismissed] = useState(() => {
    try {
      return typeof window !== 'undefined' && window.localStorage.getItem(storageKey) === '1';
    } catch {
      return false;
    }
  });

  if (dismissed) return null;

  return (
    <Alert
      type="info"
      showIcon
      closable
      onClose={() => {
        try {
          window.localStorage.setItem(storageKey, '1');
        } catch {
          /* ignore storage errors */
        }
        setDismissed(true);
      }}
      message="Connect this classroom to GitHub"
      description={
        <div className="flex flex-col gap-2">
          <span>
            Install the Classmoji GitHub App on <span className="font-medium">{orgLogin}</span> to
            enable live repository syncing, grading, and creating new assignments. Your imported
            roster and assignments are already here.
          </span>
          <div>
            <Button type="primary" onClick={openInstallPopup} loading={isRefreshing}>
              Install GitHub App
            </Button>
          </div>
        </div>
      }
    />
  );
}
