import { App, Button, Checkbox, Popover, Table, Tooltip } from 'antd';
import { useGitWeb } from '~/hooks/useGitWeb';
import type { ColumnsType } from 'antd/es/table';
import dayjs from 'dayjs';
import { IconBrandGithub, IconLayoutKanban } from '@tabler/icons-react';
import {
  UserThumbnailView,
  TeamThumbnailView,
  RepositoryAssignmentStatus,
  EmojisDisplay,
  EmojiGrader,
  LateOverrideButton,
} from '~/components';
import { ActionTypes } from '~/constants';
import { CommitCount } from '~/components/features/analytics';
import { useCallout } from '@classmoji/ui-components';
import { useGlobalFetcher } from '~/hooks';
import ImportedBadge from './ImportedBadge';
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

/** An assignment that submits through this repository. */
export interface SubmissionsAssignment {
  id: string;
  title: string;
  submission_mode?: 'ISSUE' | 'REPO' | string;
}

interface RepoAssignmentEntry {
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
    commits?: unknown;
  } | null;
  repository?: { name: string; [key: string]: unknown } | null;
  assignment: { weight: number; submission_mode?: string; [key: string]: unknown };
  studentId?: string | null;
  teamId?: string | null;
  [key: string]: unknown;
}

export interface SubmissionsRepo {
  id: string;
  name: string;
  /** When the provider last reported a push, independent of any assignment. */
  last_push_at?: string | Date | null;
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
  assignments?: RepoAssignmentEntry[];
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

interface SubmissionsTableProps {
  repositoryType: string;
  assignments: SubmissionsAssignment[];
  repos: SubmissionsRepo[];
  assistants: Assistant[];
  emojiMappings: Record<string, unknown>;
  org: string;
  /**
   * False for an ASSISTANT. Deleting here destroys the GitHub repository and
   * every submission recorded against it, so it stays with the classroom's
   * owners. View is untouched.
   */
  canEdit?: boolean;
}

/**
 * The repository's student (or team) copies, one row each, with one column
 * group per assignment that submits through it: Submission, Graders, Grade.
 * A push-mode professor with one assignment reads it as a roster; an
 * issue-mode professor with five reads the same table five groups wide.
 */
const SubmissionsTable = ({
  repositoryType,
  assignments,
  repos,
  assistants,
  emojiMappings,
  org,
  canEdit = true,
}: SubmissionsTableProps) => {
  const web = useGitWeb();
  // Repo-only: a push IS the submission, so nothing here is about issues and
  // autograding (which runs off an issue workflow) has nothing to report.
  const isPushOnly = assignments.length > 0 && assignments.every(a => a.submission_mode === 'REPO');
  // With no assignment on this repository there are no submission rows, and
  // both autograding results and analytics snapshots hang off those — so these
  // columns could never fill in, however much students push.
  const hasAssignments = assignments.length > 0;
  const { fetcher, notify } = useGlobalFetcher();
  const { modal } = App.useApp();
  const callout = useCallout();

  const isIndividual = repositoryType === 'INDIVIDUAL';
  // Only surface the "Imported" column when at least one repo carries imported data.
  const anyImported = repos.some(r => r.metadata != null && typeof r.metadata === 'object');

  const rowFor = (repo: SubmissionsRepo, assignmentId: string) =>
    repo.assignments?.find(a => a.assignment_id === assignmentId);

  // The newest commit any submission row of this repo has seen. Until the
  // commit stats have been fetched, a push-mode row's submission time is the
  // push the webhook recorded, so it stands in. The repo's own `last_push_at`
  // is the fallback that works even with no assignments on it at all.
  const lastPush = (repo: SubmissionsRepo) => {
    let latest: number | null = repo.last_push_at ? new Date(repo.last_push_at).getTime() : null;
    for (const ra of repo.assignments ?? []) {
      const candidates = [
        ra.analytics_snapshot?.last_commit_at,
        ra.assignment?.submission_mode === 'REPO' ? ra.closed_at : null,
      ];
      for (const at of candidates) {
        if (!at) continue;
        const t = new Date(at).getTime();
        if (latest === null || t > latest) latest = t;
      }
    }
    return latest === null ? null : new Date(latest);
  };

  const graderHandler = (
    graderLogin: string,
    assignmentId: string,
    record: SubmissionsRepo,
    action: 'ADD' | 'REMOVE'
  ) => {
    const repoAssignment = rowFor(record, assignmentId);
    if (!repoAssignment) return;

    // Resolve the grader's id without assuming the pool holds them. On a REMOVAL
    // the authority is the assignment's own grader list: someone already
    // assigned may no longer be selectable (their grader flag was cleared since,
    // or they were assigned in bulk). On an ADD it is the pool the options came
    // from. Both actions need the id — it keys the membership row they write.
    const graderId =
      repoAssignment.graders?.find(g => g.grader.login === graderLogin)?.grader.id ??
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
        githubIssueNumber: repoAssignment.provider_issue_number,
        repoAssignmentId: repoAssignment.id,
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

  const fixedColumns: ColumnsType<SubmissionsRepo> = [
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
            <span className="text-sm text-ink-3">Invite pending</span>
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
        const projectUrl = repo.project_number ? web.project(repo.project_number) : null;
        return (
          <div className="flex items-center gap-1 min-w-0">
            <a
              href={web.repo(repo.name)}
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
      title: 'Last push',
      key: 'lastPush',
      width: 150,
      render: (_: unknown, repo) => {
        const at = lastPush(repo);
        return at ? (
          <span className="text-ink-2">{dayjs(at).format('MMM D, h:mm A')}</span>
        ) : (
          <span className="text-ink-3">—</span>
        );
      },
    },
    ...(!hasAssignments
      ? []
      : [
          {
            title: 'Commits',
            key: 'commits',
            width: 100,
            align: 'right' as const,
            render: (_: unknown, repo: SubmissionsRepo) => {
              // The snapshot hangs off the submission row, so take the first one this
              // repo has — every assignment on it shares the same git history.
              const snapshot = assignments
                .map(a => rowFor(repo, a.id)?.analytics_snapshot)
                .find(sn => sn?.total_commits != null);
              if (!snapshot) return <span className="text-ink-3">—</span>;
              return (
                <CommitCount
                  snapshot={snapshot}
                  href={web.commits(repo.name)}
                  size="lg"
                  className="text-sm!"
                />
              );
            },
          },
        ]),
    ...(isPushOnly || !hasAssignments
      ? []
      : [
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
        ]),
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
  ];

  // Row-level actions. A row IS one student's (or team's) git repo, so these
  // act on the repo itself, not on any single assignment's submission.
  const actionsColumn: ColumnsType<SubmissionsRepo>[number] = {
    title: 'Actions',
    key: 'actions',
    width: 140,
    fixed: 'right',
    className: 'border-l border-line',
    render: (_: unknown, repo: SubmissionsRepo) => {
      return (
        // Plain links rather than antd's link buttons: `ant-btn-link` paints
        // itself the theme's link colour, which is the brand green, so View
        // read as an affirmative action next to a destructive one.
        <div className="flex items-center gap-4 whitespace-nowrap">
          <a
            href={web.repo(repo.name)}
            target="_blank"
            rel="noreferrer"
            className="text-sm font-medium text-ink-2! hover:text-ink-1! hover:underline underline-offset-2"
          >
            View
          </a>
          {canEdit && (
            <button
              type="button"
              className="text-sm font-medium text-rose-600 hover:text-rose-700 dark:text-rose-400"
              onClick={() =>
                modal.confirm({
                  title: 'Delete repository',
                  content: `This permanently deletes ${repo.name} on GitHub and every submission recorded against it.`,
                  okText: 'Delete',
                  okButtonProps: { danger: true },
                  cancelText: 'Cancel',
                  onOk: () => {
                    notify(ActionTypes.DELETE_REPO, 'Deleting repository…');
                    fetcher!.submit(
                      { action: ActionTypes.DELETE_REPO, repo: { id: repo.id, name: repo.name } },
                      { method: 'post', action: '?/deleteRepo', encType: 'application/json' }
                    );
                  },
                })
              }
            >
              Delete
            </button>
          )}
        </div>
      );
    },
  };

  // The group header names which assignment a Submission/Graders/Grade trio
  // belongs to. With one assignment there is nothing to tell apart and the
  // page header already names it, so the trio sits flat instead.
  const groupPerAssignment = assignments.length > 1;

  const assignmentColumns: ColumnsType<SubmissionsRepo> = assignments.flatMap(assignment => {
    const trio: ColumnsType<SubmissionsRepo> = [
      {
        title: 'Submission',
        key: `s-${assignment.id}`,
        width: 150,
        className: 'border-l border-line',
        render: (_: unknown, repo: SubmissionsRepo) => {
          const ra = rowFor(repo, assignment.id);
          return ra ? (
            <RepositoryAssignmentStatus repositoryAssignment={ra} />
          ) : (
            <span className="text-sm text-ink-3">No submission yet</span>
          );
        },
      },
      {
        title: 'Graders',
        key: `g-${assignment.id}`,
        width: 200,
        // Who grades this rarely changes, so the row reads it rather than
        // offering an open select: the names as text, and one link to change
        // them. Same treatment as the assignment page's own roster.
        render: (_: unknown, repo: SubmissionsRepo) => {
          const ra = rowFor(repo, assignment.id);
          if (!ra) return null;
          const names = (ra.graders ?? []).map(g => g.grader.name || g.grader.login).join(', ');
          // Who grades what is the owner's call. An assistant reads the names
          // — they need to know whether a submission is theirs — but cannot
          // reassign it, here or through the Assign graders route, which is
          // requireClassroomAdmin on the server.
          if (!canEdit) {
            return <span className="text-sm text-ink-2">{names || '—'}</span>;
          }
          const assigned = new Set(
            (ra.graders ?? []).map(g => g.grader.login).filter((v): v is string => v != null)
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
                          graderHandler(
                            c.value,
                            assignment.id,
                            repo,
                            e.target.checked ? 'ADD' : 'REMOVE'
                          )
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
        key: `gr-${assignment.id}`,
        width: 240,
        render: (_: unknown, repo: SubmissionsRepo) => {
          const ra = rowFor(repo, assignment.id);
          if (!ra) return null;
          ra.repository = repo;
          ra.studentId = repo.student_id;
          ra.teamId = repo.team_id;
          return (
            <div className="flex items-center gap-2">
              <EmojisDisplay grades={ra.grades} />
              <EmojiGrader
                repositoryAssignment={
                  ra as Parameters<typeof EmojiGrader>[0]['repositoryAssignment']
                }
                emojiMappings={emojiMappings}
              />
              <LateOverrideButton
                repositoryAssignment={
                  ra as unknown as Parameters<typeof LateOverrideButton>[0]['repositoryAssignment']
                }
              />
            </div>
          );
        },
      },
    ];

    return groupPerAssignment
      ? [
          {
            title: (
              <span className="inline-flex items-center gap-2">
                <span className="text-ink-1">{assignment.title}</span>
                <span className="text-xs font-normal text-ink-3">
                  {isPushOnly ? '' : assignment.submission_mode === 'REPO' ? 'push' : 'issue'}
                </span>
              </span>
            ),
            key: `a-${assignment.id}`,
            className: 'border-l border-line',
            children: trio,
          },
        ]
      : trio;
  });

  return (
    <Table<SubmissionsRepo>
      dataSource={repos}
      rowKey="id"
      columns={[...fixedColumns, ...assignmentColumns, actionsColumn]}
      rowHoverable={false}
      scroll={{ x: 'max-content' }}
      pagination={{ pageSize: 100, hideOnSinglePage: true }}
      locale={{
        emptyText: (
          <div className="text-center py-12 text-gray-500">
            <div className="font-medium">No student repositories yet</div>
            <div className="text-sm">Publish the repository to create one per student.</div>
          </div>
        ),
      }}
    />
  );
};

export default SubmissionsTable;
