import { Tag } from 'antd';
import Emoji from '~/components/ui/display/Emoji';
import {
  type ModuleTreeNode,
  buildResourceLeaves,
  prettyType,
  repoGithubUrl,
} from '~/components/features/modules/ReadOnlyModulesTree';
import AutogradingResultPill from '~/components/features/AutogradingResultPill';
import type { AutogradingResultData } from '~/components/features/AutogradingResultCard';

// These trees are assembled from loosely-typed Prisma includes that differ
// slightly per route; the node builder only touches a well-known subset.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyRepository = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyRepoAssignment = any;

export interface StudentTreeCtx {
  classSlug: string;
  slidesUrl: string;
  pagesUrl: string;
  /** Org login, used to build the repository "View" fallback to the source repo. */
  gitOrgLogin?: string | null;
  /**
   * The viewer's own git repo per repository unit, keyed by repository id.
   * Lets the "View" link reach the student's repo even when no GitHub issue
   * (GitRepoAssignment) has been created yet.
   */
  studentRepoByRepositoryId?: Record<string, { name: string }>;
  /** The viewer's latest autograding result per repository unit, keyed by id. */
  autogradingByRepositoryId?: Record<string, AutogradingResultData>;
}

export const submittedPill = (status?: string) => {
  const submitted = status === 'CLOSED';
  return (
    <span
      className={`inline-flex items-center text-xs font-semibold px-2 py-0.5 rounded-full ${
        submitted
          ? 'bg-[#619462]/15 text-[#3f6a40] dark:bg-[#619462]/20 dark:text-[#9BC39C]'
          : 'bg-[#D4A289]/15 text-[#8a5b3a] dark:bg-[#D4A289]/20 dark:text-[#E8C4AC]'
      }`}
    >
      {submitted ? 'Submitted' : 'Not submitted'}
    </span>
  );
};

/**
 * Turn a node's linked pages / slides / quizzes into read-only resource leaves.
 * Delegates to the shared {@link buildResourceLeaves}, supplying the student
 * quizzes route as the quiz href.
 */
export const resourceLeaves = (
  input: {
    pages?: Array<{ page: { id: string; title: string } }>;
    slides?: Array<{ slide: { id: string; title: string } }>;
    quizzes?: Array<{ id: string; name: string }>;
  },
  level: number,
  keyPrefix: string,
  ctx: StudentTreeCtx
): ModuleTreeNode[] =>
  buildResourceLeaves(input, level, keyPrefix, {
    ...ctx,
    quizzesHref: `/student/${ctx.classSlug}/quizzes`,
  });

/**
 * Build the read-only subtree for a single repository: the repository node
 * (folder), its student git repos and assignments with submission status, and
 * any attached resources. `baseLevel` is the repository node's indent level
 * (0 when it's a top-level card, higher when nested inside a module).
 */
export const buildRepositoryNode = (
  repository: AnyRepository,
  raByAssignmentId: Record<string, AnyRepoAssignment>,
  ctx: StudentTreeCtx,
  baseLevel = 0
): ModuleTreeNode => {
  const repositoryType = prettyType(repository.type);
  const assignments: AnyRepository[] = repository.assignments ?? [];

  const assignmentNode = (
    a: AnyRepository,
    ra: AnyRepoAssignment | undefined,
    level: number
  ): ModuleTreeNode => {
    const showGrades = a.grades_released && (ra?.grades?.length ?? 0) > 0;
    const login = ra?.git_repo?.classroom?.git_organization?.login;
    const issueUrl =
      login && ra?.provider_issue_number
        ? `https://github.com/${login}/${ra.git_repo.name}/issues/${ra.provider_issue_number}`
        : null;
    return {
      key: `assignment-${a.id}`,
      kind: 'assignment',
      level,
      name: a.title,
      typeText: repositoryType,
      weightText: a.weight != null ? `${a.weight}%` : undefined,
      statusNode: (
        <div className="flex items-center gap-2 flex-wrap">
          {submittedPill(ra?.status)}
          {showGrades && (
            <span className="inline-flex items-center gap-1 whitespace-nowrap">
              {ra.grades.map((g: AnyRepoAssignment, i: number) => (
                <Emoji key={g.id ?? i} emoji={g.emoji} fontSize={16} />
              ))}
            </span>
          )}
          {a.student_deadline && (
            <span className="text-xs text-ink-3 whitespace-nowrap">
              due {new Date(a.student_deadline).toLocaleDateString()}
            </span>
          )}
        </div>
      ),
      actionNode: issueUrl ? (
        <a
          href={issueUrl}
          target="_blank"
          rel="noreferrer"
          className="text-sm font-medium text-sky-600 hover:text-sky-700 dark:text-sky-400"
        >
          Open issue
        </a>
      ) : null,
      children: resourceLeaves({ pages: a.pages, slides: a.slides }, level + 1, `a-${a.id}`, ctx),
    };
  };

  // Group the student's assignments by the per-student git repo their RA belongs to.
  const NONE = '__none__';
  const buckets = new Map<
    string,
    { gitRepo: AnyRepoAssignment | undefined; items: AnyRepository[] }
  >();
  for (const a of assignments) {
    const ra = raByAssignmentId[String(a.id)];
    const key = ra?.git_repo?.id ?? NONE;
    if (!buckets.has(key)) buckets.set(key, { gitRepo: ra?.git_repo, items: [] });
    buckets.get(key)!.items.push(a);
  }
  const realRepoKeys = [...buckets.keys()].filter(k => k !== NONE);
  // Common case: one git repo per repository unit — fold any RA-less assignments into it.
  if (realRepoKeys.length === 1 && buckets.has(NONE)) {
    buckets.get(realRepoKeys[0])!.items.push(...buckets.get(NONE)!.items);
    buckets.delete(NONE);
  }

  const repositoryChildren: ModuleTreeNode[] = [];
  for (const [key, bucket] of buckets) {
    if (key === NONE) {
      for (const a of bucket.items) {
        repositoryChildren.push(assignmentNode(a, raByAssignmentId[String(a.id)], baseLevel + 1));
      }
      continue;
    }
    const gitRepo = bucket.gitRepo;
    const login = gitRepo?.classroom?.git_organization?.login;
    const url = gitRepo ? repoGithubUrl(gitRepo.name, login) : null;
    repositoryChildren.push({
      key: `repo-${gitRepo.id}`,
      kind: 'repo',
      level: baseLevel + 1,
      name: gitRepo.name,
      statusNode: <Tag>Active</Tag>,
      actionNode: url ? (
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          className="text-sm font-medium text-sky-600 hover:text-sky-700 dark:text-sky-400"
        >
          Open repo
        </a>
      ) : null,
      children: bucket.items.map(a =>
        assignmentNode(a, raByAssignmentId[String(a.id)], baseLevel + 2)
      ),
    });
  }

  // Repository-level resources (pages / slides / quizzes).
  repositoryChildren.push(
    ...resourceLeaves(
      { pages: repository.pages, slides: repository.slides, quizzes: repository.quizzes },
      baseLevel + 1,
      `m-${repository.id}`,
      ctx
    )
  );

  // The top-level "View" link on the standalone Repositories tab: open the
  // viewer's own repo for this unit when they have one, otherwise fall back to
  // the repository's source/template repo so the link is always available
  // (e.g. instructors previewing, or students who haven't accepted yet).
  // Prefer the student's git repo looked up directly by repository id (works
  // even before any GitHub issue exists), then any repo found via assignments,
  // then the template.
  const directRepo = ctx.studentRepoByRepositoryId?.[String(repository.id)];
  const directRepoUrl = directRepo ? repoGithubUrl(directRepo.name, ctx.gitOrgLogin) : null;
  const ownGitRepo = realRepoKeys.length > 0 ? buckets.get(realRepoKeys[0])?.gitRepo : undefined;
  const ownRepoUrl = ownGitRepo
    ? repoGithubUrl(ownGitRepo.name, ownGitRepo?.classroom?.git_organization?.login)
    : null;
  const sourceRepoUrl = repository.template
    ? repoGithubUrl(repository.template, ctx.gitOrgLogin)
    : null;
  const repositoryUrl = directRepoUrl ?? ownRepoUrl ?? sourceRepoUrl;

  const autogradingResult = ctx.autogradingByRepositoryId?.[String(repository.id)];

  const total = assignments.length;
  const done = assignments.filter(a => raByAssignmentId[String(a.id)]?.status === 'CLOSED').length;

  return {
    key: `repository-${repository.id}`,
    // Top-level (standalone Repositories tab) reads as a repository header;
    // nested inside a module it's a plain repo row.
    kind: baseLevel === 0 ? 'repository' : 'repo',
    level: baseLevel,
    name: repository.title,
    typeText: repositoryType,
    weightText: repository.weight != null ? `${repository.weight}%` : undefined,
    autogradingNode:
      baseLevel === 0 && autogradingResult ? (
        <AutogradingResultPill
          result={autogradingResult}
          org={ctx.gitOrgLogin}
          repoName={directRepo?.name}
        />
      ) : null,
    actionNode:
      baseLevel === 0 && repositoryUrl ? (
        <a
          href={repositoryUrl}
          target="_blank"
          rel="noreferrer"
          className="text-sm font-medium text-sky-600 hover:text-sky-700 dark:text-sky-400"
        >
          View
        </a>
      ) : null,
    statusNode:
      total > 0 ? (
        <span className="text-xs font-medium text-ink-2 tabular-nums">
          {done}/{total} submitted
        </span>
      ) : null,
    children: repositoryChildren,
  };
};
