import type { Route } from './+types/route';
import { ClassmojiService } from '@classmoji/services';
import { requireClassroomTeachingTeam } from '~/utils/routeAuth.server';
import RepositoryAssignmentsTable from './RepositoryAssignmentsTable';

export const loader = async ({ request, params }: Route.LoaderArgs) => {
  const { class: classSlug } = params;
  // Named so a denial is identifiable rather than the shared default
  // 'TEACHING_RESOURCE'/'access'. Served under /assistant and /teacher alike,
  // and the name describes the resource rather than the prefix.
  const { userId, classroom } = await requireClassroomTeachingTeam(request, classSlug!, {
    resourceType: 'GRADING_QUEUE',
    action: 'view_grading_queue',
  });
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
