import { Button, Table, Tooltip } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import dayjs from 'dayjs';
import { IconBrandGithub, IconLayoutKanban } from '@tabler/icons-react';
import {
  UserThumbnailView,
  TeamThumbnailView,
  RepositoryAssignmentStatus,
  EmojisDisplay,
  TableActionButtons,
  EmojiGrader,
  LateOverrideButton,
  MultiSelect,
} from '~/components';
import { ActionTypes } from '~/constants';
import { useCallout } from '@classmoji/ui-components';
import { useGlobalFetcher } from '~/hooks';
import { openRepositoryAssignmentInGithub } from '~/utils/helpers.client';
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
}: SubmissionsTableProps) => {
  const { fetcher, notify } = useGlobalFetcher();
  const callout = useCallout();

  const isIndividual = repositoryType === 'INDIVIDUAL';
  // Only surface the "Imported" column when at least one repo carries imported data.
  const anyImported = repos.some(r => r.metadata != null && typeof r.metadata === 'object');

  const rowFor = (repo: SubmissionsRepo, assignmentId: string) =>
    repo.assignments?.find(a => a.assignment_id === assignmentId);

  // The newest commit any submission row of this repo has seen. Until the
  // commit stats have been fetched, a push-mode row's submission time is the
  // push the webhook recorded, so it stands in.
  const lastPush = (repo: SubmissionsRepo) => {
    let latest: number | null = null;
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
          <span className="text-ink-3">—</span>
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
  ];

  const assignmentColumns: ColumnsType<SubmissionsRepo> = assignments.map(assignment => ({
    title: (
      <span className="inline-flex items-center gap-2">
        <span className="text-ink-1">{assignment.title}</span>
        <span className="text-xs font-normal text-ink-3">
          {assignment.submission_mode === 'REPO' ? 'push' : 'issue'}
        </span>
      </span>
    ),
    key: `a-${assignment.id}`,
    className: 'border-l border-line',
    children: [
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
        onCell: () => ({ style: { padding: '0px' } }),
        render: (_: unknown, repo: SubmissionsRepo) => {
          const ra = rowFor(repo, assignment.id);
          if (!ra) return null;
          return (
            <div className="pl-4 pt-1.5">
              <MultiSelect
                defaultValue={ra.graders
                  ?.map(g => g.grader.login)
                  .filter((v): v is string => v != null)}
                options={assistants
                  .map(a => ({ label: a.name || '', value: a.login || '' }))
                  .sort((a, b) => (a.label || '').localeCompare(b.label || ''))}
                onSelect={(login: string) => graderHandler(login, assignment.id, repo, 'ADD')}
                onDeselect={(login: string) => graderHandler(login, assignment.id, repo, 'REMOVE')}
              />
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
              <TableActionButtons
                onView={() =>
                  // The row IS the git repo; hand the helper its name explicitly.
                  openRepositoryAssignmentInGithub(org, {
                    git_repo: { name: repo.name },
                    provider_issue_number: ra.provider_issue_number,
                  })
                }
                hideViewText
              >
                <EmojiGrader
                  repositoryAssignment={
                    ra as Parameters<typeof EmojiGrader>[0]['repositoryAssignment']
                  }
                  emojiMappings={emojiMappings}
                />
                <LateOverrideButton
                  repositoryAssignment={
                    ra as unknown as Parameters<
                      typeof LateOverrideButton
                    >[0]['repositoryAssignment']
                  }
                />
              </TableActionButtons>
            </div>
          );
        },
      },
    ],
  }));

  return (
    <Table<SubmissionsRepo>
      dataSource={repos}
      rowKey="id"
      columns={[...fixedColumns, ...assignmentColumns]}
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
