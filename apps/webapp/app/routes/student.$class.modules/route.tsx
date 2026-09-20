import { useState } from 'react';
import { useLocation } from 'react-router';
import { Button } from 'antd';
import type { Route } from './+types/route';
import { ClassmojiService } from '@classmoji/services';
import { assertClassroomAccess } from '~/utils/helpers';
import type { ModuleTreeNode } from '~/components/features/modules/ReadOnlyModulesTree';
import StudentModuleCard from '~/components/features/modules/StudentModuleCard';
import {
  buildAssignmentLeaf,
  resourceLeaves,
  type AnyRepoAssignment,
  type StudentTreeCtx,
} from '~/components/features/modules/studentTree';

// `isStaff` MUST be this route's own flag, derived from the membership its gate
// returned — never a prefix sniff or a client-supplied value. It is the single
// thing standing between a student and another student's unpublished work here:
// it is what `listForClassroom` filters on (published modules, items and
// assignments, and a REPO assignment only once its repository is published),
// and repoDraftPolicy.test.ts pins that the flag flips with the role.

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
  // fetch them in parallel.
  const [modules, repoAssignments] = await Promise.all([
    ClassmojiService.module.listForClassroom(classSlug, { includeUnpublished: isStaff }),
    ClassmojiService.helper.findAllAssignmentsForStudent(userId, classSlug),
  ]);

  // The student's own repo-assignments power submission status / issue links.
  const raByAssignmentId: Record<string, (typeof repoAssignments)[number]> = {};
  repoAssignments.forEach(ra => {
    raByAssignmentId[ra.assignment_id] = ra;
  });

  return {
    enabled: true as const,
    isStaff,
    modules,
    raByAssignmentId,
    slidesUrl: process.env.SLIDES_URL || 'http://localhost:6500',
    pagesUrl: process.env.PAGES_URL || 'http://localhost:7100',
    classSlug,
  };
};

type LoadedModules = Extract<Awaited<ReturnType<typeof loader>>, { enabled: true }>['modules'];

// Build each module's rows in the component — node objects hold JSX, which a
// loader cannot serialize, so the loader only returns plain data. One leaf per
// item: the module's assignments (a REPO one links to the viewer's own issue
// and shows their submission state; quiz and form ones open the quiz or form)
// and its pages and slides.
const buildModuleLeaves = (
  module: LoadedModules[number],
  raByAssignmentId: Record<string, AnyRepoAssignment>,
  ctx: StudentTreeCtx
): ModuleTreeNode[] => {
  const leaves: ModuleTreeNode[] = [];

  for (const a of module.assignments) {
    if (a.type === 'REPO') {
      // The row itself is the link; the nested "Open issue" action and the
      // attached-resource children belong to the deeper staff tree only.
      const leaf = buildAssignmentLeaf(a, raByAssignmentId[String(a.id)], ctx, 0);
      leaves.push({ ...leaf, actionNode: undefined, children: undefined });
    } else if (a.type === 'QUIZ' && a.quiz) {
      leaves.push(
        ...resourceLeaves(
          { quizzes: [{ id: a.quiz.id, name: a.title, status: a.quiz.status }] },
          0,
          `asg-${a.id}`,
          ctx
        )
      );
    } else if (a.type === 'FORM' && a.form) {
      leaves.push(
        ...resourceLeaves(
          {
            forms: [
              {
                id: a.form.id,
                title: a.title,
                slug: a.form.slug,
                status: a.form.status,
                access: 'PUBLIC',
                closes_at: a.student_deadline,
              },
            ],
          },
          0,
          `asg-${a.id}`,
          ctx
        )
      );
    }
  }

  for (const item of module.items) {
    switch (item.item_type) {
      case 'PAGE':
        if (item.page)
          leaves.push(...resourceLeaves({ pages: [{ page: item.page }] }, 0, `mi-${item.id}`, ctx));
        break;
      case 'SLIDE':
        if (item.slide)
          leaves.push(
            ...resourceLeaves({ slides: [{ slide: item.slide }] }, 0, `mi-${item.id}`, ctx)
          );
        break;
      case 'QUIZ':
        if (item.quiz)
          leaves.push(
            ...resourceLeaves(
              { quizzes: [{ id: item.quiz.id, name: item.quiz.name }] },
              0,
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
          leaves.push(
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
              0,
              `mi-${item.id}`,
              ctx
            )
          );
        break;
      // Legacy pointer rows; a repository reaches a module only through its
      // assignments now.
      case 'REPOSITORY':
        break;
    }
  }

  return leaves;
};

const StudentModules = ({ loaderData }: Route.ComponentProps) => {
  // Hooks first: they must run on every render, including the disabled early
  // return below.
  const rolePrefix = useLocation().pathname.split('/')[1];
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

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

  const { modules, raByAssignmentId, slidesUrl, pagesUrl, classSlug, isStaff } = loaderData;
  // Served under every prefix this route's gate allows, so resource links stay
  // on the prefix the viewer arrived on. `isStaff` is the loader's own flag —
  // note it travels SEPARATELY from rolePrefix, which is only the URL: a student
  // under /teacher is still a student, and gets no draft chips because the
  // loader gave them no drafts to chip.
  const ctx: StudentTreeCtx = { classSlug, slidesUrl, pagesUrl, rolePrefix, isStaff };
  const allCollapsed = modules.length > 0 && modules.every(m => collapsed.has(m.id));

  return (
    <div className="min-h-full">
      <div className="flex items-center justify-between gap-3 mt-2 mb-4">
        <h1 className="text-lg font-semibold text-ink-1">Modules</h1>
        {modules.length > 1 && (
          <Button
            size="small"
            onClick={() => setCollapsed(allCollapsed ? new Set() : new Set(modules.map(m => m.id)))}
          >
            {allCollapsed ? 'Expand all' : 'Collapse all'}
          </Button>
        )}
      </div>

      {modules.length === 0 ? (
        <div className="rounded-2xl bg-panel ring-1 ring-line p-8 text-center">
          <h3 className="text-lg font-semibold text-ink-1">No modules yet</h3>
          <p className="text-sm text-ink-3 mt-1">
            Modules will appear here once your instructor publishes them.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {modules.map((m, index) => (
            <StudentModuleCard
              key={m.id}
              module={m}
              index={index}
              leaves={buildModuleLeaves(
                m,
                raByAssignmentId as Record<string, AnyRepoAssignment>,
                ctx
              )}
              expanded={!collapsed.has(m.id)}
              onToggle={() =>
                setCollapsed(prev => {
                  const next = new Set(prev);
                  if (next.has(m.id)) next.delete(m.id);
                  else next.add(m.id);
                  return next;
                })
              }
              isStaff={isStaff}
            />
          ))}
        </div>
      )}
    </div>
  );
};

export default StudentModules;
