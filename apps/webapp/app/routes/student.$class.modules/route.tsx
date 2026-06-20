import getPrisma from '@classmoji/database';
import { Tag } from 'antd';
import type { Route } from './+types/route';
import { ClassmojiService } from '@classmoji/services';
import { assertClassroomAccess } from '~/utils/helpers';
import ReadOnlyModulesTree, {
  type ModuleTreeNode,
} from '~/components/features/modules/ReadOnlyModulesTree';
import {
  buildRepositoryNode,
  resourceLeaves,
  type AnyRepoAssignment,
  type AnyRepository,
  type StudentTreeCtx,
} from '~/components/features/modules/studentTree';

// Rich repository include matching the standalone repositories view, so a
// repository placed in a module renders identically (assignments, git repos,
// submission state, attached resources).
const REPO_INCLUDE = {
  assignments: {
    where: { is_published: true },
    include: {
      pages: { include: { page: true }, orderBy: { order: 'asc' as const } },
      slides: {
        where: { slide: { is_draft: false } },
        include: { slide: true },
        orderBy: { order: 'asc' as const },
      },
    },
    orderBy: { student_deadline: 'asc' as const },
  },
  pages: { include: { page: true }, orderBy: { order: 'asc' as const } },
  slides: {
    where: { slide: { is_draft: false } },
    include: { slide: true },
    orderBy: { order: 'asc' as const },
  },
  quizzes: { where: { status: 'PUBLISHED' as const }, select: { id: true, name: true } },
};

export const loader = async ({ params, request }: Route.LoaderArgs) => {
  const classSlug = params.class!;

  const { userId, classroom, membership } = await assertClassroomAccess({
    request,
    classroomSlug: classSlug,
    allowedRoles: ['OWNER', 'TEACHER', 'ASSISTANT', 'STUDENT'],
    resourceType: 'STUDENT_REPOSITORIES',
    attemptedAction: 'view_modules',
  });

  const showModules = classroom.settings?.show_modules !== false;
  // Staff may preview drafts; students only see published modules and items.
  const isStaff = !!membership && membership.role !== 'STUDENT';

  if (!showModules) {
    return { enabled: false as const };
  }

  // The module list and the student's own repo-assignments are independent —
  // fetch them in parallel. (Rich repo data depends on the module list, so it
  // follows.)
  const [modules, repoAssignments] = await Promise.all([
    ClassmojiService.module.listForClassroom(classSlug, { includeUnpublished: isStaff }),
    ClassmojiService.helper.findAllAssignmentsForStudent(userId, classSlug),
  ]);

  // Fetch the rich repository data for every repository referenced by an item.
  const repoIds = [
    ...new Set(
      modules.flatMap(m =>
        m.items
          .filter(i => i.item_type === 'REPOSITORY' && i.repository_id)
          .map(i => i.repository_id!)
      )
    ),
  ];
  const richRepos = repoIds.length
    ? await getPrisma().repository.findMany({
        where: { id: { in: repoIds } },
        include: REPO_INCLUDE,
      })
    : [];
  const repoById = Object.fromEntries(richRepos.map(r => [r.id, r]));

  // The student's own repo-assignments power submission status / issue links.
  const raByAssignmentId: Record<string, (typeof repoAssignments)[number]> = {};
  repoAssignments.forEach(ra => {
    raByAssignmentId[ra.assignment_id] = ra;
  });

  return {
    enabled: true as const,
    isStaff,
    modules,
    repoById,
    raByAssignmentId,
    slidesUrl: process.env.SLIDES_URL || 'http://localhost:6500',
    pagesUrl: process.env.PAGES_URL || 'http://localhost:7100',
    classSlug,
  };
};

type LoadedModules = Extract<Awaited<ReturnType<typeof loader>>, { enabled: true }>['modules'];

// Build the read-only tree in the component — node objects hold JSX, which a
// loader cannot serialize, so the loader only returns plain data.
const buildModuleNodes = (
  modules: LoadedModules,
  repoById: Record<string, AnyRepository>,
  raByAssignmentId: Record<string, AnyRepoAssignment>,
  ctx: StudentTreeCtx,
  isStaff: boolean
): ModuleTreeNode[] =>
  modules.map(m => {
    const children: ModuleTreeNode[] = [];
    for (const item of m.items) {
      switch (item.item_type) {
        case 'REPOSITORY': {
          const repo = item.repository_id ? repoById[item.repository_id] : undefined;
          if (repo) children.push(buildRepositoryNode(repo, raByAssignmentId, ctx, 1));
          break;
        }
        case 'PAGE':
          if (item.page)
            children.push(
              ...resourceLeaves({ pages: [{ page: item.page }] }, 1, `mi-${item.id}`, ctx)
            );
          break;
        case 'SLIDE':
          if (item.slide)
            children.push(
              ...resourceLeaves({ slides: [{ slide: item.slide }] }, 1, `mi-${item.id}`, ctx)
            );
          break;
        case 'QUIZ':
          if (item.quiz)
            children.push(
              ...resourceLeaves(
                { quizzes: [{ id: item.quiz.id, name: item.quiz.name }] },
                1,
                `mi-${item.id}`,
                ctx
              )
            );
          break;
      }
    }

    return {
      key: `module-${m.id}`,
      kind: 'module',
      level: 0,
      name: m.title,
      statusNode:
        isStaff && !m.is_published ? (
          <Tag color="orange">Draft</Tag>
        ) : children.length > 0 ? (
          <span className="text-xs font-medium text-ink-2 tabular-nums">
            {children.length} {children.length === 1 ? 'item' : 'items'}
          </span>
        ) : null,
      children,
    };
  });

const StudentModules = ({ loaderData }: Route.ComponentProps) => {
  if (!loaderData.enabled) {
    return (
      <div className="min-h-full">
        <h1 className="mt-2 mb-4 text-lg font-semibold text-ink-1">Modules</h1>
        <div className="rounded-2xl bg-panel ring-1 ring-line p-8 text-center">
          <h3 className="text-lg font-semibold text-ink-1">Modules aren’t enabled</h3>
          <p className="text-sm text-ink-3 mt-1">
            Your instructor hasn’t turned on the Modules view for this course.
          </p>
        </div>
      </div>
    );
  }

  const { modules, repoById, raByAssignmentId, slidesUrl, pagesUrl, classSlug, isStaff } =
    loaderData;
  const ctx: StudentTreeCtx = { classSlug, slidesUrl, pagesUrl };
  const nodes = buildModuleNodes(
    modules,
    repoById as Record<string, AnyRepository>,
    raByAssignmentId as Record<string, AnyRepoAssignment>,
    ctx,
    isStaff
  );

  return (
    <div className="min-h-full">
      <h1 className="mt-2 mb-4 text-lg font-semibold text-ink-1">Modules</h1>

      {nodes.length === 0 ? (
        <div className="rounded-2xl bg-panel ring-1 ring-line p-8 text-center">
          <h3 className="text-lg font-semibold text-ink-1">No modules yet</h3>
          <p className="text-sm text-ink-3 mt-1">
            Modules will appear here once your instructor publishes them.
          </p>
        </div>
      ) : (
        <ReadOnlyModulesTree key={classSlug} nodes={nodes} />
      )}
    </div>
  );
};

export default StudentModules;
