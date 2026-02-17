import { ClassmojiService } from '@classmoji/services';
import { requireClassroomTeachingTeam } from '~/utils/routeAuth.server';
import { PageHeader } from '~/components';
import RepositoryAssignmentsTable from './RepositoryAssignmentsTable';

export const loader = async ({ request, params }) => {
  const { class: classSlug } = params;
  const { userId, classroom } = await requireClassroomTeachingTeam(request, classSlug);
  const assignedGraderItems = await ClassmojiService.repositoryAssignmentGrader.findAssignedByGrader(
    userId,
    classroom.id
  );
  const myRepositoryAssignments = assignedGraderItems.map(item => item.repository_assignment);
  const modules = await ClassmojiService.module.findByClassroomSlug(classSlug);

  const allRepositoryAssignments = await ClassmojiService.repositoryAssignment.findByClassroomId(classroom.id);

  const emojiMappings = await ClassmojiService.emojiMapping.findByClassroomId(classroom.id);

  return { allRepositoryAssignments, myRepositoryAssignments, modules, emojiMappings };
};

const AssistantGrading = ({ loaderData }) => {
  const { myRepositoryAssignments, modules, allRepositoryAssignments, emojiMappings } = loaderData;

  return (
    <div>
      <PageHeader title="Grading" routeName="grading" />
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
