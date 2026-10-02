import { Button, Tag } from 'antd';
import { Link } from 'react-router';
import Emoji from '~/components/ui/display/Emoji';
import {
  type ModuleTreeNode,
  type QuizLeafInput,
  buildResourceLeaves,
  prettyType,
} from '~/components/features/modules/ReadOnlyModulesTree';
import { gitContextFor, gitWeb, type ClassroomLike, type GitWebContext } from '~/utils/gitWeb';

/**
 * Links for a repo row: the repo's own classroom when the row carries it (so a
 * Gitlab project resolves under its class subgroup), else the tree's context.
 */
const webFor = (classroom: ClassroomLike | null | undefined, ctx: StudentTreeCtx) =>
  gitWeb(
    classroom?.git_organization
      ? gitContextFor(classroom)
      : (ctx.git ?? { provider: 'GITHUB', login: ctx.gitOrgLogin })
  );

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
    quizzes?: QuizLeafInput[];
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
          Open {rowWeb.terms.issue}
        </a>
      ) : null),
    children: resourceLeaves({ pages: a.pages, slides: a.slides }, level + 1, `a-${a.id}`, ctx),
  };
};
