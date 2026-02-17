import { useState } from 'react';
import { useLoaderData, useNavigate, useParams, useLocation } from 'react-router';
import { Drawer, ConfigProvider, theme, Modal } from 'antd';
import { useRouteDrawer, useDarkMode } from '~/hooks';
import { QuizAttemptInterface } from '~/components';
import { assertClassroomAccess } from '~/utils/helpers';

export async function loader({ params, request }) {
  const { ClassmojiService } = await import('@classmoji/services');
  const { class: classSlug, quizId, attemptId } = params;

  // 1. Authenticate and authorize
  const { userId, classroom, membership } = await assertClassroomAccess({
    request,
    classroomSlug: classSlug,
    allowedRoles: ['STUDENT', 'ASSISTANT', 'OWNER'],
    resourceType: 'QUIZ_ATTEMPT',
    attemptedAction: 'view',
  });

  // 2. Fetch quiz
  const quiz = await ClassmojiService.quiz.findById(quizId);
  if (!quiz || quiz.classroom_id.toString() !== classroom.id.toString()) {
    throw new Response('Quiz not found', { status: 404 });
  }

  // 3. Fetch attempt with messages
  const attemptData = await ClassmojiService.quizAttempt.findWithMessages(attemptId);
  if (!attemptData?.attempt) {
    throw new Response('Attempt not found', { status: 404 });
  }

  // 4. Verify ownership (students can only view their own attempts)
  const isInstructor = ['OWNER', 'ASSISTANT', 'TEACHER'].includes(membership.role);
  if (!isInstructor && attemptData.attempt.user_id.toString() !== userId.toString()) {
    throw new Response('Unauthorized', { status: 403 });
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

  // 7. Strip sensitive fields from attempt before sending to client
  // agent_config may contain API keys - never expose to browser
  // quiz.classroom.settings contains anthropic_api_key, openai_api_key
  const { agent_config, ...attemptWithoutConfig } = attemptData.attempt;
  const safeAttempt = {
    ...attemptWithoutConfig,
    quiz: {
      ...attemptWithoutConfig.quiz,
      classroom: attemptWithoutConfig.quiz?.classroom
        ? { ...attemptWithoutConfig.quiz.classroom, settings: undefined }
        : undefined,
    },
  };

  return {
    quiz,
    attempt: safeAttempt,
    // Use unified messages from getAttemptWithMessages (ai-agent owns persistence)
    messages: attemptData.messages || [],
    userLogin: safeAttempt.user?.login || null,
    isAdmin: isInstructor,
    readOnly,
    showTimestamps: false,
    focusMetrics,
    org: classSlug,
  };
}

export default function StudentQuizAttemptDrawer() {
  const data = useLoaderData();
  const { opened } = useRouteDrawer({});
  const { isDarkMode } = useDarkMode();
  const navigate = useNavigate();
  const { class: classSlug } = useParams();
  const location = useLocation();
  const [showConfirm, setShowConfirm] = useState(false);

  // Derive role prefix from current URL (e.g., /student or /assistant)
  const rolePrefix = location.pathname.split('/')[1];

  const navigateAway = () => {
    navigate(`/${rolePrefix}/${classSlug}/quizzes`);
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
        <p>Your quiz is still in progress. Are you sure you want to leave?</p>
        <p style={{ fontSize: '13px', opacity: 0.7 }}>
          Your progress has been saved and you can resume later.
        </p>
      </Modal>
    </ConfigProvider>
  );
}
