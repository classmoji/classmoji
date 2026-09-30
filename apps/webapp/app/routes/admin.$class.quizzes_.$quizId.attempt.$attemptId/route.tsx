import { useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router';
import { Drawer, ConfigProvider, theme, Modal } from 'antd';
import { useRouteDrawer, useDarkMode } from '~/hooks';
import { QuizAttemptInterface } from '~/components';
import { assertClassroomAccess } from '~/utils/helpers';
import { quizzesVisibleOrThrow } from '~/utils/classroomProFlag.server';
import { attemptDrawerView, quizDrawerView } from '~/utils/quizPayloads';
import { isTriggerChatAttempt } from '~/utils/quizRuntime.server';
import type { Route } from './+types/route';

export async function loader({ params, request }: Route.LoaderArgs) {
  const { ClassmojiService, QuizAttemptNotFoundError } = await import('@classmoji/services');
  const classSlug = params.class!;
  const quizId = params.quizId!;
  const attemptId = params.attemptId!;

  // 1. Authenticate and authorize (instructors only)
  const {
    userId,
    classroom,
    membership: _membership,
  } = await assertClassroomAccess({
    request,
    classroomSlug: classSlug,
    allowedRoles: ['OWNER', 'TEACHER', 'ASSISTANT'],
    resourceType: 'QUIZ_ATTEMPT',
    attemptedAction: 'view_student_attempt',
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
  // land on the same 404 — a foreign id tells the caller nothing. Only that
  // one error becomes a 404; anything else the query raises still surfaces.
  const attemptData = await ClassmojiService.quizAttempt
    .findWithMessages(attemptId)
    .catch((error: unknown) => {
      if (error instanceof QuizAttemptNotFoundError) return null;
      throw error;
    });
  if (!attemptData?.attempt || attemptData.attempt.quiz_id.toString() !== quiz.id.toString()) {
    throw new Response('Attempt not found', { status: 404 });
  }

  // 4. Any attempt OF THIS QUIZ is readable here, whoever sat it: staff read
  // their own students' transcripts, so there is no ownership check. Step 2
  // binds the quiz to the authorized classroom and step 3 binds the attempt to
  // that quiz, which is what keeps "any attempt" inside this classroom.

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

  // 7. Get student name for display
  const studentName =
    attemptData.attempt.user?.name || attemptData.attempt.user?.login || 'Student';

  // 8. A chat-runtime attempt's transcript, projected as its student sees it
  // (hidden rows and internal parts removed), plus the answer each feedback
  // was written against (`expected_answer`) for staff reading someone else's
  // attempt. Its raw rows are never sent. Only the attempt's owner drives its
  // chat session, and gets exactly what that session streamed.
  const isChatAttempt = isTriggerChatAttempt(attemptData.attempt);
  const viewerOwnsAttempt = attemptData.attempt.user_id.toString() === userId.toString();
  const transcript = isChatAttempt
    ? await ClassmojiService.quizChat.loadTranscriptForViewer(
        attemptData.attempt.id,
        viewerOwnsAttempt ? 'student' : 'staff'
      )
    : null;

  // 9. Send only what the drawer and QuizAttemptInterface read — see
  // ~/utils/quizPayloads. Both rows arrive joined to much more: the attempt to
  // its user, quiz and classroom; the quiz to every attempt and its user.
  return {
    quiz: quizDrawerView(quiz),
    attempt: attemptDrawerView(attemptData.attempt),
    // Use unified messages from getAttemptWithMessages (ai-agent owns persistence)
    messages: isChatAttempt ? [] : attemptData.messages || [],
    transcript,
    viewerOwnsAttempt,
    userLogin: attemptData.attempt.user?.login || null,
    userImage: attemptData.attempt.user?.image || null,
    studentName,
    isAdmin: true,
    readOnly,
    showTimestamps: true, // Show timestamps for admin review
    focusMetrics,
  };
}

export default function AdminQuizAttemptViewDrawer({ loaderData }: Route.ComponentProps) {
  const data = loaderData;
  const { opened } = useRouteDrawer({});
  const { isDarkMode } = useDarkMode();
  const navigate = useNavigate();
  const { class: classSlug, quizId } = useParams();
  // Served under every prefix this route's gate allows (/admin, /teacher and /assistant).
  const rolePrefix = useLocation().pathname.split('/')[1];
  const [showConfirm, setShowConfirm] = useState(false);

  const navigateAway = () => {
    navigate(`/${rolePrefix}/${classSlug}/quizzes/${quizId}`);
  };

  const handleClose = () => {
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
            <span style={{ marginLeft: 8, fontSize: '14px', opacity: 0.7 }}>
              - {data.studentName}
            </span>
            {data.readOnly && (
              <span style={{ marginLeft: 8, fontSize: '14px', opacity: 0.7 }}>(Completed)</span>
            )}
          </div>
        }
        open={opened}
        onClose={handleClose}
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
        title="Leave Quiz?"
        open={showConfirm}
        onOk={handleConfirmLeave}
        onCancel={() => setShowConfirm(false)}
        okText="Yes, Leave"
        cancelText="Continue Quiz"
        okButtonProps={{ danger: true }}
      >
        <p>This quiz is still in progress. Are you sure you want to leave?</p>
        <p style={{ fontSize: '13px', opacity: 0.7 }}>
          Progress has been saved and can be resumed later.
        </p>
      </Modal>
    </ConfigProvider>
  );
}
