import { useNavigate } from 'react-router';
import { TriggerAuthContext, useRealtimeRunsWithTag } from '@trigger.dev/react-hooks';
import { Progress, Tag, Button, Alert, Spin } from 'antd';
import { CheckCircleFilled, WarningFilled } from '@ant-design/icons';

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
  singleSlug: string | null;
}

/**
 * Step 4 — live import progress. Subscribes to the session's Trigger.dev runs
 * (one per classroom) and shows per-classroom status, counts, and warnings. When
 * everything finishes, offers a button to the new classroom (single import) or
 * back to the org picker (multiple).
 */
export default function StepProgress({ accessToken, sessionId, expected, singleSlug }: Props) {
  return (
    <TriggerAuthContext.Provider value={{ accessToken }}>
      <ProgressInner sessionId={sessionId} expected={expected} singleSlug={singleSlug} />
    </TriggerAuthContext.Provider>
  );
}

function ProgressInner({ sessionId, expected, singleSlug }: Omit<Props, 'accessToken'>) {
  const navigate = useNavigate();
  const { runs, error } = useRealtimeRunsWithTag(`session_${sessionId}`);

  const importRuns = (runs as unknown as RunLike[]).filter(r => r.taskIdentifier === TASK_ID);
  const terminal = importRuns.filter(r => TERMINAL.has(r.status));
  const failed = importRuns.filter(r =>
    ['FAILED', 'CRASHED', 'SYSTEM FAILURE', 'TIMED OUT'].includes(r.status)
  );
  const succeeded = importRuns.filter(r => r.status === 'COMPLETED');

  const allDone = terminal.length >= expected && importRuns.length >= expected;
  const percent = Math.min(100, Math.floor((terminal.length / Math.max(1, expected)) * 100));

  const goToDestination = () => {
    if (singleSlug && succeeded.length > 0) {
      const slug = succeeded[0].output?.classroomSlug ?? singleSlug;
      navigate(`/admin/${slug}/dashboard`);
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
        <div className="mt-6 flex justify-end">
          <Button type="primary" onClick={goToDestination}>
            {singleSlug && succeeded.length > 0 ? 'Go to classroom' : 'Done'}
          </Button>
        </div>
      )}
    </div>
  );
}
