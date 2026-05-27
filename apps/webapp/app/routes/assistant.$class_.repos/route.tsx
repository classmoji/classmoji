import getPrisma from '@classmoji/database';
import type { Route } from './+types/route';
import { requireClassroomTeachingTeam } from '~/utils/routeAuth.server';
import ModuleAccordion from '../student.$class.repos/ModuleAccordion';

export const loader = async ({ params, request }: Route.LoaderArgs) => {
  const { class: classSlug } = params;
  const { classroom } = await requireClassroomTeachingTeam(request, classSlug!);

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

  return {
    repositories,
    repoAssignmentsByAssignmentId: {}, // Assistants don't have personal assignments
    slidesUrl: process.env.SLIDES_URL || 'http://localhost:6500',
    pagesUrl: process.env.PAGES_URL || 'http://localhost:7100',
    classSlug,
  };
};

const AssistantModules = ({ loaderData }: Route.ComponentProps) => {
  const { repositories, repoAssignmentsByAssignmentId, slidesUrl, pagesUrl, classSlug } = loaderData;

  return (
    <div className="min-h-full">
      <h1 className="mt-2 mb-4 text-base font-semibold text-ink-2">
        Repositories
      </h1>

      {repositories.length === 0 ? (
        <div className="rounded-2xl bg-panel ring-1 ring-line p-8 text-center">
          <h3 className="text-base font-semibold text-ink-1">
            No published repositories yet
          </h3>
          <p className="text-sm text-ink-3 mt-1">
            Repositories will appear here once your instructor publishes them.
          </p>
        </div>
      ) : (
        <ModuleAccordion
          repositories={repositories}
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
