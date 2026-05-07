import getPrisma from '@classmoji/database';
import type { Route } from './+types/route';
import { requireClassroomTeachingTeam } from '~/utils/routeAuth.server';
import ModuleAccordion from '../student.$class.modules/ModuleAccordion';

export const loader = async ({ params, request }: Route.LoaderArgs) => {
  const { class: classSlug } = params;
  const { classroom } = await requireClassroomTeachingTeam(request, classSlug!);

  const modules = await getPrisma().module.findMany({
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

  return {
    modules,
    repoAssignmentsByAssignmentId: {}, // Assistants don't have personal assignments
    slidesUrl: process.env.SLIDES_URL || 'http://localhost:6500',
    pagesUrl: process.env.PAGES_URL || 'http://localhost:7100',
    classSlug,
  };
};

const AssistantModules = ({ loaderData }: Route.ComponentProps) => {
  const { modules, repoAssignmentsByAssignmentId, slidesUrl, pagesUrl, classSlug } = loaderData;

  return (
    <div className="min-h-full">
      <h1 className="mt-2 mb-4 text-base font-semibold text-gray-600 dark:text-gray-400">
        Modules
      </h1>

      {modules.length === 0 ? (
        <div className="rounded-2xl bg-panel ring-1 ring-stone-200 dark:ring-neutral-800 p-8 text-center">
          <h3 className="text-base font-semibold text-gray-800 dark:text-gray-200">
            No published modules yet
          </h3>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
            Modules will appear here once your instructor publishes them.
          </p>
        </div>
      ) : (
        <ModuleAccordion
          modules={modules}
          repoAssignmentsByAssignmentId={repoAssignmentsByAssignmentId}
          classSlug={classSlug}
          slidesUrl={slidesUrl}
          pagesUrl={pagesUrl}
          rolePrefix="assistant"
        />
      )}
    </div>
  );
};

export default AssistantModules;
