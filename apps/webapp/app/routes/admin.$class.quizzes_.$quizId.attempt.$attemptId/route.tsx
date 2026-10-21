import { useMemo, useState } from 'react';
import { data as reply, useLocation, useNavigate, useParams } from 'react-router';
import { Drawer, ConfigProvider, theme, Modal } from 'antd';
import { useRouteDrawer, useDarkMode } from '~/hooks';
import { QuizAttemptInterface } from '~/components';
import { useAskMojiAttempt } from '~/components/features/ask-moji/viewing';
import {
  QuizResultProvider,
  type QuizResultSlots,
} from '~/components/features/quiz/QuizResultContext';
import {
  QuizAttemptGradePanel,
  QuizRegradeRequestBanner,
} from '~/components/features/quiz/QuizAttemptGradePanel';
import { addClassroomAuditLog, assertClassroomAccess } from '~/utils/helpers';
import { requireClassroomTeachingTeam } from '~/utils/routeAuth.server';
import { canMutate, mutationRefusal } from '~/utils/mutationRefusal.server';
import { quizzesVisibleOrThrow } from '~/utils/classroomProFlag.server';
import {
  attemptDrawerView,
  attemptGradeView,
  chatActivityView,
  quizDrawerView,
  staffAttemptGradePanel,
} from '~/utils/quizPayloads';
import { impersonatedBy } from '~/routes/admin.$class.ask-moji/impersonation.server';
import { resolveQuizRequest } from '~/routes/assistant.$class_.regrade-requests/resolveQuizRegrade.server';
import { isTriggerChatAttempt } from '~/utils/quizRuntime.server';
import { closeIfExpired } from '~/utils/quizAttemptExpiry.server';
import type { Route } from './+types/route';

export async function loader({ params, request }: Route.LoaderArgs) {
  const { ClassmojiService, QuizAttemptNotFoundError } = await import('@classmoji/services');
  const classSlug = params.class!;
  const quizId = params.quizId!;
  const attemptId = params.attemptId!;

  // 1. Authenticate and authorize (instructors only)
  const { userId, classroom, membership } = await assertClassroomAccess({
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
  let attemptData = await ClassmojiService.quizAttempt
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
  //
  // A chat attempt past its session deadline takes no more turns: it is
  // closed now with the results recorded so far, and read again, so staff
  // see it completed and scored rather than as a chat that never ends.
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

  // Staff reading someone else's attempt (its transcript, answers and scores)
  // is a read of another person's data, so it is audited, on either runtime,
  // the same way the quiz results page audits its VIEW. The attempt is bound to
  // this classroom by steps 2 and 3, so the row names the classroom the gate
  // authorized and the role it enforced. Reading one's own attempt is not
  // logged. Repeated loads within the audit service's dedup window fold into
  // one row.
  if (!viewerOwnsAttempt) {
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

  // 9. A completed attempt's grade as the classroom's emoji (E1), with the
  // adjust panel's state and any open regrade/resubmit request. The scale is
  // this classroom's, the one the gate resolved. Only a current (accepted)
  // student's attempt can be adjusted; a staff preview shows its grade only.
  const gradePanel = readOnly
    ? await loadGradePanel({
        classroom,
        quiz,
        attempt: attemptData.attempt,
        studentName,
        canEdit: canMutate(classroom, membership?.role) && !viewerOwnsAttempt,
      })
    : null;

  // 10. Send only what the drawer and QuizAttemptInterface read — see
  // ~/utils/quizPayloads. Both rows arrive joined to much more: the attempt to
  // its user, quiz and classroom; the quiz to every attempt and its user.
  return {
    quiz: quizDrawerView(quiz),
    attempt: attemptDrawerView(attemptData.attempt, {
      endedBy: messageLimit?.endedBy ?? null,
      viewer: 'staff',
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
    studentName,
    isAdmin: true,
    readOnly,
    showTimestamps: true, // Show timestamps for admin review
    focusMetrics,
    gradePanel,
  };
}

/**
 * The adjust panel's data for a completed attempt in `classroom`. Every id
 * comes from rows already bound to the authorized classroom (the quiz to the
 * classroom, the attempt to the quiz).
 */
const loadGradePanel = async ({
  classroom,
  quiz,
  attempt,
  studentName,
  canEdit,
}: {
  classroom: { id: string; settings?: { late_penalty_points_per_hour?: unknown } | null };
  quiz: {
    assignment?: { id: string; student_deadline: Date | string | null } | null;
  };
  attempt: {
    id: string;
    user_id: string;
    started_at: Date | string;
    completed_at: Date | string | null;
    partial_credit_percentage: number | null;
    adjusted_emoji: string | null;
    instructor_comment?: string | null;
    adjusted_by_id?: string | null;
    adjusted_at?: Date | string | null;
    comment_by_id?: string | null;
    comment_at?: Date | string | null;
  };
  studentName: string | null;
  /** The viewer may change things here (classroom status, not their own attempt). */
  canEdit: boolean;
}) => {
  const { ClassmojiService } = await import('@classmoji/services');
  const assignment = quiz.assignment ?? null;
  const [emojiScale, studentMembership, openRequest, adjustedBy, commentBy] = await Promise.all([
    ClassmojiService.emojiMapping.findScaleByClassroomId(classroom.id),
    ClassmojiService.classroomMembership.findByClassroomAndUser(
      classroom.id,
      attempt.user_id,
      'STUDENT'
    ),
    ClassmojiService.regradeRequest.findOpenByQuizAttemptId(attempt.id),
    attempt.adjusted_emoji && attempt.adjusted_by_id
      ? ClassmojiService.user.findById(attempt.adjusted_by_id)
      : null,
    attempt.instructor_comment && attempt.comment_by_id
      ? ClassmojiService.user.findById(attempt.comment_by_id)
      : null,
  ]);
  const isStudent = Boolean(studentMembership?.has_accepted_invite);
  // Lateness is a student's, measured from the due date plus the hours they bought.
  const extensionHours =
    isStudent && assignment?.student_deadline
      ? ((
          await ClassmojiService.quizGradeItems.netQuizExtensionHours({
            classroomId: classroom.id,
            studentId: attempt.user_id,
            assignmentIds: [assignment.id],
          })
        ).get(assignment.id) ?? 0)
      : 0;
  const penalty: unknown = classroom.settings?.late_penalty_points_per_hour;
  const grade = attemptGradeView({
    attempt,
    emojiScale,
    late:
      isStudent && assignment?.student_deadline
        ? {
            studentDeadline: assignment.student_deadline,
            extensionHours: Math.max(0, extensionHours),
            latePenaltyPerHour: typeof penalty === 'number' ? penalty : 0,
          }
        : null,
  });
  return staffAttemptGradePanel({
    attempt,
    adjustable: isStudent && Boolean(attempt.completed_at),
    canEdit,
    grade,
    adjustedByName: adjustedBy?.name ?? null,
    commentByName: commentBy?.name ?? null,
    emojiScale,
    latePenaltyPerHour: typeof penalty === 'number' ? penalty : 0,
    // The request row is the attempt's own; its classroom must be this one.
    openRequest: openRequest && openRequest.classroom_id === classroom.id ? openRequest : null,
    studentName,
  });
};

/** The audit `data.tool` of a quiz request resolved in the attempt drawer (E13). */
const RESOLVE_IN_DRAWER_TOOL = 'web:quiz_attempt.resolve_regrade';

/**
 * Adjust or revert a quiz attempt's grade (teaching team, D5), from the
 * adjust panel, or resolve the attempt's open regrade/resubmit request from
 * its banner (`_action: 'resolve'`, E13: the queue's rules, through
 * `resolveQuizRequest`, with the request bound to this attempt). The attempt
 * is the one in the URL, bound to this classroom's quiz before the service
 * runs; the service re-checks the actor against the attempt's own classroom,
 * refuses a preview or running attempt, and writes the audit row
 * (`data.tool` names this surface). Refusals come back as data
 * (`{ error, code }`), for the panel to show in place: this is reached by
 * `fetcher.submit`, and a thrown Response would replace the drawer.
 */
export async function action({ params, request }: Route.ActionArgs) {
  const { ClassmojiService, QuizGradeError } = await import('@classmoji/services');
  const quizId = params.quizId!;
  const attemptId = params.attemptId!;
  const { userId, classroom, membership } = await requireClassroomTeachingTeam(
    request,
    params.class!,
    {
      resourceType: 'QUIZ_ATTEMPT',
      action: 'adjust_quiz_attempt',
      metadata: { quiz_id: quizId, attempt_id: attemptId },
    }
  );
  const blocked = mutationRefusal(classroom, membership?.role);
  if (blocked) return blocked;

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

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;

  if (body?._action === 'resolve') {
    // The open request on THIS attempt only; the email goes out as from the queue.
    return resolveQuizRequest({
      classroomId: classroom.id,
      userId,
      body,
      tool: RESOLVE_IN_DRAWER_TOOL,
      impersonatedBy: await impersonatedBy(request),
      attemptId: attempt.id,
    });
  }

  try {
    if (body?._action === 'adjust') {
      const result = await ClassmojiService.quizAttempt.adjust({
        attemptId: attempt.id,
        ...(typeof body.emoji === 'string' ? { emoji: body.emoji } : {}),
        ...(typeof body.comment === 'string' || body.comment === null
          ? { comment: body.comment as string | null }
          : {}),
        actorUserId: userId,
        tool: 'web:quiz_attempt.adjust',
        impersonatedBy: await impersonatedBy(request),
      });
      return { ok: true, success: result.changed ? 'Saved' : 'No changes to save' };
    } else if (body?._action === 'revert') {
      await ClassmojiService.quizAttempt.revert({
        attemptId: attempt.id,
        actorUserId: userId,
        tool: 'web:quiz_attempt.revert',
        impersonatedBy: await impersonatedBy(request),
      });
      return { ok: true, success: 'Adjustment reverted' };
    }
    return reply({ error: 'Unknown action' }, { status: 400 });
  } catch (error) {
    if (error instanceof QuizGradeError) {
      return reply({ error: error.message, code: error.code }, { status: error.status });
    }
    throw error;
  }
}

export default function AdminQuizAttemptViewDrawer({ loaderData }: Route.ComponentProps) {
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
  const { class: classSlug, quizId } = useParams();
  // Served under every prefix this route's gate allows (/admin, /teacher and /assistant).
  const rolePrefix = useLocation().pathname.split('/')[1];
  const [showConfirm, setShowConfirm] = useState(false);

  // The results panel's grade and the staff blocks above it (see QuizResultContext).
  const panel = data.gradePanel;
  const slots = useMemo<QuizResultSlots | null>(() => {
    // The queue, opened on this request's resolve modal.
    const resolveUrl = (requestId: string) =>
      `/${rolePrefix}/${classSlug}/regrade-requests?resolve=${encodeURIComponent(requestId)}`;
    return panel
      ? {
          grade: panel.grade,
          beforeResults: (
            <>
              {panel.openRequest && (
                <QuizRegradeRequestBanner
                  request={panel.openRequest}
                  resolveUrl={resolveUrl(panel.openRequest.id)}
                  // Resolved right here where the classroom takes changes (E13).
                  panel={panel.canEdit ? panel : null}
                />
              )}
              {panel.adjustable && (
                <QuizAttemptGradePanel
                  panel={panel}
                  // The banner above already resolves it when the classroom takes changes.
                  resolveUrl={
                    panel.openRequest && !panel.canEdit ? resolveUrl(panel.openRequest.id) : null
                  }
                />
              )}
            </>
          ),
        }
      : null;
  }, [panel, rolePrefix, classSlug]);

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
        <p>This quiz is still in progress. Are you sure you want to leave?</p>
        <p style={{ fontSize: '13px', opacity: 0.7 }}>
          Progress has been saved and can be resumed later.
        </p>
      </Modal>
    </ConfigProvider>
  );
}
