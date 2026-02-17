import prisma from '@classmoji/database';
import { requireClassroomTeachingTeam } from '~/utils/routeAuth.server';
import { PageHeader } from '~/components';
import ModuleAccordion from '../student.$class.modules/ModuleAccordion';

export const loader = async ({ params, request }) => {
  const { class: classSlug } = params;
  const { classroom } = await requireClassroomTeachingTeam(request, classSlug);

  const modules = await prisma.module.findMany({
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
    },
    orderBy: { created_at: 'desc' },
  });

  return {
    modules,
    repoAssignmentsByAssignmentId: {}, // Assistants don't have personal assignments
    slidesUrl: process.env.SLIDES_URL || 'http://localhost:6500',
    pagesUrl: process.env.PAGES_URL || 'http://localhost:7100',
    classSlug,
  };
};

const AssistantModules = ({ loaderData }) => {
  const { modules, repoAssignmentsByAssignmentId, slidesUrl, pagesUrl, classSlug } = loaderData;

  return (
    <div>
      <PageHeader title="Modules" routeName="modules" />

      {modules.length === 0 ? (
        <div className="text-center py-12 text-gray-500">
          <div className="text-6xl mb-4">📚</div>
          <h3 className="text-xl font-semibold text-gray-700 dark:text-gray-300 mb-2">
            No modules available
          </h3>
          <p className="dark:text-gray-400">Modules will appear here once published</p>
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
