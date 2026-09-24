import { App, Button, Checkbox, Dropdown, Popover, Table, Tooltip } from 'antd';
import type { MenuProps } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import dayjs from 'dayjs';
import {
  IconBrandGithub,
  IconDotsVertical,
  IconLayoutKanban,
  IconShieldFilled,
  IconShieldPlus,
} from '@tabler/icons-react';
import {
  UserThumbnailView,
  TeamThumbnailView,
  RepositoryAssignmentStatus,
  EmojiGrader,
} from '~/components';
import { ActionTypes } from '~/constants';
import { useCallout } from '@classmoji/ui-components';
import { useGlobalFetcher } from '~/hooks';
import useStore from '~/store';
import { openRepositoryAssignmentInGithub } from '~/utils/helpers.client';
import type { AssignmentRowData } from '~/components/features/assignments/AssignmentsTable';
import ImportedBadge from './ImportedBadge';
import GradeBadges from '~/components/features/grading/GradeBadges';
import { CommitCount } from '~/components/features/analytics';

/** The sha of the newest commit in a snapshot's list, by timestamp; null when unknown. */
const latestCommitSha = (commits: unknown): string | null => {
  if (!Array.isArray(commits)) return null;
  let best: { sha: string; t: number } | null = null;
  for (const c of commits as Array<{ sha?: unknown; ts?: unknown }>) {
    if (typeof c?.sha !== 'string') continue;
    const t = new Date(String(c.ts ?? '')).getTime();
    if (!best || (Number.isFinite(t) && t > best.t))
      best = { sha: c.sha, t: Number.isFinite(t) ? t : -1 };
  }
  return best?.sha ?? null;
};
import AutogradingResultPill from '~/components/features/AutogradingResultPill';
import { type AutogradingResultData } from '~/components/features/AutogradingResultCard';

interface AssignmentGrade {
  emoji: string;
  [key: string]: unknown;
}

interface AssignmentGraderRef {
  grader: { id: string; login: string | null; name: string | null; [key: string]: unknown };
  [key: string]: unknown;
}

/** This assignment's submission row on one student repo. */
export interface SubmissionRow {
  id: string;
  assignment_id: string;
  provider_issue_number: number | null;
  status?: string;
  closed_at?: string | Date | null;
  num_late_hours?: number;
  extension_hours?: number;
  is_late?: boolean;
  is_late_override?: boolean;
  grades?: AssignmentGrade[];
  graders?: AssignmentGraderRef[];
  analytics_snapshot?: {
    last_commit_at?: string | Date | null;
    total_commits?: number | null;
    fetched_at?: string | Date | null;
    /** The snapshot's commit list ({ sha, ts, … }), newest not guaranteed first. */
    commits?: unknown;
  } | null;
  repository?: { name: string; [key: string]: unknown } | null;
  assignment: { weight: number; submission_mode?: string; [key: string]: unknown };
  studentId?: string | null;
  teamId?: string | null;
  [key: string]: unknown;
}

export interface SubmissionsRepo {
  last_push_at?: string | Date | null;
  id: string;
  name: string;
  student_id: string | null;
  team_id: string | null;
  student?: {
    avatar_url?: string | null;
    name?: string | null;
    login?: string | null;
    slug?: string | null;
    [key: string]: unknown;
  } | null;
  team?: { avatar_url: string; name: string; slug: string; [key: string]: unknown } | null;
  submission: SubmissionRow | null;
  project_number?: number | null;
  metadata?: unknown;
  autograding_result?: AutogradingResultData | null;
  [key: string]: unknown;
}

interface Assistant {
  id: string;
  login: string | null;
  name: string | null;
  [key: string]: unknown;
}

export type SubmissionFilter = 'all' | 'ungraded' | 'late' | 'missing';

/** Whether a row passes the toolbar filter. Exported so the page can count. */
export const matchesFilter = (repo: SubmissionsRepo, filter: SubmissionFilter) => {
  const s = repo.submission;
  switch (filter) {
    case 'ungraded':
      return s?.status === 'CLOSED' && (s.grades?.length ?? 0) === 0;
    case 'late':
      return Boolean(s?.is_late) && !s?.is_late_override;
    case 'missing':
      return !s || s.status !== 'CLOSED';
    default:
      return true;
  }
};

interface SubmissionsTableProps {
  repositoryType: string;
  /** Whether the repository has autograding tests; without them the column is noise. */
  autogradingEnabled?: boolean;
  assignment: AssignmentRowData;
  repos: SubmissionsRepo[];
  assistants: Assistant[];
  emojiMappings: Record<string, unknown>;
  org: string;
  canManageGraders: boolean;
  /** Unfiltered row count, for the footer. */
  total: number;
}

/**
 * The roster for one assignment: every student (or team) repo once, with this
 * assignment's submission state, graders and grade.
 */
const SubmissionsTable = ({
  repositoryType,
  autogradingEnabled = false,
  assignment,
  repos,
  assistants,
  emojiMappings,
  org,
  canManageGraders,
  total,
}: SubmissionsTableProps) => {
  const { fetcher, notify } = useGlobalFetcher();
  const { modal } = App.useApp();
  const { classroom } = useStore();
  const callout = useCallout();

  const isIndividual = repositoryType === 'INDIVIDUAL';
  const isPushMode = assignment.submission_mode === 'REPO';
  const grader = (s: SubmissionRow) => (
    <EmojiGrader
      repositoryAssignment={s as Parameters<typeof EmojiGrader>[0]['repositoryAssignment']}
      emojiMappings={emojiMappings}
    />
  );
  // Only surface the "Imported" column when at least one repo carries imported data.
  const anyImported = repos.some(r => r.metadata != null && typeof r.metadata === 'object');

  // The newest push this repo has seen: the webhook's stamp on the repo first
  // (a push after the deadline does not move a frozen submission, so the
  // submission time alone would hide it), then the commit stats, then a
  // push-mode submission time as the last resort.
  const lastPush = (repo: SubmissionsRepo) => {
    const s = repo.submission;
    const candidates = [
      repo.last_push_at,
      s?.analytics_snapshot?.last_commit_at,
      isPushMode ? s?.closed_at : null,
    ];
    let latest: number | null = null;
    for (const at of candidates) {
      if (!at) continue;
      const t = new Date(at).getTime();
      if (latest === null || t > latest) latest = t;
    }
    return latest === null ? null : new Date(latest);
  };

  const graderHandler = (
    graderLogin: string,
    record: SubmissionsRepo,
    action: 'ADD' | 'REMOVE'
  ) => {
    const submission = record.submission;
    if (!submission) return;

    // Resolve the grader's id without assuming the pool holds them. On a REMOVAL
    // the authority is the row's own grader list: someone already assigned may
    // no longer be selectable. On an ADD it is the pool the options came from.
    const graderId =
      submission.graders?.find(g => g.grader.login === graderLogin)?.grader.id ??
      assistants.find(a => a.login === graderLogin)?.id;
    if (!graderId) {
      callout.show({ variant: 'error', title: `Could not resolve the grader ${graderLogin}` });
      return;
    }

    const isAddingGrader = action === 'ADD';
    notify(
      isAddingGrader ? ActionTypes.ADD_GRADER : ActionTypes.REMOVE_GRADER,
      isAddingGrader ? 'Adding grader...' : 'Removing grader...'
    );
    fetcher!.submit(
      {
        repoName: record.name,
        githubIssueNumber: submission.provider_issue_number,
        repoAssignmentId: submission.id,
        graderId,
        graderLogin,
      },
      {
        method: isAddingGrader ? 'post' : 'delete',
        action: isAddingGrader ? '?/addGrader' : '?/removeGrader',
        encType: 'application/json',
      }
    );
  };

  const columns: ColumnsType<SubmissionsRepo> = [
    {
      title: isIndividual ? 'Student' : 'Team',
      key: 'member',
      fixed: 'left',
      width: 230,
      render: (_: unknown, repo) =>
        isIndividual ? (
          repo.student ? (
            <UserThumbnailView user={repo.student} />
          ) : (
            <span className="text-sm text-ink-3">No student</span>
          )
        ) : repo.team ? (
          <TeamThumbnailView team={repo.team} />
        ) : (
          <span className="text-sm text-ink-3">No team</span>
        ),
    },
    {
      title: 'Repository',
      key: 'repo',
      width: 240,
      render: (_: unknown, repo) => {
        const projectUrl = repo.project_number
          ? `https://github.com/orgs/${org}/projects/${repo.project_number}`
          : null;
        return (
          <div className="flex items-center gap-1 min-w-0">
            <a
              href={`https://github.com/${org}/${repo.name}`}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 min-w-0 text-ink-1 hover:underline underline-offset-2"
            >
              <IconBrandGithub size={14} className="shrink-0 text-gray-400" />
              <span className="truncate">{repo.name}</span>
            </a>
            {projectUrl && (
              <Tooltip title="Open Project">
                <Button
                  type="text"
                  size="small"
                  icon={<IconLayoutKanban size={16} className="text-gray-600 dark:text-gray-300" />}
                  href={projectUrl}
                  target="_blank"
                />
              </Tooltip>
            )}
          </div>
        );
      },
    },
    {
      title: 'Commits',
      key: 'commits',
      width: 100,
      align: 'right' as const,
      render: (_: unknown, repo) => {
        const snapshot = repo.submission?.analytics_snapshot;
        const n = snapshot?.total_commits;
        if (n === null || n === undefined) return <span className="text-ink-3">—</span>;
        const sha = latestCommitSha(snapshot?.commits);
        const href = sha
          ? `https://github.com/${org}/${repo.name}/commit/${sha}`
          : `https://github.com/${org}/${repo.name}/commits`;
        return <CommitCount snapshot={snapshot} href={href} size="lg" className="text-sm!" />;
      },
    },
    {
      title: 'Last push',
      key: 'lastPush',
      width: 150,
      render: (_: unknown, repo) => {
        const at = lastPush(repo);
        return at ? (
          <span className="text-ink-2">{dayjs(at).format('MMM D, h:mm A')}</span>
        ) : (
          <span className="text-ink-3">No push yet</span>
        );
      },
    },
    ...(autogradingEnabled
      ? [
          {
            title: 'Autograding',
            key: 'autograding',
            width: 130,
            render: (_: unknown, repo: SubmissionsRepo) => (
              <AutogradingResultPill
                result={repo.autograding_result}
                org={org}
                repoName={repo.name}
              />
            ),
          },
        ]
      : []),
    ...(anyImported
      ? [
          {
            title: 'Imported',
            key: 'imported',
            width: 140,
            render: (_: unknown, repo: SubmissionsRepo) => (
              <ImportedBadge metadata={repo.metadata} />
            ),
          },
        ]
      : []),
    {
      title: 'Submission',
      key: 'submission',
      width: 160,
      className: 'border-l border-line',
      render: (_: unknown, repo) =>
        repo.submission ? (
          <RepositoryAssignmentStatus repositoryAssignment={repo.submission} />
        ) : (
          <Tooltip title="Sync the repository from the Repositories page to create this student's submission row">
            <span className="text-sm text-ink-3">Not released</span>
          </Tooltip>
        ),
    },
    {
      title: 'Graders',
      key: 'graders',
      width: 200,
      render: (_: unknown, repo) => {
        const s = repo.submission;
        if (!s) return null;
        const names = (s.graders ?? []).map(g => g.grader.name || g.grader.login).join(', ');
        if (!canManageGraders) return <span className="text-sm text-ink-2">{names || '—'}</span>;
        // The names as text; one click on the link opens the checkbox list.
        const assigned = new Set(
          (s.graders ?? []).map(g => g.grader.login).filter((v): v is string => v != null)
        );
        const choices = assistants
          .map(a => ({ label: a.name || a.login || '', value: a.login || '' }))
          .sort((a, b) => a.label.localeCompare(b.label));
        return (
          <div className="flex items-center gap-3 whitespace-nowrap">
            {names && <span className="text-sm text-ink-1 truncate max-w-40">{names}</span>}
            <Popover
              trigger="click"
              placement="bottomLeft"
              content={
                <div className="flex flex-col gap-2 min-w-44 py-1">
                  {choices.length === 0 && (
                    <span className="text-sm text-ink-3">No graders on the staff yet</span>
                  )}
                  {choices.map(c => (
                    <Checkbox
                      key={c.value}
                      checked={assigned.has(c.value)}
                      onChange={e =>
                        graderHandler(c.value, repo, e.target.checked ? 'ADD' : 'REMOVE')
                      }
                    >
                      {c.label}
                    </Checkbox>
                  ))}
                </div>
              }
            >
              <button
                type="button"
                className="text-sm font-medium text-ink-2 hover:text-ink-1 hover:underline underline-offset-2"
              >
                {names ? 'Change' : 'Assign'}
              </button>
            </Popover>
          </div>
        );
      },
    },
    {
      title: 'Grade',
      key: 'grade',
      width: 220,
      render: (_: unknown, repo) => {
        const s = repo.submission;
        if (!s) return null;
        s.repository = repo;
        s.studentId = repo.student_id;
        s.teamId = repo.team_id;
        return (
          <div className="flex items-center gap-4">
            <GradeBadges grades={s.grades} emojiMappings={emojiMappings} />
          </div>
        );
      },
    },
    {
      title: 'Actions',
      key: 'actions',
      width: 200,
      className: 'border-l border-line',
      render: (_: unknown, repo) => {
        const s = repo.submission;
        if (!s) return null;
        const late = Boolean(s.is_late);
        const waived = Boolean(s.is_late_override);
        const rare: MenuProps['items'] = [];
        if (late || waived) {
          rare.push({
            key: 'late',
            label: waived ? 'Restore late penalty' : 'Waive late penalty',
            icon: waived ? <IconShieldFilled size={15} /> : <IconShieldPlus size={15} />,
          });
        }
        const onRare: MenuProps['onClick'] = ({ key }) => {
          if (key === 'late') {
            notify(
              ActionTypes.UPDATE_LATE_OVERRIDE,
              waived ? 'Restoring late penalty' : 'Waiving late penalty'
            );
            fetcher!.submit(
              { git_repo_assignment_id: s.id, is_late_override: !waived },
              {
                method: 'post',
                action: `/api/gitRepoAssignment/${classroom?.slug}?action=updateLateOverride`,
                encType: 'application/json',
              }
            );
          }
        };
        const link =
          'text-sm font-medium text-ink-2 hover:text-ink-1 hover:underline underline-offset-2 whitespace-nowrap';
        return (
          <div className="flex items-center gap-4 whitespace-nowrap">
            {grader(s)}
            <button
              type="button"
              className={link}
              onClick={() =>
                // The row IS the git repo; hand the helper its name explicitly.
                openRepositoryAssignmentInGithub(org, {
                  git_repo: { name: repo.name },
                  provider_issue_number: s.provider_issue_number,
                })
              }
            >
              View
            </button>
            <button
              type="button"
              className="text-sm font-medium text-rose-600 hover:text-rose-700 dark:text-rose-400 hover:underline underline-offset-2 whitespace-nowrap"
              onClick={() =>
                (() => {
                  // Read straight off the box at confirm time: modal.confirm
                  // renders its content once and does not re-render on state.
                  const alsoRepo = { current: false };
                  modal.confirm({
                    title: 'Delete submission',
                    content: (
                      <div className="flex flex-col gap-3">
                        <span>
                          This removes <strong>{repo.name}</strong> from this assignment, along with
                          its grades.
                        </span>
                        <Checkbox
                          onChange={e => {
                            alsoRepo.current = e.target.checked;
                          }}
                        >
                          Also delete the GitHub repository
                          <span className="block text-xs text-ink-3">
                            Permanent, and removes every other assignment&rsquo;s submission on this
                            repository.
                          </span>
                        </Checkbox>
                      </div>
                    ),
                    okText: 'Delete',
                    okButtonProps: { danger: true },
                    cancelText: 'Cancel',
                    onOk: () => {
                      notify(ActionTypes.DELETE_GIT_REPO_ASSIGNMENT, 'Deleting submission…');
                      fetcher!.submit(
                        { git_repo_assignment_id: s.id, delete_repository: alsoRepo.current },
                        {
                          method: 'post',
                          action: `/api/gitRepoAssignment/${classroom?.slug}?action=deleteSubmission`,
                          encType: 'application/json',
                        }
                      );
                    },
                  });
                })()
              }
            >
              Delete
            </button>
            {rare.length > 0 && (
              <Dropdown
                trigger={['click']}
                placement="bottomRight"
                menu={{ items: rare, onClick: onRare }}
              >
                <button
                  type="button"
                  aria-label="More actions"
                  className="inline-flex h-7 w-7 items-center justify-center rounded-md text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-neutral-800 dark:hover:text-gray-200"
                >
                  <IconDotsVertical size={17} />
                </button>
              </Dropdown>
            )}
          </div>
        );
      },
    },
  ];

  return (
    <Table<SubmissionsRepo>
      dataSource={repos}
      rowKey="id"
      columns={columns}
      rowHoverable={false}
      scroll={{ x: 'max-content' }}
      pagination={{ pageSize: 100, hideOnSinglePage: true }}
      footer={() => (
        <span className="text-xs text-ink-3">
          Showing {repos.length} of {total} {isIndividual ? 'students' : 'teams'}
        </span>
      )}
      locale={{
        emptyText: (
          <div className="text-center py-12 text-gray-500">
            <div className="font-medium">
              {total === 0 ? 'No student repositories yet' : 'Nothing matches this filter'}
            </div>
            <div className="text-sm">
              {total === 0
                ? 'Publish the repository to create one per student.'
                : 'Pick another filter or clear the search.'}
            </div>
          </div>
        ),
      }}
    />
  );
};

export default SubmissionsTable;
