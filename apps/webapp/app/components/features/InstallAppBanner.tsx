import { useCallback } from 'react';
import { Alert, Button } from 'antd';
import { useFetcher } from 'react-router';
import { useGitHubAppInstallPopup } from '~/hooks';
import {
  describeInstallCheck,
  installCheckToneClass,
  type InstallCheckResult,
} from './githubInstallStatus';

interface Props {
  /** The GitHub org login this classroom belongs to. */
  orgLogin: string;
  /** Classmoji GitHub App name (from the loader's process.env.GITHUB_APP_NAME). */
  githubAppName?: string;
  /** Classroom slug, for the "check again" endpoint URL. */
  classSlug: string;
}

/**
 * Non-blocking prompt to install the Classmoji GitHub App on a classroom's org.
 * Shown on classrooms with no app installation (e.g. ones imported from GitHub
 * Classroom), where the live GitHub features are dormant until the app is
 * installed. Installing fills in the org's `github_installation_id`, after which
 * every GitHub-touching view lights up — no re-import needed.
 *
 * Deliberately NOT dismissible. Dismissal hid the only entry point back to a
 * working classroom for the rest of the term, and the banner already disappears
 * the moment the installation is found — the one exit that actually fixes
 * anything. (The old `cm-install-banner-dismissed:*` localStorage keys are left
 * where they are; nothing reads them any more.)
 *
 * The webhook that normally fills the id in can be missed, or replayed stale, so
 * "Check again" asks GitHub directly rather than waiting on it — and closing the
 * install popup asks on the instructor's behalf.
 */
export default function InstallAppBanner({ orgLogin, githubAppName, classSlug }: Props) {
  const fetcher = useFetcher<InstallCheckResult>();
  const checking = fetcher.state !== 'idle';
  const checkAction = `/api/classrooms/${encodeURIComponent(classSlug)}/github-installation`;

  const checkInstallation = useCallback(() => {
    fetcher.submit(null, { method: 'post', action: checkAction });
  }, [fetcher, checkAction]);

  // Closing the popup runs the same check the button does. React Router
  // revalidates every loader on the page once a fetcher's action resolves, so a
  // successful reconnect removes this banner with no explicit refresh here.
  const { openInstallPopup } = useGitHubAppInstallPopup(githubAppName, checkInstallation);

  const result = fetcher.state === 'idle' ? fetcher.data : undefined;

  return (
    <Alert
      type="info"
      showIcon
      message="Connect this classroom to GitHub"
      description={
        <div className="flex flex-col gap-2">
          <span>
            Install the Classmoji GitHub App on <span className="font-medium">{orgLogin}</span> to
            enable live repository syncing, grading, and creating new assignments. Your imported
            roster and assignments are already here.
          </span>
          <div className="flex flex-wrap items-center gap-2">
            {/* No configured app name means the install URL would be
                `apps/undefined` — a GitHub 404 dressed up as our fix. Drop the
                button rather than offer it: "Check again" still works, and the
                banner still names the problem. */}
            {githubAppName && (
              <Button type="primary" onClick={openInstallPopup}>
                Install GitHub App
              </Button>
            )}
            {/* A Form, not an onClick: with lazy route discovery the client
                only learns about the API route the first time something
                points at it. A rendered Form is discovered on render, so the
                click posts at once; a bare fetcher.submit discovers on click,
                which on staging meant a ten-second manifest round trip during
                which nothing on screen changed. (fetcher.Form is the same Form
                underneath, with discovery defaulting to "render".) The
                popup-close path submits to the same action, discovered by
                this Form by then. */}
            <fetcher.Form method="post" action={checkAction}>
              <Button htmlType="submit" loading={checking} disabled={checking}>
                Check again
              </Button>
            </fetcher.Form>
          </div>
          {result && <CheckOutcome result={result} orgLogin={orgLogin} />}
        </div>
      }
    />
  );
}

/**
 * One sentence per outcome of the check, inline under the buttons.
 * `connected`/`already-connected` are shown too: the revalidation that unmounts
 * this banner is a round trip away, so without them the click looks inert.
 *
 * The wording itself lives in `githubInstallStatus` so the import wizard's copy
 * of this check tells the instructor exactly the same thing.
 */
function CheckOutcome({ result, orgLogin }: { result: InstallCheckResult; orgLogin: string }) {
  const { tone, text } = describeInstallCheck(result, orgLogin);

  return (
    <div role="status" aria-live="polite" className={`text-sm ${installCheckToneClass(tone)}`}>
      {text}
    </div>
  );
}
