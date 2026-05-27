import type { Route } from './+types/route';
import { ClassmojiService } from '@classmoji/services';
import { requireClassroomTeachingTeam } from '~/utils/routeAuth.server';
import RepositoryAssignmentsTable from './RepositoryAssignmentsTable';

export const loader = async ({ request, params }: Route.LoaderArgs) => {
  const { class: classSlug } = params;
  const { userId, classroom } = await requireClassroomTeachingTeam(request, classSlug!);
  const assignedGraderItems =
    await ClassmojiService.gitRepoAssignmentGrader.findAssignedByGrader(userId, classroom.id);
  const myRepositoryAssignments = assignedGraderItems.map(item => item.git_repo_assignment);
  const repositories = await ClassmojiService.repository.findByClassroomSlug(classSlug!);

  const allRepositoryAssignments = await ClassmojiService.gitRepoAssignment.findByClassroomId(
    classroom.id
  );

  const emojiMappings = await ClassmojiService.emojiMapping.findByClassroomId(classroom.id);

  return { allRepositoryAssignments, myRepositoryAssignments, repositories, emojiMappings };
};

const AssistantGrading = ({ loaderData }: Route.ComponentProps) => {
  const { myRepositoryAssignments, repositories, allRepositoryAssignments, emojiMappings } = loaderData;

  return (
    <div className="min-h-full">
      <RepositoryAssignmentsTable
        allRepositoryAssignments={allRepositoryAssignments}
        repositoryAssignments={myRepositoryAssignments}
        repositories={repositories}
        emojiMappings={emojiMappings}
      />
    </div>
  );
};

export const action = () => {
  return { message: 'Success' };
};

export default AssistantGrading;
