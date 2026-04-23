import getPrisma from '@classmoji/database';
import type { Route } from './+types/route';
import { requireClassroomTeachingTeam } from '~/utils/routeAuth.server';
import { ModulesScreen, buildModuleCards } from '~/components/features/modules';

export const loader = async ({ params, request }: Route.LoaderArgs) => {
  const { class: classSlug } = params;
  const { classroom } = await requireClassroomTeachingTeam(request, classSlug!);

  const modules = await getPrisma().module.findMany({
    where: { classroom_id: classroom.id, is_published: true },
    include: {
      assignments: {
        where: { is_published: true },
        select: { id: true, student_deadline: true },
        orderBy: { student_deadline: 'asc' },
      },
    },
    orderBy: { created_at: 'desc' },
  });

  const moduleCards = buildModuleCards(modules, {
    rolePrefix: 'assistant',
    classSlug: classSlug!,
    classroomStart: null,
  });

  return { moduleCards };
};

const AssistantModules = ({ loaderData }: Route.ComponentProps) => {
  const { moduleCards } = loaderData;
  return <ModulesScreen modules={moduleCards} />;
};

export default AssistantModules;
