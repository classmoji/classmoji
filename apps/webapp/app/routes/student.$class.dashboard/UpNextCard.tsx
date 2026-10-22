import { Link } from 'react-router';
import dayjs from 'dayjs';
import { useHydrated } from 'remix-utils/use-hydrated';
import { IconArrowRight } from '@tabler/icons-react';
import { IconGithub } from '@classmoji/ui-components';
import { GitlabLogo } from '~/components/ui/display/GitlabLogo';
import { useGitWeb } from '~/hooks/useGitWeb';
import type { StudentCourseworkRow } from '@classmoji/services';
import { CourseworkTypeTag } from '~/components/features/assignments/CourseworkTags';
import CourseworkMaterials, {
  type CourseworkMaterial,
} from '~/components/features/assignments/CourseworkMaterials';
import { useStartQuiz } from '~/components/features/quiz/useStartQuiz';

/**
 * An Up next row: a coursework row without the repo details the card never
 * shows, with the pages and decks linked to its assignment. `extensionHours`
 * is what the student bought on a repo or a quiz.
 */
/** A coursework row as the card receives it: no repo details and no quiz percentage (`score`). */
export type UpNextRow = Omit<StudentCourseworkRow, 'repo' | 'score'> & {
  materials: CourseworkMaterial[];
};

/**
 * A repository row, shown instead of coursework in a class with no published
 * assignment: the student's copy, or a self-formed repository they still have
 * to join a team for (`joinHref`).
 */
export interface DashboardRepoRow {
  id: string;
  title: string;
  name: string | null;
  url: string | null;
  lastPushAt: string | null;
  joinHref: string | null;
  createdAt: string;
}

interface UpNextCardProps {
  /** What the student still owes, soonest due first (studentCoursework.upNext). */
  rows: UpNextRow[];
  classSlug: string;
  /**
   * Staff previewing this dashboard start a quiz from the quiz list, which
   * asks them for a repository to preview a code-aware quiz against.
   */
  viewerIsStudent: boolean;
  /** No published assignment in the class: no "All assignments" link to an empty page. */
  hasAssignments?: boolean;
  /** Set for a class with no published assignment: the card lists these instead. */
  repositories?: DashboardRepoRow[] | null;
}

/**
 * The due date as the student reads it, in their own time zone. Overdue and
 * due-within-a-day dates are the ones to notice.
 */
export const formatDue = (deadline: string, now = dayjs(), extensionHours = 0) => {
  const due = dayjs(deadline);
  const days = due.startOf('day').diff(now.startOf('day'), 'day');
  // Past the deadline but inside the hours the student bought: not overdue.
  // The date stays the assignment's own; the hours applied are said with it.
  if (due.isBefore(now) && extensionHours > 0 && !due.add(extensionHours, 'hour').isBefore(now)) {
    return { text: `${due.format('MMM D')} · +${extensionHours}h applied`, urgent: true };
  }
  if (due.isBefore(now)) return { text: `Overdue · ${due.format('MMM D')}`, urgent: true };
  if (days === 0) return { text: `Today, ${due.format('h:mm A')}`, urgent: true };
  if (days === 1) return { text: `Tomorrow, ${due.format('h:mm A')}`, urgent: true };
  return { text: due.format('ddd MMM D, h:mm A'), urgent: false };
};

const ACTION_LABEL: Record<string, string> = {
  START_QUIZ: 'Start quiz',
  RESUME_QUIZ: 'Resume',
  OPEN: 'Open',
  FILL_OUT: 'Fill out',
};

const primaryButton =
  'inline-flex items-center justify-center whitespace-nowrap text-xs font-semibold px-3 py-1.5 rounded-lg bg-accent text-white! hover:bg-accent-hover transition-colors disabled:opacity-60';
const secondaryButton =
  'inline-flex items-center justify-center whitespace-nowrap text-xs font-semibold px-3 py-1.5 rounded-lg ring-1 ring-line-2 text-ink-1! hover:bg-nav-hover transition-colors';

const UpNextCard = ({
  rows,
  classSlug,
  viewerIsStudent,
  hasAssignments = true,
  repositories = null,
}: UpNextCardProps) => {
  const hydrated = useHydrated();
  const { startQuiz, resumeQuiz, startingQuizId } = useStartQuiz(classSlug);

  if (repositories) {
    return <RepositoriesCard rows={repositories} classSlug={classSlug} hydrated={hydrated} />;
  }

  const actionFor = (row: UpNextRow) => {
    const action = row.action;
    if (!action) return null;
    const label = ACTION_LABEL[action.kind];
    switch (action.kind) {
      case 'START_QUIZ':
        return viewerIsStudent ? (
          <button
            type="button"
            className={primaryButton}
            disabled={startingQuizId === action.quizId}
            onClick={() => startQuiz(action.quizId)}
          >
            {label}
          </button>
        ) : (
          <Link
            to={row.href ?? '#'}
            className="btn btn-sm btn-primary text-white! hover:text-white!"
          >
            {label}
          </Link>
        );
      case 'RESUME_QUIZ':
        return (
          <button
            type="button"
            className={primaryButton}
            onClick={() => resumeQuiz(action.quizId, action.attemptId)}
          >
            {label}
          </button>
        );
      case 'OPEN':
      case 'FILL_OUT':
        return (
          <a href={action.href} target="_blank" rel="noreferrer" className={secondaryButton}>
            {label}
          </a>
        );
      default:
        return null;
    }
  };

  return (
    <section
      data-tour="dashboard-spotlight"
      className="rounded-2xl bg-panel ring-1 ring-line p-5 sm:p-6 h-full flex flex-col"
    >
      <h2 className="text-xs font-semibold tracking-[0.18em] text-ink-4">UP NEXT</h2>

      {rows.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center text-center py-10">
          <div className="text-sm font-medium text-ink-1">Nothing due</div>
          <div className="text-sm text-ink-3">You’re all caught up.</div>
        </div>
      ) : (
        <ul className="mt-3 flex-1 flex flex-col">
          {rows.map(row => {
            const due =
              row.deadline && hydrated
                ? formatDue(row.deadline, undefined, row.extensionHours)
                : null;
            return (
              <li
                key={row.assignmentId}
                className="flex flex-wrap items-center gap-x-3 gap-y-1.5 py-2.5 border-b border-line/60 last:border-0"
              >
                <CourseworkTypeTag type={row.type} />
                {/* A real minimum width: on a narrow card the due date and the
                    button wrap onto a second line rather than squeeze the title. */}
                <div className="flex-1 min-w-[9rem]">
                  <div className="text-sm font-semibold text-ink-0 truncate">{row.title}</div>
                  <div className="text-xs text-ink-3 truncate">{row.module.title}</div>
                  <CourseworkMaterials materials={row.materials} />
                </div>
                <span
                  className={`text-xs whitespace-nowrap tabular-nums ${
                    due?.urgent ? 'font-semibold text-amber-ink' : 'text-ink-2'
                  }`}
                >
                  {due?.text ?? ''}
                </span>
                <div className="shrink-0 ml-auto">{actionFor(row)}</div>
              </li>
            );
          })}
        </ul>
      )}

      {hasAssignments && (
        <Link
          to={`/student/${classSlug}/assignments`}
          className="mt-3 self-start inline-flex items-center gap-1.5 text-xs font-semibold text-accent-ink! hover:underline underline-offset-2"
        >
          All assignments
          <IconArrowRight size={12} />
        </Link>
      )}
    </section>
  );
};

const RepositoriesCard = ({
  rows,
  classSlug,
  hydrated,
}: {
  rows: DashboardRepoRow[];
  classSlug: string;
  hydrated: boolean;
}) => {
  const web = useGitWeb();
  return (
    <section
      data-tour="dashboard-spotlight"
      className="rounded-2xl bg-panel ring-1 ring-line p-5 sm:p-6 h-full flex flex-col"
    >
      <h2 className="text-xs font-semibold tracking-[0.18em] text-ink-4">
        {web.terms.Repos.toUpperCase()}
      </h2>

      {rows.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center text-center py-10">
          <div className="text-sm font-medium text-ink-1">No {web.terms.repos} yet</div>
          <div className="text-sm text-ink-3">
            {web.terms.Repos} your instructor creates for you or your team show up here.
          </div>
        </div>
      ) : (
        <ul className="mt-3 flex-1 flex flex-col">
          {rows.map(row => (
            <li
              key={row.id}
              className="flex flex-wrap items-center gap-x-3 gap-y-1.5 py-2.5 border-b border-line/60 last:border-0"
            >
              <span className="shrink-0 inline-flex text-gray-900 dark:text-gray-100">
                {web.isGitLab ? <GitlabLogo size={16} /> : <IconGithub size={16} />}
              </span>
              <div className="flex-1 min-w-[9rem]">
                <div className="text-sm font-semibold text-ink-0 truncate">{row.title}</div>
                <div className="text-xs text-ink-3 truncate">{row.name ?? 'No team yet'}</div>
              </div>
              {row.name && (
                <span className="text-xs whitespace-nowrap text-ink-2">
                  {row.lastPushAt
                    ? hydrated
                      ? `Pushed ${dayjs(row.lastPushAt).fromNow()}`
                      : ''
                    : 'No push yet'}
                </span>
              )}
              <div className="shrink-0 ml-auto">
                {row.joinHref ? (
                  // The shared .btn: on a link, the utility background lost to
                  // the global anchor reset and the button rendered blank.
                  <Link
                    to={row.joinHref}
                    className="btn btn-sm btn-primary text-white! hover:text-white!"
                  >
                    Join a team
                  </Link>
                ) : row.url ? (
                  <a href={row.url} target="_blank" rel="noreferrer" className={secondaryButton}>
                    Open
                  </a>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}

      <Link
        to={`/student/${classSlug}/repos`}
        className="mt-3 self-start inline-flex items-center gap-1.5 text-xs font-semibold text-accent-ink! hover:underline underline-offset-2"
      >
        All {web.terms.repos}
        <IconArrowRight size={12} />
      </Link>
    </section>
  );
};

export default UpNextCard;
