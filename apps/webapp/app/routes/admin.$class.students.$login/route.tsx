import { ConfigProvider, Modal, Button, theme } from 'antd';
import { IconUser, IconX } from '@tabler/icons-react';

import { useRouteDrawer, useDarkMode } from '~/hooks';
import { ClassmojiService } from '@classmoji/services';
import SingleStudentView from './SingleStudentView';
import { groupByModule } from '~/utils/helpers.client';
import { addAuditLog } from '~/utils/helpers';
import { requireClassroomAdmin } from '~/utils/routeAuth.server';
import type { Route } from './+types/route';

export const loader = async ({ request, params }: Route.LoaderArgs) => {
  const classSlug = params.class!;
  const login = params.login!;

  const { classroom } = await requireClassroomAdmin(request, classSlug!, {
    resourceType: 'STUDENT_ROSTER',
    action: 'view_student',
  });

  const student = await ClassmojiService.user.findByLogin(login!);
  const repositories = await ClassmojiService.repository.findByClassroomSlug(classSlug!);
  const repositoryAssignments = await ClassmojiService.gitRepoAssignment.findAllForStudent(
    student!.id,
    classSlug!
  );

  const emojiMappings = await ClassmojiService.emojiMapping.findByClassroomId(classroom.id);

  const settings = await ClassmojiService.classroom.getClassroomSettingsForServer(classroom.id);

  const letterGradeMappings = await ClassmojiService.letterGradeMapping.findByClassroomId(
    classroom.id
  );

  const tokenBalance = await ClassmojiService.token.getBalance(classroom.id, student!.id);

  addAuditLog({
    request,
    params,
    action: 'VIEW',
    resourceType: 'STUDENT_GRADES_SCREEN',
    resourceId: String(student!.id),
  });

  return {
    student,
    classroom,
    repositories,
    repositoryAssignments,
    emojiMappings,
    settings,
    letterGradeMappings,
    tokenBalance,
  };
};

const StudentView = ({ loaderData }: Route.ComponentProps) => {
  const {
    student,
    classroom,
    repositories,
    repositoryAssignments,
    emojiMappings,
    settings,
    letterGradeMappings,
    tokenBalance,
  } = loaderData;
  const { close, opened } = useRouteDrawer({});
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
      <Modal
        open={opened}
        onCancel={close}
        title={null}
        footer={null}
        width="95vw"
        centered
        closable={false}
        maskClosable
        destroyOnClose
        styles={{
          content: { padding: 0, borderRadius: 16, overflow: 'hidden', maxWidth: 1100, margin: '0 auto' },
          body: { padding: 0 },
          header: { display: 'none' },
          footer: { display: 'none' },
          wrapper: { maxWidth: '100vw' },
        }}
      >
        <div className="flex items-center justify-between gap-3 px-5 py-3 bg-stone-50 dark:bg-neutral-800/60 border-b border-line">
          <div className="flex items-center gap-2.5 min-w-0">
            <IconUser size={18} strokeWidth={1.75} className="shrink-0 text-ink-3" />
            <div className="min-w-0">
              <div className="text-sm font-semibold text-ink-0 truncate">
                @{student!.login} &mdash; {student!.name}
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={close}
            className="p-1 rounded hover:bg-line text-ink-3 transition-colors border-none bg-transparent cursor-pointer"
          >
            <IconX size={18} />
          </button>
        </div>

        <div className="p-5 sm:p-6 overflow-y-auto max-h-[calc(85vh-48px)]">
          <SingleStudentView
            student={student}
            classroom={classroom}
            repositories={repositories}
            assignmentsByRepository={
              groupByModule(repositoryAssignments) as Parameters<
                typeof SingleStudentView
              >[0]['assignmentsByRepository']
            }
            emojiMappings={emojiMappings}
            settings={settings}
            letterGradeMappings={letterGradeMappings}
            tokenBalance={tokenBalance}
          />
        </div>
      </Modal>
    </ConfigProvider>
  );
};

export default StudentView;
