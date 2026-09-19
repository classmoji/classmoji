/**
 * The one place that turns a `POST /api/classrooms/:class/github-installation`
 * outcome into a sentence.
 *
 * Two surfaces ask that endpoint — the dashboard/repos install banner and the
 * end of the GitHub Classroom import wizard — and an instructor who sees
 * "not installed yet" in one place and something differently worded in the
 * other has no way to tell whether they are the same answer. Keeping the map
 * here is what makes them the same answer.
 *
 * Deliberately free of any `@classmoji/services` import: this module is pulled
 * into the client bundle by both callers.
 */

/** What `POST /api/classrooms/:class/github-installation` answers with. */
export interface InstallCheckResult {
  status: string;
  login?: string | null;
  retryAfterSeconds?: number;
}

export type InstallCheckTone = 'success' | 'warning' | 'error';

/**
 * The two outcomes that mean the org is connected and the caller may stop
 * asking. `already-connected` is not a no-op: it is what a successful install
 * looks like when the webhook won the race with the instructor closing the
 * popup.
 */
export const isInstallConnected = (status: string) =>
  status === 'connected' || status === 'already-connected';

/**
 * One sentence per outcome, plus the tone it should be shown in.
 *
 * `login` falls back to the caller's known org login: the endpoint echoes the
 * row's login, but a client that never got one still has to name the org.
 */
export function describeInstallCheck(
  result: InstallCheckResult,
  fallbackLogin: string
): { tone: InstallCheckTone; text: string } {
  const login = result.login || fallbackLogin;

  switch (result.status) {
    case 'connected':
    case 'already-connected':
      return { tone: 'success', text: 'Connected to GitHub' };
    case 'not-installed':
      return { tone: 'warning', text: `The Classmoji app isn't installed on ${login} yet.` };
    case 'login-moved':
      return {
        tone: 'warning',
        text: `The GitHub organization ${login} appears to have been renamed or moved. Contact support.`,
      };
    case 'suspended':
      return {
        tone: 'warning',
        text: `The Classmoji app is suspended on ${login}. Un-suspend it in GitHub's app settings.`,
      };
    case 'rate-limited':
      return {
        tone: 'warning',
        text: `Checked recently. Try again in ${result.retryAfterSeconds ?? 15} s.`,
      };
    case 'not-github':
      return { tone: 'error', text: 'This classroom is not hosted on GitHub.' };
    case 'not-eligible':
      return { tone: 'error', text: "This classroom can't be connected to GitHub." };
    default:
      // wrong-app, not-found, error — all one thing to the instructor, and the
      // specifics are in the server log and the audit row.
      return {
        tone: 'error',
        text: "Couldn't verify the installation. Try again or contact support.",
      };
  }
}

/** Tailwind text colour for a tone, in both themes. */
export function installCheckToneClass(tone: InstallCheckTone): string {
  if (tone === 'success') return 'text-emerald-700 dark:text-emerald-300';
  if (tone === 'error') return 'text-rose-700 dark:text-rose-300';
  return 'text-amber-700 dark:text-amber-300';
}
