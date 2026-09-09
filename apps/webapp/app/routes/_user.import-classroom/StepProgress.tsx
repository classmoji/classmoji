import { useState } from 'react';
import { useNavigate } from 'react-router';
import { TriggerAuthContext, useRealtimeRunsWithTag } from '@trigger.dev/react-hooks';
import { Progress, Tag, Button, Alert, Spin } from 'antd';
import { CheckCircleFilled, WarningFilled } from '@ant-design/icons';

import { useGitHubAppInstallPopup } from '~/hooks';
import {
  describeInstallCheck,
  installCheckToneClass,
  isInstallConnected,
  type InstallCheckResult,
} from '~/components/features/githubInstallStatus';

const TASK_ID = 'import_github_classroom';
const TERMINAL = new Set([
  'COMPLETED',
  'FAILED',
  'CRASHED',
  'CANCELED',
  'SYSTEM FAILURE',
  'TIMED OUT',
  'EXPIRED',
]);

interface ImportSummaryOutput {
  classroomSlug?: string;
  studentsEnrolled?: number;
  assignmentsImported?: number;
  reposLinked?: number;
  gradesRecorded?: number;
  warnings?: string[];
  /** The GitHub org this classroom was imported into. */
  organizationLogin?: string;
  /** Whether that org already had a Classmoji App installation at import time. */
  appInstalled?: boolean;
}

interface RunLike {
  id: string;
  taskIdentifier: string;
  status: string;
  payload?: { name?: string; slug?: string };
  output?: ImportSummaryOutput;
  error?: { message?: string };
}

interface Props {
  accessToken: string;
  sessionId: string;
  expected: number;
  /** One classroom imported → land on it; several → back to the org picker. */
  single: boolean;
  /** Classmoji GitHub App name, for the "Connect GitHub" install popup. */
  githubAppName?: string;
}

/**
 * Step 4 — live import progress. Subscribes to the session's Trigger.dev runs
 * (one per classroom) and shows per-classroom status, counts, and warnings. When
 * everything finishes, offers a button to the new classroom (single import) or
 * back to the org picker (multiple).
 */
export default function StepProgress({
  accessToken,
  sessionId,
  expected,
  single,
  githubAppName,
}: Props) {
  return (
    <TriggerAuthContext.Provider value={{ accessToken }}>
      <ProgressInner
        sessionId={sessionId}
        expected={expected}
        single={single}
        githubAppName={githubAppName}
      />
    </TriggerAuthContext.Provider>
  );
}

function ProgressInner({ sessionId, expected, single, githubAppName }: Omit<Props, 'accessToken'>) {
  const navigate = useNavigate();
  const { runs, error } = useRealtimeRunsWithTag(`session_${sessionId}`);

  // Orgs this wizard has since confirmed connected, and the last check outcome
  // per org for the ones it could not confirm. Nothing on this page revalidates
  // — the run output is a finished Trigger.dev payload, not a loader — so the
  // "isn't installed" line can only be retired by what we learn here.
  const [connectedOrgs, setConnectedOrgs] = useState<string[]>([]);
  const [checkResults, setCheckResults] = useState<Record<string, InstallCheckResult>>({});
  const [checking, setChecking] = useState(false);

  const importRuns = (runs as unknown as RunLike[]).filter(r => r.taskIdentifier === TASK_ID);
  const terminal = importRuns.filter(r => TERMINAL.has(r.status));
  const failed = importRuns.filter(r =>
    ['FAILED', 'CRASHED', 'SYSTEM FAILURE', 'TIMED OUT'].includes(r.status)
  );
  const succeeded = importRuns.filter(r => r.status === 'COMPLETED');

  const allDone = terminal.length >= expected && importRuns.length >= expected;
  const percent = Math.min(100, Math.floor((terminal.length / Math.max(1, expected)) * 100));

  // Only the finished run knows the destination: the importer normalizes the
  // requested slug and suffixes it on a global collision, so the slug the
  // wizard submitted is not necessarily the one that got stored. With no run
  // output there is no slug to trust, and the org picker is the safe landing.
  const destinationSlug = single ? (succeeded[0]?.output?.classroomSlug ?? null) : null;

  // The import never touches GitHub, so an org with no Classmoji App
  // installation imports fine and then sits inert — no repo syncing, no new
  // assignments. Offer the install here, where the instructor still has the
  // context, rather than making them find the banner on the dashboard later.
  //
  // Only SUCCEEDED runs are consulted (a failed run imported nothing to connect)
  // and orgs are deduped: several classrooms routinely share one org, and the
  // popup installs on whichever the instructor picks, so one button covers them.
  //
  // One org maps to whichever of its succeeded classrooms answered first: the
  // check is per-ORG (it reconciles the GitOrganization row), so any classroom
  // in the org is an equally good address for it.
  const slugByOrg = new Map<string, string>();
  for (const run of succeeded) {
    const login = run.output?.organizationLogin;
    const slug = run.output?.classroomSlug;
    if (login && slug && !slugByOrg.has(login)) slugByOrg.set(login, slug);
  }

  const orgsNeedingInstall = Array.from(
    new Set(
      succeeded
        .filter(r => r.output?.appInstalled === false)
        .map(r => r.output?.organizationLogin)
        .filter((login): login is string => Boolean(login))
    )
  ).filter(login => !connectedOrgs.includes(login));
  const needsInstall = orgsNeedingInstall.length > 0 && Boolean(githubAppName);

  // Closing the install popup is the only signal we get that the instructor
  // did anything — GitHub redirects the popup, not this page. So ask the
  // "check again" endpoint on their behalf, once per org still outstanding,
  // and retire the ones that come back connected. Without this the notice and
  // its button sit there for the rest of the session no matter what the
  // instructor just installed.
  //
  // Deliberately NOT memoized: `useGitHubAppInstallPopup` holds its callback in
  // a ref precisely so an inline closure is safe, and memoizing this one would
  // mean memoizing every derived value it reads (all of which are rebuilt from
  // `runs` on each realtime tick anyway) to buy an identity nothing depends on.
  const confirmInstalls = async () => {
    const pending = orgsNeedingInstall
      .map(login => ({ login, slug: slugByOrg.get(login) }))
      .filter((o): o is { login: string; slug: string } => Boolean(o.slug));

    if (pending.length === 0) return;

    setChecking(true);
    try {
      const checked = await Promise.all(
        pending.map(async ({ login, slug }) => {
          try {
            const res = await fetch(
              `/api/classrooms/${encodeURIComponent(slug)}/github-installation`,
              { method: 'POST', headers: { Accept: 'application/json' } }
            );
            const body = (await res.json()) as InstallCheckResult;
            return { login, result: body };
          } catch {
            // A failed round trip is indistinguishable to the instructor from a
            // failed check, and both mean "we still don't know".
            return { login, result: { status: 'error' } as InstallCheckResult };
          }
        })
      );

      const nowConnected = checked
        .filter(c => isInstallConnected(c.result?.status ?? ''))
        .map(c => c.login);

      setCheckResults(prev => {
        const next = { ...prev };
        for (const { login, result } of checked) next[login] = result;
        return next;
      });
      if (nowConnected.length > 0) {
        setConnectedOrgs(prev => Array.from(new Set([...prev, ...nowConnected])));
      }
    } finally {
      setChecking(false);
    }
  };

  const { openInstallPopup } = useGitHubAppInstallPopup(githubAppName, confirmInstalls);

  // Only outcomes for orgs still listed as needing the app are worth showing;
  // a connected org has already left the list, and saying so twice is noise.
  const outstandingResults = orgsNeedingInstall
    .map(login => ({ login, result: checkResults[login] }))
    .filter((o): o is { login: string; result: InstallCheckResult } => Boolean(o.result));

  const goToDestination = () => {
    if (destinationSlug) {
      navigate(`/admin/${destinationSlug}/dashboard`);
    } else {
      navigate('/select-organization');
    }
  };

  return (
    <div>
      <p className="text-sm text-gray-600 dark:text-gray-300 mb-4">
        Importing from GitHub Classroom. This pulls each classroom&apos;s assignments, roster, and
        grades, then sets them up in Classmoji. You can leave this page; the import keeps running.
      </p>

      {error && (
        <Alert
          className="mb-4"
          type="error"
          showIcon
          message="Couldn't load live progress"
          description={error.message}
        />
      )}

      <Progress
        percent={percent}
        status={allDone && failed.length > 0 ? 'exception' : allDone ? 'success' : 'active'}
      />

      <div className="space-y-2 mt-4">
        {importRuns.length === 0 && (
          <div className="flex items-center gap-2 text-gray-500">
            <Spin size="small" /> Starting import…
          </div>
        )}
        {importRuns.map(run => {
          const isDone = run.status === 'COMPLETED';
          const isFailed = ['FAILED', 'CRASHED', 'SYSTEM FAILURE', 'TIMED OUT'].includes(
            run.status
          );
          const out = run.output;
          return (
            <div
              key={run.id}
              className="rounded-xl ring-1 ring-stone-200 dark:ring-neutral-800 p-3"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium dark:text-gray-100">
                  {run.payload?.name ?? 'Classroom'}
                </span>
                <Tag
                  icon={isDone ? <CheckCircleFilled /> : isFailed ? <WarningFilled /> : undefined}
                  color={isDone ? 'success' : isFailed ? 'error' : 'processing'}
                >
                  {run.status}
                </Tag>
              </div>

              {isDone && out && (
                <div className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                  {out.studentsEnrolled ?? 0} students · {out.assignmentsImported ?? 0} assignments
                  · {out.reposLinked ?? 0} repos
                  {out.gradesRecorded ? ` · ${out.gradesRecorded} grades` : ''}
                </div>
              )}

              {isDone && out?.warnings && out.warnings.length > 0 && (
                <ul className="list-disc ml-5 mt-1 text-xs text-amber-600 dark:text-amber-400">
                  {out.warnings.slice(0, 6).map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              )}

              {isFailed && (
                <div className="text-xs text-red-500 mt-1">
                  {run.error?.message ?? 'Import failed for this classroom.'}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {allDone && (
        <div className="mt-6 flex flex-col gap-3">
          <div className="flex flex-col items-stretch gap-3 sm:flex-row sm:items-center sm:justify-end">
            {needsInstall && (
              <span className="text-xs text-gray-500 dark:text-gray-400 sm:mr-auto">
                The Classmoji GitHub App isn&apos;t installed on{' '}
                <span className="font-medium text-gray-700 dark:text-gray-200">
                  {orgsNeedingInstall.join(', ')}
                </span>
                , so repository syncing and grading stay off until you connect it.
              </span>
            )}
            <div className="flex justify-end gap-3">
              {needsInstall && (
                <Button onClick={openInstallPopup} loading={checking} disabled={checking}>
                  Connect GitHub
                </Button>
              )}
              <Button type="primary" onClick={goToDestination}>
                {destinationSlug ? 'Go to classroom' : 'Done'}
              </Button>
            </div>
          </div>

          {/* What the post-popup check found, in the banner's own words, for
              every org that is still not connected. */}
          {needsInstall && outstandingResults.length > 0 && (
            <div role="status" aria-live="polite" className="flex flex-col gap-1 sm:items-end">
              {outstandingResults.map(({ login, result }) => {
                const { tone, text } = describeInstallCheck(result, login);
                return (
                  <span key={login} className={`text-xs ${installCheckToneClass(tone)}`}>
                    {text}
                  </span>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
