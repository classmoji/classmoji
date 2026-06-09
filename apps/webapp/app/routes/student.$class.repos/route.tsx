import getPrisma from '@classmoji/database';
import type { Route } from './+types/route';
import { ClassmojiService } from '@classmoji/services';
import { assertClassroomAccess } from '~/utils/helpers';
import { Tag } from 'antd';
import Emoji from '~/components/ui/display/Emoji';
import ReadOnlyModulesTree, {
  type ModuleTreeNode,
  prettyType,
  repoGithubUrl,
} from '~/components/features/modules/ReadOnlyModulesTree';

type UserTeamResult = NonNullable<
  Awaited<ReturnType<typeof ClassmojiService.team.findUserTeamByTag>>
>;

export const loader = async ({ params, request }: Route.LoaderArgs) => {
  const classSlug = params.class!;

  const { userId, classroom } = await assertClassroomAccess({
    request,
    classroomSlug: classSlug,
    allowedRoles: ['OWNER', 'TEACHER', 'ASSISTANT', 'STUDENT'],
    resourceType: 'STUDENT_REPOSITORIES',
    attemptedAction: 'view_modules',
  });

  const repositories = await getPrisma().repository.findMany({
    where: { classroom_id: classroom.id, is_published: true },
    include: {
      assignments: {
        where: { is_published: true },
        include: {
          pages: { include: { page: true }, orderBy: { order: 'asc' } },
          slides: {
            where: { slide: { is_draft: false } },
            include: { slide: true },
            orderBy: { order: 'asc' },
          },
        },
        orderBy: { student_deadline: 'asc' },
      },
      pages: { include: { page: true }, orderBy: { order: 'asc' } },
      slides: {
        where: { slide: { is_draft: false } },
        include: { slide: true },
        orderBy: { order: 'asc' },
      },
      quizzes: {
        where: { status: 'PUBLISHED' },
        select: { id: true, name: true },
      },
    },
    orderBy: { created_at: 'asc' },
  });

  // For self-formed team repositories, check if user has a team
  const userTeamsByModuleSlug: Record<string, UserTeamResult> = {};
  const selfFormedModules = repositories.filter(m => m.team_formation_mode === 'SELF_FORMED');

  for (const repository of selfFormedModules) {
    const tag = await ClassmojiService.organizationTag.findByClassroomIdAndName(
      classroom.id,
      repository.slug!
    );
    if (tag) {
      const userTeam = await ClassmojiService.team.findUserTeamByTag(classroom.id, tag.id, userId);
      if (userTeam) userTeamsByModuleSlug[repository.slug!] = userTeam;
    }
  }

  // Fetch both individual AND team assignments so View Issue button works for group assignments
  const repoAssignments = await ClassmojiService.helper.findAllAssignmentsForStudent(
    userId,
    classSlug
  );

  const repoAssignmentsByAssignmentId: Record<string, (typeof repoAssignments)[number]> = {};
  repoAssignments.forEach(ra => {
    repoAssignmentsByAssignmentId[ra.assignment_id] = ra;
  });

  return {
    repositories,
    repoAssignmentsByAssignmentId,
    userTeamsByModuleSlug,
    slidesUrl: process.env.SLIDES_URL || 'http://localhost:6500',
    pagesUrl: process.env.PAGES_URL || 'http://localhost:7100',
    classSlug,
  };
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRepository = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRepoAssignment = any;

const submittedPill = (status?: string) => {
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

const resourceLeaves = (
  {
    pages,
    slides,
    quizzes,
  }: {
    pages?: Array<{ page: { id: string; title: string } }>;
    slides?: Array<{ slide: { id: string; title: string } }>;
    quizzes?: Array<{ id: string; name: string }>;
  },
  level: number,
  keyPrefix: string,
  ctx: { classSlug: string; slidesUrl: string; pagesUrl: string }
): ModuleTreeNode[] => {
  const out: ModuleTreeNode[] = [];
  (pages ?? []).forEach(({ page }) =>
    out.push({
      key: `${keyPrefix}-page-${page.id}`,
      kind: 'resource',
      level,
      resourceIcon: 'page',
      name: page.title,
      href: `${ctx.pagesUrl}/${ctx.classSlug}/${page.id}`,
    })
  );
  (slides ?? []).forEach(({ slide }) =>
    out.push({
      key: `${keyPrefix}-slide-${slide.id}`,
      kind: 'resource',
      level,
      resourceIcon: 'slide',
      name: slide.title,
      href: `${ctx.slidesUrl}/${slide.id}`,
    })
  );
  (quizzes ?? []).forEach(q =>
    out.push({
      key: `${keyPrefix}-quiz-${q.id}`,
      kind: 'resource',
      level,
      resourceIcon: 'quiz',
      name: q.name,
      href: `/student/${ctx.classSlug}/quizzes`,
    })
  );
  return out;
};

const buildStudentNodes = (
  repositories: AnyRepository[],
  raByAssignmentId: Record<string, AnyRepoAssignment>,
  ctx: { classSlug: string; slidesUrl: string; pagesUrl: string }
): ModuleTreeNode[] => {
  return repositories.map((repository: AnyRepository) => {
    const repositoryType = prettyType(repository.type);
    const assignments: AnyRepository[] = repository.assignments ?? [];

    // Build an assignment node from the assignment definition + the student's own RA
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

    // Group the student's assignments by the per-student git repo their RA belongs to
    const NONE = '__none__';
    const buckets = new Map<string, { gitRepo: AnyRepoAssignment | undefined; items: AnyRepository[] }>();
    for (const a of assignments) {
      const ra = raByAssignmentId[String(a.id)];
      const key = ra?.git_repo?.id ?? NONE;
      if (!buckets.has(key)) buckets.set(key, { gitRepo: ra?.git_repo, items: [] });
      buckets.get(key)!.items.push(a);
    }
    const realRepoKeys = [...buckets.keys()].filter(k => k !== NONE);
    // Common case: one git repo per repository unit — fold any RA-less assignments into it
    if (realRepoKeys.length === 1 && buckets.has(NONE)) {
      buckets.get(realRepoKeys[0])!.items.push(...buckets.get(NONE)!.items);
      buckets.delete(NONE);
    }

    const repositoryChildren: ModuleTreeNode[] = [];
    for (const [key, bucket] of buckets) {
      if (key === NONE) {
        // No git repo yet — show the assignments directly under the repository unit
        for (const a of bucket.items) {
          repositoryChildren.push(assignmentNode(a, raByAssignmentId[String(a.id)], 1));
        }
        continue;
      }
      const gitRepo = bucket.gitRepo;
      const login = gitRepo?.classroom?.git_organization?.login;
      const url = gitRepo ? repoGithubUrl(gitRepo.name, login) : null;
      repositoryChildren.push({
        key: `repo-${gitRepo.id}`,
        kind: 'repo',
        level: 1,
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
        children: bucket.items.map(a => assignmentNode(a, raByAssignmentId[String(a.id)], 2)),
      });
    }

    // Repository-level resources (pages / slides / quizzes)
    repositoryChildren.push(
      ...resourceLeaves(
        { pages: repository.pages, slides: repository.slides, quizzes: repository.quizzes },
        1,
        `m-${repository.id}`,
        ctx
      )
    );

    const total = assignments.length;
    const done = assignments.filter(
      a => raByAssignmentId[String(a.id)]?.status === 'CLOSED'
    ).length;

    return {
      key: `repository-${repository.id}`,
      kind: 'module',
      level: 0,
      name: repository.title,
      typeText: repositoryType,
      weightText: repository.weight != null ? `${repository.weight}%` : undefined,
      statusNode:
        total > 0 ? (
          <span className="text-xs font-medium text-ink-2 tabular-nums">
            {done}/{total} submitted
          </span>
        ) : null,
      children: repositoryChildren,
    };
  });
};

const StudentRepositories = ({ loaderData }: Route.ComponentProps) => {
  const { repositories, repoAssignmentsByAssignmentId, slidesUrl, pagesUrl, classSlug } =
    loaderData;

  const ctx = { classSlug, slidesUrl, pagesUrl };
  const nodes = buildStudentNodes(
    repositories as AnyRepository[],
    repoAssignmentsByAssignmentId,
    ctx
  );

  return (
    <div className="min-h-full">
      <h1 className="mt-2 mb-4 text-base font-semibold text-ink-2">Repositories</h1>

      {repositories.length === 0 ? (
        <div className="rounded-2xl bg-panel ring-1 ring-line p-8 text-center">
          <h3 className="text-base font-semibold text-ink-1">No published repositories yet</h3>
          <p className="text-sm text-ink-3 mt-1">
            Repositories will appear here once your instructor publishes them.
          </p>
        </div>
      ) : (
        <div data-tour="repos-card">
          <ReadOnlyModulesTree key={classSlug} nodes={nodes} />
        </div>
      )}
    </div>
  );
};

export default StudentRepositories;
