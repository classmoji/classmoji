import { Popconfirm, Tooltip } from 'antd';
import { IconCheck } from '@tabler/icons-react';
import { useFetcher } from 'react-router';

interface FinalGradesControlProps {
  /** Whether students currently see their final grade. */
  released: boolean;
  /** Owner only: the action refuses everyone else. */
  canRelease: boolean;
  /**
   * The gradebook's breakpoints differ from the saved ones: the Letter column
   * is not what students would get, so Release waits (Hide does not).
   */
  breakpointsEdited?: boolean;
  /** This gradebook's own URL, the action's target. */
  actionPath: string;
}

/**
 * The gradebook's final-grade release: a state chip for the teaching staff and,
 * for the owner, the button that releases (or hides) every student's final
 * grade at once, behind a confirmation.
 */
const FinalGradesControl = ({
  released,
  canRelease,
  breakpointsEdited = false,
  actionPath,
}: FinalGradesControlProps) => {
  const fetcher = useFetcher<{ success?: boolean; error?: string }>();
  // Shown as the outcome while the write is in flight.
  const pending = fetcher.json as { final_grades_released?: boolean } | undefined;
  const shownReleased =
    fetcher.state !== 'idle' && typeof pending?.final_grades_released === 'boolean'
      ? pending.final_grades_released
      : released;

  const submit = (next: boolean) =>
    fetcher.submit(
      { intent: 'set-final-grades-released', final_grades_released: next },
      { method: 'post', action: actionPath, encType: 'application/json' }
    );

  if (!canRelease && !shownReleased) return null;
  const releaseBlocked = !shownReleased && breakpointsEdited;

  return (
    <div className="flex items-center gap-2 shrink-0">
      {shownReleased && (
        <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium whitespace-nowrap bg-green-50 text-green-700 dark:bg-green-950/40 dark:text-green-300">
          <IconCheck size={14} />
          Final grades released
        </span>
      )}
      {canRelease && (
        <Tooltip
          title={
            releaseBlocked
              ? "Breakpoints changed here aren't saved. Reload to release."
              : undefined
          }
        >
          {/* A disabled button fires no mouse events: the span carries the tooltip. */}
          <span className="inline-flex">
            <Popconfirm
              disabled={releaseBlocked}
              title={shownReleased ? 'Hide final grades?' : 'Release final grades?'}
              description={
                shownReleased
                  ? 'Students stop seeing a final grade.'
                  : 'Every student sees their letter from the Letter column as their final grade.'
              }
              onConfirm={() => submit(!shownReleased)}
              okText={shownReleased ? 'Hide' : 'Release'}
              cancelText="Cancel"
              placement="bottomRight"
            >
              <button
                type="button"
                disabled={fetcher.state !== 'idle' || releaseBlocked}
                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-sm font-medium whitespace-nowrap text-gray-600 hover:text-gray-900 dark:text-gray-300 dark:hover:text-gray-100 ring-1 ring-line hover:bg-nav-hover transition-colors disabled:opacity-60 disabled:pointer-events-none"
              >
                {shownReleased ? 'Hide final grades' : 'Release final grades'}
              </button>
            </Popconfirm>
          </span>
        </Tooltip>
      )}
      {fetcher.state === 'idle' && fetcher.data?.error && (
        <span className="text-xs text-red-600 dark:text-red-400">{fetcher.data.error}</span>
      )}
    </div>
  );
};

export default FinalGradesControl;
