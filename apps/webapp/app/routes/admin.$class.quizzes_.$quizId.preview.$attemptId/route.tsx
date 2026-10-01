import { useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router';
import { Drawer, ConfigProvider, theme, Modal } from 'antd';
import { useRouteDrawer, useDarkMode } from '~/hooks';
import { QuizAttemptInterface } from '~/components';
import { assertClassroomAccess } from '~/utils/helpers';
import { quizzesVisibleOrThrow } from '~/utils/classroomProFlag.server';
import { attemptDrawerView, chatActivityView, quizDrawerView } from '~/utils/quizPayloads';
import { isTriggerChatAttempt } from '~/utils/quizRuntime.server';
import type { Route } from './+types/route';

export async function loader({ params, request }: Route.LoaderArgs) {
  const { ClassmojiService, QuizAttemptNotFoundError } = await import('@classmoji/services');
  const classSlug = params.class!;
  const quizId = params.quizId!;
  const attemptId = params.attemptId!;

  // 1. Authenticate and authorize (instructors only)
  const { userId, classroom } = await assertClassroomAccess({
    request,
    classroomSlug: classSlug,
    allowedRoles: ['OWNER', 'TEACHER', 'ASSISTANT'],
    resourceType: 'QUIZ_PREVIEW',
    attemptedAction: 'preview',
  });

  if (!(await quizzesVisibleOrThrow(classroom.id))) {
    throw new Response('Not Found', { status: 404 });
  }

  // 2. Fetch quiz
  const quiz = await ClassmojiService.quiz.findById(quizId);
  if (!quiz || quiz.classroom_id.toString() !== classroom.id.toString()) {
    throw new Response('Quiz not found', { status: 404 });
  }

  // 3. Fetch attempt with messages, bound to the quiz resolved above.
  // `findWithMessages` resolves an attempt by id alone and throws when there is
  // none, so both an id naming nothing and an id naming another quiz's attempt
  // land on the same 404 — checked before ownership, so a foreign id is never
  // confirmed to exist. Only that one error becomes a 404; anything else the
  // query raises still surfaces.
  const attemptData = await ClassmojiService.quizAttempt
    .findWithMessages(attemptId)
    .catch((error: unknown) => {
      if (error instanceof QuizAttemptNotFoundError) return null;
      throw error;
    });
  if (!attemptData?.attempt || attemptData.attempt.quiz_id.toString() !== quiz.id.toString()) {
    throw new Response('Attempt not found', { status: 404 });
  }

  // 4. Verify this is the admin's own attempt (admins preview as themselves)
  if (attemptData.attempt.user_id.toString() !== userId.toString()) {
    throw new Response('Unauthorized - This is not your preview attempt', { status: 403 });
  }

  // 5. Calculate focus metrics for completed attempts
  const totalMs = Number(attemptData.attempt.total_duration_ms || 0);
  const unfocusedMs = Number(attemptData.attempt.unfocused_duration_ms || 0);
  const focusedMs = Math.max(0, totalMs - unfocusedMs);
  const focusPercentage = totalMs > 0 ? Math.round((focusedMs / totalMs) * 100) : 100;

  const focusMetrics = {
    totalMs,
    focusedMs,
    percentage: focusPercentage,
  };

  // 6. Determine if read-only (completed attempt)
  const readOnly = Boolean(attemptData.attempt.completed_at);

  // 7. A chat-runtime attempt's transcript, projected exactly as a student
  // sees theirs (hidden rows and internal parts removed, and no
  // `expected_answer`). Its raw rows are never sent. Step 4 already made the
  // caller its owner, who drives its chat session.
  const isChatAttempt = isTriggerChatAttempt(attemptData.attempt);
  const transcript = isChatAttempt
    ? await ClassmojiService.quizChat.loadTranscriptForViewer(attemptData.attempt.id, 'student')
    : null;

  // Send only what the drawer and QuizAttemptInterface read — see
  // ~/utils/quizPayloads. Both rows arrive joined to much more: the attempt to
  // its user, quiz and classroom; the quiz to every attempt and its user.
  return {
    quiz: quizDrawerView(quiz),
    attempt: attemptDrawerView(attemptData.attempt),
    // Use unified messages from getAttemptWithMessages (ai-agent owns persistence)
    messages: isChatAttempt ? [] : attemptData.messages || [],
    transcript,
    // The opening was admitted (its hidden row is stored), even when its reply
    // is not saved yet: a second tab joins it rather than beginning again.
    chatStarted: isChatAttempt && (attemptData.messages?.length ?? 0) > 0,
    // When the attempt last admitted a turn, as timestamps only: an opening
    // admitted longer ago than a turn can run, with nothing saved, is lost.
    chatActivity: isChatAttempt ? chatActivityView(attemptData.attempt) : null,
    viewerOwnsAttempt: true,
    userLogin: attemptData.attempt.user?.login || null,
    userImage: attemptData.attempt.user?.image || null,
    isAdmin: true,
    readOnly,
    showTimestamps: false,
    focusMetrics,
  };
}

export default function AdminQuizPreviewDrawer({ loaderData }: Route.ComponentProps) {
  const data = loaderData;
  const { opened } = useRouteDrawer({});
  const { isDarkMode } = useDarkMode();
  const navigate = useNavigate();
  const { class: classSlug, quizId } = useParams();
  // Served under every prefix this route's gate allows (/admin, /teacher and /assistant).
  const rolePrefix = useLocation().pathname.split('/')[1];
  const [showConfirm, setShowConfirm] = useState(false);

  const navigateAway = (newAttemptId?: string) => {
    if (newAttemptId) {
      // If a new attempt was created (from restart), navigate to it
      navigate(`/${rolePrefix}/${classSlug}/quizzes/${quizId}/preview/${newAttemptId}`);
    } else {
      // Otherwise go back to quiz detail page
      navigate(`/${rolePrefix}/${classSlug}/quizzes/${quizId}`);
    }
  };

  const handleClose = (newAttemptId?: string) => {
    // If navigating to a new attempt, no confirmation needed
    if (newAttemptId) {
      navigateAway(newAttemptId);
      return;
    }
    // If quiz is not complete, show confirmation
    if (!data.readOnly) {
      setShowConfirm(true);
    } else {
      navigateAway();
    }
  };

  const handleConfirmLeave = () => {
    setShowConfirm(false);
    navigateAway();
  };

  return (
    <ConfigProvider
      theme={{
        algorithm: isDarkMode ? theme.darkAlgorithm : theme.defaultAlgorithm,
      }}
    >
      <Drawer
        title={
          <div>
            <span style={{ fontSize: '20px', marginRight: 8 }}>🧑‍💻</span>
            {data.quiz.name}
            <span style={{ marginLeft: 8, fontSize: '14px', opacity: 0.7 }}>(Preview)</span>
            {data.readOnly && (
              <span style={{ marginLeft: 8, fontSize: '14px', opacity: 0.7 }}>(Completed)</span>
            )}
          </div>
        }
        open={opened}
        onClose={() => handleClose()}
        maskClosable={false}
        width="90%"
        styles={{
          header: {
            backgroundColor: isDarkMode ? '#1f2937' : '#f9f9f9',
          },
          body: {
            padding: '24px',
            height: 'calc(100vh - 55px)',
            overflow: 'hidden',
          },
        }}
      >
        <QuizAttemptInterface {...data} onClose={handleClose} isVisible={opened} />
      </Drawer>

      <Modal
        title="Leave Preview?"
        open={showConfirm}
        onOk={handleConfirmLeave}
        onCancel={() => setShowConfirm(false)}
        okText="Yes, Leave"
        cancelText="Continue Preview"
        okButtonProps={{ danger: true }}
      >
        <p>This preview is still in progress. Are you sure you want to leave?</p>
        <p style={{ fontSize: '13px', opacity: 0.7 }}>
          Progress has been saved and can be resumed later.
        </p>
      </Modal>
    </ConfigProvider>
  );
}
