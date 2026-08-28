import { ConfigProvider, Modal, theme } from 'antd';
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

  // One classroom-scoped, role-pinned, projected lookup — the same fix
  // admin.$class.grades.$login already carries.
  //
  // This used to resolve the student with the GLOBAL `user.findByLogin`, which
  // includes every classroom that student belongs to, each one's
  // git_organization row (carrying `access_token` and `github_installation_id`)
  // and each one's owner memberships — and returned the whole graph. There is
  // no entry.server.tsx here, so React Router serialises whatever a loader
  // returns straight into the page.
  const enrollment = await ClassmojiService.classroomMembership.findStudentByLoginInClassroom(
    classroom.id,
    login!
  );

  // No such student in THIS classroom. An unknown login and a login belonging
  // to someone outside the classroom are indistinguishable from here, which is
  // the intent. Previously this dereferenced a null user (`student!.id`) and
  // answered with a 500 — including for a correct login in the wrong case,
  // since the lookup is case-sensitive.
  if (!enrollment) {
    throw new Response('Student not found', { status: 404 });
  }

  const student = {
    id: enrollment.user.id,
    name: enrollment.user.name,
    login: enrollment.user.login,
    school_id: enrollment.user.school_id,
    // The view reads `avatar_url`; the User column is `image`.
    avatar_url: enrollment.user.image,
    image: enrollment.user.image,
  };

  const repositories = await ClassmojiService.repository.findByClassroomSlug(classSlug!);
  const repositoryAssignments = await ClassmojiService.gitRepoAssignment.findAllForStudent(
    student.id,
    classSlug!
  );

  const emojiMappings = await ClassmojiService.emojiMapping.findByClassroomId(classroom.id);

  // Projected, not the raw row. `getClassroomSettingsForServer` is a bare
  // findUnique on ClassroomSettings, which carries `openai_api_key` and
  // `anthropic_api_key` — its name says ForServer, and this loader was
  // returning it to the browser. The grade maths (OrganizationSettings in
  // @classmoji/utils) wants exactly one field.
  const settingsRow = await ClassmojiService.classroom.getClassroomSettingsForServer(classroom.id);
  const settings = {
    late_penalty_points_per_hour: settingsRow?.late_penalty_points_per_hour ?? 0,
  };

  const letterGradeMappings = await ClassmojiService.letterGradeMapping.findByClassroomId(
    classroom.id
  );

  const tokenBalance = await ClassmojiService.token.getBalance(classroom.id, student.id);

  addAuditLog({
    request,
    params,
    action: 'VIEW',
    resourceType: 'STUDENT_GRADES_SCREEN',
    resourceId: String(student.id),
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
          content: {
            padding: 0,
            borderRadius: 16,
            overflow: 'hidden',
            maxWidth: 1100,
            margin: '0 auto',
          },
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
                @{student.login} &mdash; {student.name}
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
