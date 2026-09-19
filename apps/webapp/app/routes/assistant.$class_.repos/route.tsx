import getPrisma from '@classmoji/database';
import type { Route } from './+types/route';
import { requireClassroomTeachingTeam } from '~/utils/routeAuth.server';
import ModuleAccordion from '../student.$class.repos/ModuleAccordion';

export const loader = async ({ params, request }: Route.LoaderArgs) => {
  const { class: classSlug } = params;
  // Named so a denial is identifiable rather than the shared default
  // 'TEACHING_RESOURCE'/'access'. 'REPOSITORIES' is the vocabulary the MCP repo
  // tools already write. Served under /assistant and /teacher alike.
  const { classroom } = await requireClassroomTeachingTeam(request, classSlug!, {
    resourceType: 'REPOSITORIES',
    action: 'view_repos',
  });

  // The teaching team sees EVERY repository, assignment and attached resource,
  // published or not — a teacher prepping next term has nothing but drafts, and
  // filtering them out left this page empty for the people who are meant to be
  // building it. This is the same policy the MCP repo tools already apply to
  // staff; drafts are marked as such in the view rather than hidden, so the list
  // is never silently narrower than the classroom itself.
  //
  // Deliberately NO publish/draft `where` anywhere below. The student loader is
  // left alone: its identical-looking filters are what keep drafts off the
  // student surface, and repoDraftPolicy.test.ts fails if either loader is ever
  // copy-pasted onto the other.
  const repositories = await getPrisma().repository.findMany({
    where: { classroom_id: classroom.id },
    include: {
      assignments: {
        include: {
          pages: { include: { page: true }, orderBy: { order: 'asc' } },
          slides: { include: { slide: true }, orderBy: { order: 'asc' } },
        },
        orderBy: { student_deadline: 'asc' },
      },
      pages: { include: { page: true }, orderBy: { order: 'asc' } },
      slides: { include: { slide: true }, orderBy: { order: 'asc' } },
      // `status` is rendered, not just fetched: a DRAFT quiz is annotated in the
      // summary line, the only place this view surfaces quizzes at all.
      quizzes: { select: { id: true, name: true, status: true } },
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
      <h1 className="mt-2 mb-4 text-lg font-semibold text-ink-1">
        Repositories
      </h1>

      {repositories.length === 0 ? (
        // Staff see drafts too, so an empty list here means the classroom has no
        // repositories at all — never "none published yet".
        <div className="rounded-2xl bg-panel ring-1 ring-line p-8 text-center">
          <h3 className="text-lg font-semibold text-ink-1">No repositories yet</h3>
          <p className="text-sm text-ink-3 mt-1">
            Drafts appear here too — this classroom has no repositories at all yet.
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
