import type { Route } from './+types/route';
import { ClassmojiService } from '@classmoji/services';
import { requireClassroomTeachingTeam } from '~/utils/routeAuth.server';
import RepositoryAssignmentsTable from './RepositoryAssignmentsTable';

export const loader = async ({ request, params }: Route.LoaderArgs) => {
  const { class: classSlug } = params;
  const { userId, classroom } = await requireClassroomTeachingTeam(request, classSlug!);
  const assignedGraderItems =
    await ClassmojiService.repositoryAssignmentGrader.findAssignedByGrader(userId, classroom.id);
  const myRepositoryAssignments = assignedGraderItems.map(item => item.repository_assignment);
  const modules = await ClassmojiService.module.findByClassroomSlug(classSlug!);

  const allRepositoryAssignments = await ClassmojiService.repositoryAssignment.findByClassroomId(
    classroom.id
  );

  const emojiMappings = await ClassmojiService.emojiMapping.findByClassroomId(classroom.id);

  return { allRepositoryAssignments, myRepositoryAssignments, modules, emojiMappings };
};

const AssistantGrading = ({ loaderData }: Route.ComponentProps) => {
  const { myRepositoryAssignments, modules, allRepositoryAssignments, emojiMappings } = loaderData;

  return (
    <div className="min-h-full">
      <RepositoryAssignmentsTable
        allRepositoryAssignments={allRepositoryAssignments}
        repositoryAssignments={myRepositoryAssignments}
        modules={modules}
        emojiMappings={emojiMappings}
      />
    </div>
  );
};

export const action = () => {
  return { message: 'Success' };
};

export default AssistantGrading;
