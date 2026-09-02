import getPrisma from '@classmoji/database';
import { Tag } from 'antd';
import { useLocation } from 'react-router';
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
//
// `isStaff` MUST be this route's own flag, derived from the membership its gate
// returned — never a prefix sniff or a client-supplied value. It is the single
// thing standing between a student and another student's unpublished work here,
// and repoDraftPolicy.test.ts pins that every filter below flips with the role.
//
// EVERY draft-filterable leg below is conditional on the same flag —
// assignments, both slides legs, both pages legs, and quizzes. Students get the
// published view of all six; staff get all six unfiltered, and anything
// unpublished that reaches the tree is chipped there rather than hidden. Keeping
// them uniform is the point: a leg that is filtered for one role and not the
// other is how the two surfaces drifted apart in the first place.
const repoInclude = (isStaff: boolean) => ({
  assignments: {
    // Staff preview drafts; students only ever get published assignments.
    ...(isStaff ? {} : { where: { is_published: true } }),
    include: {
      pages: {
        ...(isStaff ? {} : { where: { page: { is_draft: false } } }),
        include: { page: true },
        orderBy: { order: 'asc' as const },
      },
      slides: {
        ...(isStaff ? {} : { where: { slide: { is_draft: false } } }),
        include: { slide: true },
        orderBy: { order: 'asc' as const },
      },
    },
    orderBy: { student_deadline: 'asc' as const },
  },
  pages: {
    ...(isStaff ? {} : { where: { page: { is_draft: false } } }),
    include: { page: true },
    orderBy: { order: 'asc' as const },
  },
  slides: {
    ...(isStaff ? {} : { where: { slide: { is_draft: false } } }),
    include: { slide: true },
    orderBy: { order: 'asc' as const },
  },
  // `status` is selected because the tree renders it: a DRAFT or CLOSED quiz is
  // chipped for staff rather than silently listed alongside the live ones.
  quizzes: {
    ...(isStaff ? {} : { where: { status: 'PUBLISHED' as const } }),
    select: { id: true, name: true, status: true },
  },
});

export const loader = async ({ params, request }: Route.LoaderArgs) => {
  const classSlug = params.class!;

  // This loader is re-exported by the assistant and teacher prefixes, which
  // serve it as a STAFF view: it shows unpublished modules and draft items that
  // students never see. Logging those denials as 'STUDENT_REPOSITORIES' would
  // describe the wrong thing, so the staff prefixes are named for what they
  // actually are, using the vocabulary the MCP module tools already write.
  //
  // The student prefix keeps 'STUDENT_REPOSITORIES' exactly as before — this
  // narrows the description of the staff case rather than changing the
  // student one.
  const isStaffPrefix = /^\/(teacher|assistant)\//.test(new URL(request.url).pathname);

  const { userId, classroom, membership } = await assertClassroomAccess({
    request,
    classroomSlug: classSlug,
    allowedRoles: ['OWNER', 'TEACHER', 'ASSISTANT', 'STUDENT'],
    resourceType: isStaffPrefix ? 'MODULES' : 'STUDENT_REPOSITORIES',
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
        include: repoInclude(isStaff),
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
        // listForClassroom already dropped DRAFT forms for students, so for them
        // anything here is OPEN or CLOSED; staff additionally see drafts, marked
        // as such. The close time is the leaf's deadline; access says who may
        // open it.
        case 'FORM':
          if (item.form)
            children.push(
              ...resourceLeaves(
                {
                  forms: [
                    {
                      id: item.form.id,
                      title: item.form.title,
                      slug: item.form.slug,
                      status: item.form.status,
                      access: item.form.access,
                      closes_at: item.form.closes_at,
                    },
                  ],
                },
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
  // Hook first: it must run on every render, including the disabled early
  // return below.
  const rolePrefix = useLocation().pathname.split('/')[1];

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
  // Served under every prefix this route's gate allows, so resource links stay
  // on the prefix the viewer arrived on. `isStaff` is the loader's own flag —
  // note it travels SEPARATELY from rolePrefix, which is only the URL: a student
  // under /teacher is still a student, and gets no draft chips because the
  // loader gave them no drafts to chip.
  const ctx: StudentTreeCtx = { classSlug, slidesUrl, pagesUrl, rolePrefix, isStaff };
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
