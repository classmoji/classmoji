import { Button, Table, Tooltip } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import dayjs from 'dayjs';
import { IconBrandGithub, IconLayoutKanban } from '@tabler/icons-react';
import {
  UserThumbnailView,
  TeamThumbnailView,
  RepositoryAssignmentStatus,
  TableActionButtons,
  EmojiGrader,
  LateOverrideButton,
  MultiSelect,
} from '~/components';
import { ActionTypes } from '~/constants';
import { useCallout } from '@classmoji/ui-components';
import { useGlobalFetcher } from '~/hooks';
import { openRepositoryAssignmentInGithub } from '~/utils/helpers.client';
import type { AssignmentRowData } from '~/components/features/assignments/AssignmentsTable';
import ImportedBadge from './ImportedBadge';
import GradeBadges from '~/components/features/grading/GradeBadges';
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
  analytics_snapshot?: { last_commit_at?: string | Date | null } | null;
  repository?: { name: string; [key: string]: unknown } | null;
  assignment: { weight: number; submission_mode?: string; [key: string]: unknown };
  studentId?: string | null;
  teamId?: string | null;
  [key: string]: unknown;
}

export interface SubmissionsRepo {
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
  assignment,
  repos,
  assistants,
  emojiMappings,
  org,
  canManageGraders,
  total,
}: SubmissionsTableProps) => {
  const { fetcher, notify } = useGlobalFetcher();
  const callout = useCallout();

  const isIndividual = repositoryType === 'INDIVIDUAL';
  const isPushMode = assignment.submission_mode === 'REPO';
  // Only surface the "Imported" column when at least one repo carries imported data.
  const anyImported = repos.some(r => r.metadata != null && typeof r.metadata === 'object');

  // The newest commit this repo has seen. Until the commit stats have been
  // fetched, a push-mode row's submission time is the push the webhook
  // recorded, so it stands in.
  const lastPush = (repo: SubmissionsRepo) => {
    const s = repo.submission;
    const candidates = [s?.analytics_snapshot?.last_commit_at, isPushMode ? s?.closed_at : null];
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
    {
      title: 'Autograding',
      key: 'autograding',
      width: 130,
      render: (_: unknown, repo) => (
        <AutogradingResultPill result={repo.autograding_result} org={org} repoName={repo.name} />
      ),
    },
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
      onCell: () => ({ style: { padding: '0px' } }),
      render: (_: unknown, repo) => {
        const s = repo.submission;
        if (!s) return null;
        if (!canManageGraders) {
          const names = (s.graders ?? []).map(g => g.grader.name || g.grader.login).join(', ');
          return <div className="pl-4 py-2 text-sm text-ink-2">{names || '—'}</div>;
        }
        return (
          <div className="pl-4 pt-1.5">
            <MultiSelect
              defaultValue={s.graders
                ?.map(g => g.grader.login)
                .filter((v): v is string => v != null)}
              options={assistants
                .map(a => ({ label: a.name || '', value: a.login || '' }))
                .sort((a, b) => (a.label || '').localeCompare(b.label || ''))}
              onSelect={(login: string) => graderHandler(login, repo, 'ADD')}
              onDeselect={(login: string) => graderHandler(login, repo, 'REMOVE')}
            />
          </div>
        );
      },
    },
    {
      title: 'Grade',
      key: 'grade',
      width: 240,
      render: (_: unknown, repo) => {
        const s = repo.submission;
        if (!s) return null;
        s.repository = repo;
        s.studentId = repo.student_id;
        s.teamId = repo.team_id;
        return (
          <div className="flex items-center gap-2">
            <GradeBadges grades={s.grades} emojiMappings={emojiMappings} />
            <TableActionButtons
              onView={() =>
                // The row IS the git repo; hand the helper its name explicitly.
                openRepositoryAssignmentInGithub(org, {
                  git_repo: { name: repo.name },
                  provider_issue_number: s.provider_issue_number,
                })
              }
              hideViewText
            >
              <EmojiGrader
                repositoryAssignment={
                  s as Parameters<typeof EmojiGrader>[0]['repositoryAssignment']
                }
                emojiMappings={emojiMappings}
              />
              <LateOverrideButton
                repositoryAssignment={
                  s as unknown as Parameters<typeof LateOverrideButton>[0]['repositoryAssignment']
                }
              />
            </TableActionButtons>
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
