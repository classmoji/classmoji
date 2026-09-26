import { Button, Tag } from 'antd';
import { Link } from 'react-router';
import Emoji from '~/components/ui/display/Emoji';
import {
  type ModuleTreeNode,
  buildResourceLeaves,
  prettyType,
} from '~/components/features/modules/ReadOnlyModulesTree';
import AutogradingResultPill from '~/components/features/AutogradingResultPill';
import { gitContextFor, gitWeb, type ClassroomLike, type GitWebContext } from '~/utils/gitWeb';

/**
 * Links for a repo row: the repo's own classroom when the row carries it (so a
 * GitLab project resolves under its class subgroup), else the tree's context.
 */
const webFor = (classroom: ClassroomLike | null | undefined, ctx: StudentTreeCtx) =>
  gitWeb(
    classroom?.git_organization
      ? gitContextFor(classroom)
      : (ctx.git ?? { provider: 'GITHUB', login: ctx.gitOrgLogin })
  );
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
  /**
   * Route prefix the viewer arrived on ('student' | 'teacher' | 'assistant' |
   * 'admin'), used to keep the quiz leaf on that prefix.
   *
   * These trees render under every prefix, but the quiz href used to be
   * hardcoded to /student — and the student quizzes loader gates on role, so a
   * teacher following it got a full-page 403 rather than a broken link (the
   * leaf loader throws before any client-side guard runs). Defaults to
   * 'student' so an unset ctx keeps the original behaviour.
   */
  rolePrefix?: string;
  /** Org login, used to build the repository "View" fallback to the source repo. */
  gitOrgLogin?: string | null;
  /** The classroom's git context (Github org or GitLab class subgroup). */
  git?: GitWebContext;
  /**
   * The viewer's own git repo per repository unit, keyed by repository id.
   * Lets the "View" link reach the student's repo even when no GitHub issue
   * (GitRepoAssignment) has been created yet.
   */
  studentRepoByRepositoryId?: Record<string, { name: string }>;
  /** The viewer's latest autograding result per repository unit, keyed by id. */
  autogradingByRepositoryId?: Record<string, AutogradingResultData>;
  /**
   * Self-formed group repos on this page, keyed by repository id, with the
   * viewer's team state. Present only where the loader resolved it; a repo
   * missing from this map renders exactly as it always did.
   */
  selfFormedByRepositoryId?: Record<
    string,
    { slug: string; hasTeam: boolean; deadlinePassed: boolean }
  >;
  /**
   * Whether the viewer is teaching staff, taken from the membership the route's
   * gate returned — never inferred from `rolePrefix`, which is only the URL the
   * viewer happened to arrive on.
   *
   * Staff loaders fetch unpublished content; student loaders filter it out. This
   * flag decides only whether a "Draft" chip is drawn, and it defaults to false
   * so a caller that never sets it cannot label anything. It is presentation —
   * WHAT a viewer receives is settled in the loader, not here.
   */
  isStaff?: boolean;
}

/** Marks content students cannot see yet. Matches the module row's own chip. */
const DRAFT_TAG = <Tag color="orange">Draft</Tag>;

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
 * Turn a node's linked pages / slides / quizzes / forms into read-only resource
 * leaves. Delegates to the shared {@link buildResourceLeaves}, supplying the
 * student quizzes route as the quiz href.
 */
export const resourceLeaves = (
  input: {
    pages?: Array<{ page: { id: string; title: string; is_draft?: boolean } }>;
    slides?: Array<{ slide: { id: string; title: string; is_draft?: boolean } }>;
    quizzes?: Array<{ id: string; name: string; status?: string }>;
    forms?: Array<{
      id: string;
      title: string;
      slug: string;
      status: string;
      access: string;
      closes_at: Date | string | null;
    }>;
  },
  level: number,
  keyPrefix: string,
  ctx: StudentTreeCtx
): ModuleTreeNode[] =>
  buildResourceLeaves(input, level, keyPrefix, {
    ...ctx,
    quizzesHref: `/${ctx.rolePrefix ?? 'student'}/${ctx.classSlug}/quizzes`,
  });

/**
 * One assignment as the viewer sees it: title, submission state, released
 * grades, due date, and — for REPO assignments — the student's own issue as
 * the row's link (falling back to their repo when no issue exists yet). Used
 * both nested under a repository in the staff tree and flat on the student's
 * module card.
 */
export const buildAssignmentLeaf = (
  a: AnyRepository,
  ra: AnyRepoAssignment | undefined,
  ctx: StudentTreeCtx,
  level = 0,
  typeText?: string
): ModuleTreeNode => {
  const showGrades = a.grades_released && (ra?.grades?.length ?? 0) > 0;
  const login = ra?.git_repo?.classroom?.git_organization?.login ?? ctx.gitOrgLogin;
  const rowWeb = webFor(ra?.git_repo?.classroom, ctx);
  const issueUrl =
    login && ra?.provider_issue_number
      ? rowWeb.issue(ra.git_repo.name, ra.provider_issue_number)
      : null;
  const ownRepo =
    ra?.git_repo ??
    (a.repository_id ? ctx.studentRepoByRepositoryId?.[String(a.repository_id)] : undefined);
  const ownRepoUrl = ownRepo && login ? rowWeb.repo(ownRepo.name) : null;

  // A self-formed group assignment: until the viewer is on a team there is no
  // repo to open, so the row sends them to the team page instead of GitHub.
  const selfFormed = a.repository_id
    ? ctx.selfFormedByRepositoryId?.[String(a.repository_id)]
    : undefined;
  const teamHref = selfFormed
    ? `/${ctx.rolePrefix ?? 'student'}/${ctx.classSlug}/repos/${selfFormed.slug}/team`
    : null;
  const teamAction =
    selfFormed && teamHref && !(selfFormed.deadlinePassed && !selfFormed.hasTeam) ? (
      <Link to={teamHref}>
        <Button size="small">{selfFormed.hasTeam ? 'View team' : 'Form a team'}</Button>
      </Link>
    ) : null;
  const teamStatus =
    selfFormed && !selfFormed.hasTeam ? (
      <span className="text-xs font-medium text-ink-3">
        {selfFormed.deadlinePassed ? 'Team formation closed' : 'No team yet'}
      </span>
    ) : null;

  return {
    key: `assignment-${a.id}`,
    kind: 'assignment',
    level,
    name: a.title,
    typeText: typeText ?? (a.repository?.type ? prettyType(a.repository.type) : undefined),
    weightText: a.weight != null ? `${a.weight}%` : undefined,
    href: selfFormed && !selfFormed.hasTeam ? undefined : (issueUrl ?? ownRepoUrl ?? undefined),
    // The same three facts split out, so the student card can put each in its
    // own column; statusNode below keeps them together for the staff tree.
    submissionNode: teamStatus ?? submittedPill(ra?.status),
    gradeNode: showGrades ? (
      <span className="inline-flex items-center gap-1 whitespace-nowrap">
        {ra.grades.map((g: AnyRepoAssignment, i: number) => (
          <Emoji key={g.id ?? i} emoji={g.emoji} fontSize={16} />
        ))}
      </span>
    ) : null,
    dueText: a.student_deadline ? new Date(a.student_deadline).toLocaleDateString() : undefined,
    statusNode: (
      <div className="flex items-center gap-2 flex-wrap">
        {/* Staff-only, and gated on the flag rather than on the data: a
            student payload carries is_published too (always true, the loader
            filtered on it), so the flag is what keeps this off their tree. */}
        {ctx.isStaff === true && a.is_published === false && DRAFT_TAG}
        {teamStatus ?? submittedPill(ra?.status)}
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
    actionNode:
      teamAction ??
      (issueUrl ? (
        <a
          href={issueUrl}
          target="_blank"
          rel="noreferrer"
          className="text-sm font-medium text-sky-600 hover:text-sky-700 dark:text-sky-400"
        >
          Open issue
        </a>
      ) : null),
    children: resourceLeaves({ pages: a.pages, slides: a.slides }, level + 1, `a-${a.id}`, ctx),
  };
};

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
        repositoryChildren.push(
          buildAssignmentLeaf(a, raByAssignmentId[String(a.id)], ctx, baseLevel + 1, repositoryType)
        );
      }
      continue;
    }
    const gitRepo = bucket.gitRepo;
    const login = gitRepo?.classroom?.git_organization?.login;
    const url = gitRepo && login ? webFor(gitRepo.classroom, ctx).repo(gitRepo.name) : null;
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
        buildAssignmentLeaf(a, raByAssignmentId[String(a.id)], ctx, baseLevel + 2, repositoryType)
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
  const directRepoUrl =
    directRepo && ctx.gitOrgLogin ? webFor(null, ctx).repo(directRepo.name) : null;
  const ownGitRepo = realRepoKeys.length > 0 ? buckets.get(realRepoKeys[0])?.gitRepo : undefined;
  const ownRepoUrl =
    ownGitRepo && ownGitRepo.classroom?.git_organization?.login
      ? webFor(ownGitRepo.classroom, ctx).repo(ownGitRepo.name)
      : null;
  const sourceRepoUrl =
    repository.template && (repository.template.includes('/') || ctx.gitOrgLogin)
      ? webFor(null, ctx).template(repository.template)
      : null;
  // The template fallback is deliberately NOT offered on a self-formed row: a
  // student with no team has no repo of their own, and a "View" pointing at the
  // instructor's template is how they end up committing and filing issues on
  // it. Their own team repo still links normally once it exists.
  const selfFormed = ctx.selfFormedByRepositoryId?.[String(repository.id)];
  const repositoryUrl = selfFormed
    ? (directRepoUrl ?? ownRepoUrl)
    : (directRepoUrl ?? ownRepoUrl ?? sourceRepoUrl);

  const autogradingResult = ctx.autogradingByRepositoryId?.[String(repository.id)];

  const total = assignments.length;
  const done = assignments.filter(a => raByAssignmentId[String(a.id)]?.status === 'CLOSED').length;

  // A self-formed group repo is the one case where the row's job is to send the
  // viewer somewhere in the app rather than to GitHub: until they are on a team
  // there is no repo to open, and the team page was previously reachable only
  // by a link the instructor pasted by hand (#313).
  const teamHref = selfFormed
    ? `/${ctx.rolePrefix ?? 'student'}/${ctx.classSlug}/repos/${selfFormed.slug}/team`
    : null;
  const selfFormedAction =
    selfFormed && teamHref && !(selfFormed.deadlinePassed && !selfFormed.hasTeam) ? (
      <Link to={teamHref}>
        <Button size="small">{selfFormed.hasTeam ? 'View team' : 'Form a team'}</Button>
      </Link>
    ) : null;
  // Only when there is no submission count to show, which is the state a repo
  // awaiting a team is always in.
  const selfFormedStatus =
    selfFormed && !selfFormed.hasTeam ? (
      <span className="text-xs font-medium text-ink-3">
        {selfFormed.deadlinePassed ? 'Team formation closed' : 'No team yet'}
      </span>
    ) : null;

  return {
    key: `repository-${repository.id}`,
    // Top-level (standalone Repositories tab) reads as a repository header;
    // nested inside a module it's a plain repo row.
    kind: baseLevel === 0 ? 'repository' : 'repo',
    level: baseLevel,
    name: repository.title,
    typeText: repositoryType,
    autogradingNode:
      baseLevel === 0 && autogradingResult ? (
        <AutogradingResultPill
          result={autogradingResult}
          org={ctx.gitOrgLogin}
          repoName={directRepo?.name}
        />
      ) : null,
    // The row itself opens the repo; only the team action needs a button.
    href: repositoryUrl ?? undefined,
    actionNode: baseLevel === 0 ? selfFormedAction : null,
    statusNode:
      total > 0 ? (
        <span className="text-xs font-medium text-ink-2 tabular-nums">
          {done}/{total} submitted
        </span>
      ) : (
        selfFormedStatus
      ),
    children: repositoryChildren,
  };
};
