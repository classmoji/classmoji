import { ConfigProvider, Drawer, Button, theme } from 'antd';
import { IconX } from '@tabler/icons-react';

import { useRouteDrawer, useDarkMode } from '~/hooks';
import { ClassmojiService } from '@classmoji/services';
import SingleStudentView from './SingleStudentView';
import { groupByModule } from '~/utils/helpers.client';
import { addAuditLog } from '~/utils/helpers';
import { requireClassroomAdmin } from '~/utils/routeAuth.server';

export const loader = async ({ request, params }) => {
  const { class: classSlug, login } = params;

  const { classroom } = await requireClassroomAdmin(request, classSlug, {
    resourceType: 'STUDENT_ROSTER',
    action: 'view_student',
  });

  const student = await ClassmojiService.user.findByLogin(login);
  const modules = await ClassmojiService.module.findByClassroomSlug(classSlug);
  const repositoryAssignments = await ClassmojiService.repositoryAssignment.findAllForStudent(
    student.id,
    classSlug
  );

  const emojiMappings = await ClassmojiService.emojiMapping.findByClassroomId(classroom.id);

  const settings = await ClassmojiService.classroom.getClassroomSettingsForServer(classroom.id);

  const letterGradeMappings = await ClassmojiService.letterGradeMapping.findByClassroomId(
    classroom.id
  );

  const tokenBalance = await ClassmojiService.token.getBalance(classroom.id, student.id);

  addAuditLog({
    request,
    params,
    action: 'VIEW',
    resourceType: 'STUDENT_GRADES_SCREEN',
    resourceId: student.id,
  });

  return {
    student,
    classroom,
    modules,
    repositoryAssignments,
    emojiMappings,
    settings,
    letterGradeMappings,
    tokenBalance,
  };
};

const StudentView = ({ loaderData }) => {
  const {
    student,
    classroom,
    modules,
    repositoryAssignments,
    emojiMappings,
    settings,
    letterGradeMappings,
    tokenBalance,
  } = loaderData;
  const { close, opened, width } = useRouteDrawer({});
  const { isDarkMode } = useDarkMode();

  return (
    <ConfigProvider
      theme={{
        algorithm: isDarkMode ? theme.darkAlgorithm : theme.defaultAlgorithm,
        components: {
          Table: {
            headerBg: isDarkMode ? '#1f2937' : '#f9f9f9',
          },
        },
      }}
    >
      <Drawer
        title={` @${student.login} - ${student.name}`}
        opened={opened}
        styles={{
          header: {
            backgroundColor: isDarkMode ? '#1f2937' : '#f9f9f9',
          },
        }}
        headerClassName="p-0"
        onClose={close}
        open={opened}
        width={width}
        closeIcon={<IconX className="text-gray-700 dark:text-gray-300" size={18} />}
        footer={
          <div className="flex justify-end  py-2">
            <Button onClick={close}>Close</Button>
          </div>
        }
      >
        <SingleStudentView
          student={student}
          classroom={classroom}
          modules={modules}
          repositoryAssignmentsGroupedByModule={groupByModule(repositoryAssignments)}
          emojiMappings={emojiMappings}
          settings={settings}
          letterGradeMappings={letterGradeMappings}
          tokenBalance={tokenBalance}
        />
      </Drawer>
    </ConfigProvider>
  );
};

export default StudentView;
