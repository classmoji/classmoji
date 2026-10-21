import { useMemo, useState } from 'react';
import { data as reply, useNavigate, useParams, useLocation } from 'react-router';
import { Drawer, ConfigProvider, theme, Modal } from 'antd';
import type { Route } from './+types/route';
import { useRouteDrawer, useDarkMode } from '~/hooks';
import { QuizAttemptInterface } from '~/components';
import { useAskMojiAttempt } from '~/components/features/ask-moji/viewing';
import {
  QuizResultProvider,
  type QuizResultSlots,
} from '~/components/features/quiz/QuizResultContext';
import {
  QuizRegradeButton,
  QuizStudentGradeNotes,
} from '~/components/features/quiz/QuizStudentRegrade';
import {
  addClassroomAuditLog,
  assertClassroomAccess,
  assertClassroomMutationAllowed,
  requireStudentAccess,
} from '~/utils/helpers';
import { quizzesVisibleOrThrow } from '~/utils/classroomProFlag.server';
import {
  attemptDrawerView,
  attemptGradeView,
  chatActivityView,
  instructorCommentView,
  quizDrawerView,
  studentQuizRegradeView,
} from '~/utils/quizPayloads';
import { isTriggerChatAttempt } from '~/utils/quizRuntime.server';
import { closeIfExpired } from '~/utils/quizAttemptExpiry.server';

export async function loader({ params, request }: Route.LoaderArgs) {
  const { ClassmojiService, QuizAttemptNotFoundError } = await import('@classmoji/services');
  const classSlug = params.class!;
  const quizId = params.quizId!;
  const attemptId = params.attemptId!;

  // 1. Authenticate and authorize
  const { userId, classroom, membership } = await assertClassroomAccess({
    request,
    classroomSlug: classSlug,
    allowedRoles: ['STUDENT', 'ASSISTANT', 'TEACHER', 'OWNER'],
    resourceType: 'QUIZ_ATTEMPT',
    attemptedAction: 'view',
  });

  // A classroom without quizzes (not Pro, or switched off) has no attempt to
  // show: the same 404 as the list, before anything is read. A failed lookup
  // throws to the error page rather than answering 404.
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
  // confirmed to exist by a 403. Only that one error becomes a 404; anything
  // else the query raises still surfaces, rather than telling a student their
  // attempt is gone because the database was briefly unreachable.
  let attemptData = await ClassmojiService.quizAttempt
    .findWithMessages(attemptId)
    .catch((error: unknown) => {
      if (error instanceof QuizAttemptNotFoundError) return null;
      throw error;
    });
  if (!attemptData?.attempt || attemptData.attempt.quiz_id.toString() !== quiz.id.toString()) {
    throw new Response('Attempt not found', { status: 404 });
  }

  // 4. Verify ownership (students can only view their own attempts). Staff read
  // any attempt OF THIS QUIZ without owning it, which is only inside the
  // authorized classroom because step 2 binds the quiz to it and step 3 binds
  // the attempt to that quiz.
  const isInstructor = membership
    ? ['OWNER', 'ASSISTANT', 'TEACHER'].includes(membership.role)
    : false;
  if (!isInstructor && attemptData.attempt.user_id.toString() !== userId.toString()) {
    throw new Response('Unauthorized', { status: 403 });
  }

  // A chat attempt past its session deadline takes no more turns: it is
  // closed now with the results recorded so far, and read again, so it shows
  // as completed rather than as a chat that can never continue. Only after
  // step 4: the caller owns it, or is staff of its quiz.
  if (
    membership &&
    (await closeIfExpired(attemptData.attempt, {
      userId: String(userId),
      role: membership.role,
      surface:
        attemptData.attempt.user_id.toString() === userId.toString()
          ? 'own_attempt_view'
          : 'staff_attempt_view',
    }))
  ) {
    attemptData = await ClassmojiService.quizAttempt.findWithMessages(attemptId);
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

  // 7. A chat-runtime attempt's transcript, projected (hidden rows and
  // internal parts removed). Its raw rows are never sent. Only the attempt's
  // owner drives its chat session, and gets exactly what that session
  // streamed; staff reading someone else's attempt also get the answer each
  // feedback was written against (`expected_answer`).
  const isChatAttempt = isTriggerChatAttempt(attemptData.attempt);
  const viewerOwnsAttempt = attemptData.attempt.user_id.toString() === userId.toString();
  const transcript = isChatAttempt
    ? await ClassmojiService.quizChat.loadTranscriptForViewer(
        attemptData.attempt.id,
        isInstructor && !viewerOwnsAttempt ? 'staff' : 'student'
      )
    : null;

  // Staff reading someone else's attempt here (step 1 admits them; the staff
  // prefixes have their own route, but this URL is open to them too) is a read
  // of another person's data, so it is audited exactly as the staff attempt
  // route (admin.$class.quizzes_.$quizId.attempt.$attemptId) audits it: one VIEW
  // row, on either runtime, naming the classroom the gate authorized and the
  // role it enforced. Steps 2 and 3 bind the attempt to that classroom. A
  // student or staff member reading their own attempt is not logged; a
  // refused or 404 read never gets here. Repeated loads within the audit
  // service's dedup window fold into one row.
  if (isInstructor && !viewerOwnsAttempt) {
    await addClassroomAuditLog({
      classroomId: classroom.id,
      userId: String(userId),
      role: membership?.role,
      action: 'VIEW',
      resourceType: 'QUIZ_ATTEMPT',
      resourceId: attemptData.attempt.id.toString(),
      metadata: {
        tool: 'web:quiz_attempt.view',
        quiz_id: quiz.id.toString(),
        student_id: attemptData.attempt.user_id.toString(),
      },
    });
  }

  // A chat attempt's message limit: the messages it still admits (the chat's
  // countdown) and whether the server submitted it at the limit (the results
  // say so).
  const messageLimit = isChatAttempt
    ? await ClassmojiService.quizChat.messageLimitOf(attemptData.attempt.id)
    : null;

  // 8. A completed attempt's grade as the classroom's emoji (E3; the scale is
  // this classroom's, the one the gate resolved), and for the student who sat
  // it: the instructor's comment, their regrade/resubmit requests on it, and
  // whether they may ask (D7: not while one is in review).
  const result = readOnly
    ? await loadStudentResult({
        classroom,
        quiz,
        attempt: attemptData.attempt,
        ownerIsStudent: viewerOwnsAttempt && !isInstructor,
      })
    : null;

  // 9. Send only what the drawer and QuizAttemptInterface read — see
  // ~/utils/quizPayloads. Both rows arrive joined to much more: the attempt to
  // its user, quiz and classroom; the quiz to every attempt and its user, and
  // its prompts.
  return {
    quiz: quizDrawerView(quiz),
    attempt: attemptDrawerView(attemptData.attempt, {
      endedBy: messageLimit?.endedBy ?? null,
    }),
    // Use unified messages from getAttemptWithMessages (ai-agent owns persistence)
    messages: isChatAttempt ? [] : attemptData.messages || [],
    transcript,
    // The opening was admitted (its hidden row is stored), even when its reply
    // is not saved yet: a second tab joins it rather than beginning again.
    chatStarted: isChatAttempt && (attemptData.messages?.length ?? 0) > 0,
    // When the attempt last admitted a turn, as timestamps only: an opening
    // admitted longer ago than a turn can run, with nothing saved, is lost.
    chatActivity: isChatAttempt ? chatActivityView(attemptData.attempt) : null,
    // How many more messages an open chat attempt admits: a count only.
    messagesLeft: messageLimit && !readOnly ? messageLimit.messagesLeft : null,
    viewerOwnsAttempt,
    userLogin: attemptData.attempt.user?.login || null,
    userImage: attemptData.attempt.user?.image || null,
    isAdmin: isInstructor,
    readOnly,
    showTimestamps: false,
    focusMetrics,
    org: classSlug,
    result,
  };
}

/**
 * A completed attempt's result-panel extras. `ownerIsStudent`: the viewer sat
 * it as a student (lateness, the comment and the requests are theirs);
 * otherwise only the grade. Every id comes from rows already bound to the
 * authorized classroom; requests are read by attempt AND student AND classroom.
 */
const loadStudentResult = async ({
  classroom,
  quiz,
  attempt,
  ownerIsStudent,
}: {
  classroom: { id: string; settings?: { late_penalty_points_per_hour?: unknown } | null };
  quiz: { assignment?: { id: string; student_deadline: Date | string | null } | null };
  attempt: {
    id: string;
    user_id: string;
    attempt_number?: number | null;
    started_at: Date | string;
    completed_at: Date | string | null;
    partial_credit_percentage: number | null;
    adjusted_emoji?: string | null;
    instructor_comment?: string | null;
    adjusted_by_id?: string | null;
    adjusted_at?: Date | string | null;
  };
  ownerIsStudent: boolean;
}) => {
  const { ClassmojiService } = await import('@classmoji/services');
  const assignment = quiz.assignment ?? null;
  const late = ownerIsStudent && assignment?.student_deadline;
  const [emojiScale, extensionHours, adjustedBy, requests] = await Promise.all([
    ClassmojiService.emojiMapping.findScaleByClassroomId(classroom.id),
    late
      ? ClassmojiService.quizGradeItems
          .netQuizExtensionHours({
            classroomId: classroom.id,
            studentId: attempt.user_id,
            assignmentIds: [assignment.id],
          })
          .then(hours => hours.get(assignment.id) ?? 0)
      : 0,
    ownerIsStudent && attempt.instructor_comment && attempt.adjusted_by_id
      ? ClassmojiService.user.findById(attempt.adjusted_by_id)
      : null,
    ownerIsStudent
      ? ClassmojiService.regradeRequest.findMany({
          quiz_attempt_id: attempt.id,
          student_id: attempt.user_id,
          classroom_id: classroom.id,
        })
      : [],
  ]);
  const penalty: unknown = classroom.settings?.late_penalty_points_per_hour;
  return {
    grade: attemptGradeView({
      attempt,
      emojiScale,
      late: late
        ? {
            studentDeadline: assignment.student_deadline,
            extensionHours: Math.max(0, extensionHours),
            latePenaltyPerHour: typeof penalty === 'number' ? penalty : 0,
          }
        : null,
    }),
    attemptNumber: typeof attempt.attempt_number === 'number' ? attempt.attempt_number : null,
    canRequest: ownerIsStudent,
    comment: ownerIsStudent
      ? instructorCommentView({
          instructor_comment: attempt.instructor_comment,
          adjusted_at: attempt.adjusted_at,
          adjusted_by: adjustedBy ? { name: adjustedBy.name } : null,
        })
      : null,
    regrade: studentQuizRegradeView(requests),
  };
};

/**
 * The student's regrade/resubmit request on this attempt (E4, D7). STUDENT
 * only. The attempt is the one in the URL, bound to this classroom's quiz;
 * the service takes the student from the session and refuses an attempt
 * that is not theirs or not completed, returns the open request when there
 * already is one, and writes the audit row (`data.tool` names this surface).
 */
export async function action({ params, request }: Route.ActionArgs) {
  const { ClassmojiService, QuizGradeError } = await import('@classmoji/services');
  const quizId = params.quizId!;
  const attemptId = params.attemptId!;
  const { userId, classroom, membership } = await requireStudentAccess(request, params.class!, {
    resourceType: 'REGRADE_REQUESTS',
    action: 'request_quiz_regrade',
    metadata: { quiz_id: quizId, attempt_id: attemptId },
  });
  assertClassroomMutationAllowed({ status: classroom.status, role: membership!.role });

  if (!(await quizzesVisibleOrThrow(classroom.id))) {
    throw new Response('Not Found', { status: 404 });
  }

  // The quiz is this classroom's, and the attempt is that quiz's: a foreign
  // id is a 404 before anything is written.
  const quiz = await ClassmojiService.quiz.findById(quizId);
  if (!quiz || String(quiz.classroom_id) !== String(classroom.id)) {
    throw new Response('Quiz not found', { status: 404 });
  }
  const attempt = await ClassmojiService.quizAttempt.findById(attemptId);
  if (!attempt || String(attempt.quiz_id) !== String(quiz.id)) {
    throw new Response('Attempt not found', { status: 404 });
  }

  const body = (await request.json().catch(() => null)) as {
    _action?: unknown;
    comment?: unknown;
  } | null;
  if (body?._action !== 'requestRegrade') {
    return reply({ error: 'Unknown action' }, { status: 400 });
  }

  try {
    const { created } = await ClassmojiService.regradeRequest.createForQuizAttempt({
      attemptId: attempt.id,
      comment: typeof body.comment === 'string' ? body.comment : '',
      actorUserId: userId,
      tool: 'web:quiz_attempt.request_regrade',
    });
    return { ok: true, created };
  } catch (error) {
    if (error instanceof QuizGradeError) {
      return reply({ error: error.message }, { status: error.status });
    }
    throw error;
  }
}

export default function StudentQuizAttemptDrawer({ loaderData }: Route.ComponentProps) {
  const data = loaderData;
  useAskMojiAttempt({
    quizId: data.quiz.id,
    quizName: data.quiz.name,
    readOnly: data.readOnly,
    viewerOwnsAttempt: data.viewerOwnsAttempt,
  });
  const { opened } = useRouteDrawer({});
  const { isDarkMode } = useDarkMode();
  const navigate = useNavigate();
  const { class: classSlug } = useParams();
  const location = useLocation();
  const [showConfirm, setShowConfirm] = useState(false);

  // Derive role prefix from current URL (e.g., /student or /assistant)
  const rolePrefix = location.pathname.split('/')[1];

  // The results panel's grade and the student's blocks (see QuizResultContext).
  const result = data.result;
  const slots = useMemo<QuizResultSlots | null>(
    () =>
      result
        ? {
            grade: result.grade,
            headerExtra: result.canRequest ? (
              <QuizRegradeButton
                quizName={data.quiz.name}
                attemptNumber={result.attemptNumber}
                regrade={result.regrade}
              />
            ) : null,
            beforeResults: (
              <QuizStudentGradeNotes
                comment={result.comment}
                regrade={result.regrade}
                currentEmoji={result.grade?.emoji ?? null}
              />
            ),
          }
        : null,
    [result, data.quiz.name]
  );

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
        <QuizResultProvider value={slots}>
          <QuizAttemptInterface {...data} onClose={handleClose} isVisible={opened} />
        </QuizResultProvider>
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
