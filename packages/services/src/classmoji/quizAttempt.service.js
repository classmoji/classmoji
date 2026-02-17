import prisma from '@classmoji/database';
import { checkForCompletion, DEFAULT_EMOJI_GRADE_MAPPINGS } from '@classmoji/utils';

const sanitizeDuration = value => {
  if (value === undefined || value === null) return undefined;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return undefined;
  const rounded = Math.round(numeric);
  return rounded < 0 ? 0 : rounded;
};

const buildDurationUpdate = (metrics, current = null) => {
  if (!metrics) return {};
  const total = sanitizeDuration(metrics.totalDurationMs ?? metrics.total_duration_ms);
  const unfocused = sanitizeDuration(metrics.unfocusedDurationMs ?? metrics.unfocused_duration_ms);

  const update = {};
  if (total !== undefined) {
    const existingTotal = current?.total_duration_ms ?? 0;
    update.total_duration_ms = Math.max(existingTotal, total);
  }
  if (unfocused !== undefined) {
    const existingUnfocused = current?.unfocused_duration_ms ?? 0;
    update.unfocused_duration_ms = Math.max(existingUnfocused, unfocused);
  }
  return update;
};

const getCurrentDurations = attemptId =>
  prisma.quizAttempt.findUnique({
    where: { id: attemptId },
    select: {
      total_duration_ms: true,
      unfocused_duration_ms: true,
      completed_at: true,
      partial_credit_percentage: true,
      first_attempt_percentage: true,
    },
  });

export const findById = async attemptId => {
  return prisma.quizAttempt.findUnique({
    where: { id: attemptId },
    include: {
      quiz: {
        include: {
          module: true,
          classroom: {
            include: {
              settings: true,
              git_organization: true,
            },
          },
        },
      },
      user: true,
    },
  });
};

// Bridge function: saves messages to AIConversation (which ai-agent also uses)
// This allows webapp to save initial messages before ai-agent SSE connects
export const addMessage = async (attemptId, role, content, hasQuestion = false, metadata = null) => {
  // Find or create the AIConversation for this attempt
  let conversation = await prisma.aIConversation.findFirst({
    where: { quiz_attempt: { id: attemptId } },
  });

  if (!conversation) {
    // Need to get the attempt to find user_id and classroom_id
    const attempt = await prisma.quizAttempt.findUnique({
      where: { id: attemptId },
      include: { quiz: true },
    });

    if (!attempt) {
      throw new Error(`Attempt not found: ${attemptId}`);
    }

    // Create the AIConversation
    conversation = await prisma.aIConversation.create({
      data: {
        type: 'QUIZ',
        user_id: attempt.user_id,
        classroom_id: attempt.quiz.classroom_id,
        context: metadata ? { metadata } : null,
      },
    });

    // Link the conversation to the attempt
    await prisma.quizAttempt.update({
      where: { id: attemptId },
      data: { conversation_id: conversation.id },
    });
  }

  // Map role to MessageRole enum (USER, ASSISTANT, SYSTEM, TOOL)
  const messageRole = role.toUpperCase();

  // Create the message
  return prisma.aIConversationMessage.create({
    data: {
      conversation_id: conversation.id,
      role: messageRole,
      content,
      metadata: metadata || null,
    },
  });
};

export const getMessages = async attemptId => {
  // All messages are stored in AIConversation (ai-agent owns persistence)
  // The relation is: QuizAttempt.conversation_id -> AIConversation.id
  const conversation = await prisma.aIConversation.findFirst({
    where: { quiz_attempt: { id: attemptId } },
  });

  if (!conversation) {
    return []; // No conversation yet
  }

  return prisma.aIConversationMessage.findMany({
    where: { conversation_id: conversation.id },
    orderBy: { created_at: 'asc' },
  });
};

const clampPercentage = value => {
  if (!Number.isFinite(value)) {
    throw new Error(`Percentage value must be finite, received ${value}`);
  }
  if (value < 0) return 0;
  if (value > 100) return 100;
  return value;
};

const parsePercentage = (rawValue, label, attemptId) => {
  if (rawValue === undefined || rawValue === null) {
    throw new Error(`[completeAttempt] Missing ${label} for attempt ${attemptId}`);
  }
  const numeric = Number.parseFloat(rawValue);
  if (!Number.isFinite(numeric)) {
    throw new Error(
      `[completeAttempt] ${label} must be numeric, received ${rawValue} for attempt ${attemptId}`
    );
  }
  return clampPercentage(numeric);
};

const findCompletionPayload = async attemptId => {
  // All messages are stored in AIConversation (ai-agent owns persistence)
  // The relation is: QuizAttempt.conversation_id -> AIConversation.id
  const conversation = await prisma.aIConversation.findFirst({
    where: { quiz_attempt: { id: attemptId } },
  });

  if (!conversation) {
    return null; // No conversation yet
  }

  const assistantMessages = await prisma.aIConversationMessage.findMany({
    where: {
      conversation_id: conversation.id,
      role: 'ASSISTANT',
    },
    orderBy: { created_at: 'desc' },
    take: 12,
    select: {
      content: true,
    },
  });

  for (const message of assistantMessages) {
    const completion = checkForCompletion(message.content);
    if (completion?.quiz_complete === true) {
      return completion;
    }
  }

  return null;
};

export const completeAttempt = async (attemptId, metrics = null) => {
  // Get current attempt state including progressive question results
  const currentAttempt = await prisma.quizAttempt.findUnique({
    where: { id: attemptId },
    select: {
      total_duration_ms: true,
      unfocused_duration_ms: true,
      completed_at: true,
      partial_credit_percentage: true,
      first_attempt_percentage: true,
      question_results_json: true, // Progressive grading data
    },
  });

  if (!currentAttempt) {
    throw new Error(`[completeAttempt] Attempt ${attemptId} not found`);
  }

  const durationUpdate = buildDurationUpdate(metrics, currentAttempt);

  // Avoid redundant re-processing if attempt already finalized with scores
  if (
    currentAttempt.completed_at &&
    currentAttempt.partial_credit_percentage !== null &&
    currentAttempt.first_attempt_percentage !== null
  ) {
    if (Object.keys(durationUpdate).length === 0) {
      return prisma.quizAttempt.findUnique({
        where: { id: attemptId },
        select: {
          id: true,
          completed_at: true,
          partial_credit_percentage: true,
          first_attempt_percentage: true,
          total_duration_ms: true,
          unfocused_duration_ms: true,
        },
      });
    }

    return prisma.quizAttempt.update({
      where: { id: attemptId },
      data: {
        ...durationUpdate,
      },
      select: {
        id: true,
        completed_at: true,
        partial_credit_percentage: true,
        first_attempt_percentage: true,
        total_duration_ms: true,
        unfocused_duration_ms: true,
      },
    });
  }

  let partialCredit;
  let firstAttempt;

  // PRIORITY 1: Use progressive question_results_json from DB (source of truth)
  const questionResults = currentAttempt.question_results_json;
  if (questionResults && Array.isArray(questionResults) && questionResults.length > 0) {
    const calculated = calculatePercentagesFromResults(questionResults);
    partialCredit = calculated.partial_credit_percentage;
    firstAttempt = calculated.first_attempt_percentage;
  } else {
    // PRIORITY 2: Fall back to LLM's completion payload (legacy/backup)
    const completion = await findCompletionPayload(attemptId);

    if (!completion) {
      throw new Error(
        `[completeAttempt] Could not locate completion payload for attempt ${attemptId}`
      );
    }

    partialCredit = parsePercentage(
      completion.partial_credit_percentage ?? completion.raw_percentage ?? completion.percentage,
      'partial_credit_percentage',
      attemptId
    );
    firstAttempt = parsePercentage(
      completion.first_attempt_percentage ?? completion.percentage,
      'first_attempt_percentage',
      attemptId
    );
  }

  return prisma.quizAttempt.update({
    where: { id: attemptId },
    data: {
      completed_at: new Date(),
      partial_credit_percentage: partialCredit,
      first_attempt_percentage: firstAttempt,
      session_status: 'completed',
      ...durationUpdate,
    },
    select: {
      id: true,
      completed_at: true,
      partial_credit_percentage: true,
      first_attempt_percentage: true,
      total_duration_ms: true,
      unfocused_duration_ms: true,
    },
  });
};

export const updateAttemptDurations = async (attemptId, metrics = {}) => {
  // Use a serializable transaction with row locking to prevent race conditions
  return prisma.$transaction(async tx => {
    // Lock the row by selecting FOR UPDATE
    const current = await tx.$queryRaw`
      SELECT total_duration_ms, unfocused_duration_ms, completed_at, modal_closed_at
      FROM quiz_attempts
      WHERE id = ${attemptId}
      FOR UPDATE
    `;

    if (!current || current.length === 0) {
      return null;
    }

    const row = current[0];

    // Skip if quiz already completed
    if (row.completed_at) {
      return {
        total_duration_ms: Number(row.total_duration_ms),
        unfocused_duration_ms: Number(row.unfocused_duration_ms),
        skipped: true,
        reason: 'completed',
      };
    }

    // Skip updates when modal_closed_at is set (gap pending)
    if (row.modal_closed_at) {
      return {
        total_duration_ms: Number(row.total_duration_ms),
        unfocused_duration_ms: Number(row.unfocused_duration_ms),
        skipped: true,
        reason: 'gap_pending',
      };
    }

    const durationUpdate = buildDurationUpdate(metrics, {
      total_duration_ms: Number(row.total_duration_ms),
      unfocused_duration_ms: Number(row.unfocused_duration_ms),
    });

    if (Object.keys(durationUpdate).length === 0) {
      return {
        total_duration_ms: Number(row.total_duration_ms),
        unfocused_duration_ms: Number(row.unfocused_duration_ms),
      };
    }

    const updated = await tx.quizAttempt.update({
      where: { id: attemptId },
      data: durationUpdate,
      select: {
        total_duration_ms: true,
        unfocused_duration_ms: true,
      },
    });

    return updated;
  });
};

/**
 * Record when the modal was closed AND apply final metrics atomically
 * Uses row-level locking to prevent race conditions
 * @param {string} attemptId - The quiz attempt ID
 * @param {Object} metrics - Optional metrics to apply (totalDurationMs, unfocusedDurationMs)
 * @returns {Promise<Object>} Updated attempt with modal_closed_at timestamp and durations
 */
export const recordModalClosed = async (attemptId, metrics = null) => {
  return prisma.$transaction(async tx => {
    // Lock the row
    const current = await tx.$queryRaw`
      SELECT id, total_duration_ms, unfocused_duration_ms, completed_at, modal_closed_at
      FROM quiz_attempts
      WHERE id = ${attemptId}
      FOR UPDATE
    `;

    if (!current || current.length === 0) {
      throw new Error('Attempt not found');
    }

    const row = current[0];

    // Don't update if already completed
    if (row.completed_at) {
      return {
        id: attemptId,
        modal_closed_at: null,
        total_duration_ms: Number(row.total_duration_ms),
        unfocused_duration_ms: Number(row.unfocused_duration_ms),
        skipped: true,
        reason: 'completed',
      };
    }

    // If modal_closed_at is already set, skip (another close is pending)
    if (row.modal_closed_at) {
      return {
        id: attemptId,
        modal_closed_at: row.modal_closed_at,
        total_duration_ms: Number(row.total_duration_ms),
        unfocused_duration_ms: Number(row.unfocused_duration_ms),
        skipped: true,
        reason: 'already_closed',
      };
    }

    // Check for stale request (incoming total < current total means gap was already applied)
    const incomingTotal = metrics?.totalDurationMs ?? metrics?.total_duration_ms ?? 0;
    if (incomingTotal > 0 && incomingTotal < Number(row.total_duration_ms)) {
      return {
        id: attemptId,
        modal_closed_at: row.modal_closed_at,
        total_duration_ms: Number(row.total_duration_ms),
        unfocused_duration_ms: Number(row.unfocused_duration_ms),
        skipped: true,
        reason: 'stale_request',
      };
    }

    // Build update
    const updateData = {
      modal_closed_at: new Date(),
    };

    if (metrics) {
      const durationUpdate = buildDurationUpdate(metrics, {
        total_duration_ms: Number(row.total_duration_ms),
        unfocused_duration_ms: Number(row.unfocused_duration_ms),
      });
      Object.assign(updateData, durationUpdate);
    }

    return tx.quizAttempt.update({
      where: { id: attemptId },
      data: updateData,
      select: {
        id: true,
        modal_closed_at: true,
        total_duration_ms: true,
        unfocused_duration_ms: true,
      },
    });
  });
};

/**
 * Calculate time gap since modal was closed and add it to unfocused duration
 * Uses row-level locking to prevent race conditions
 *
 * Falls back to updated_at if modal_closed_at is NULL (handles offline tab close
 * where the beacon failed to reach the server)
 *
 * @param {string} attemptId - The quiz attempt ID
 * @returns {Promise<Object>} Updated durations with gap time added to unfocused
 */
export const calculateAndApplyModalGap = async attemptId => {
  return prisma.$transaction(async tx => {
    // Lock the row - include updated_at as fallback for offline close detection
    const current = await tx.$queryRaw`
      SELECT total_duration_ms, unfocused_duration_ms, completed_at, modal_closed_at, updated_at
      FROM quiz_attempts
      WHERE id = ${attemptId}
      FOR UPDATE
    `;

    if (!current || current.length === 0) {
      throw new Error('Attempt not found');
    }

    const row = current[0];

    // Don't calculate gap if quiz is already completed
    if (row.completed_at) {
      return {
        total_duration_ms: Number(row.total_duration_ms),
        unfocused_duration_ms: Number(row.unfocused_duration_ms),
        gapApplied: false,
        gapMs: 0,
      };
    }

    // Use modal_closed_at if available, otherwise fallback to updated_at
    // This handles cases where the beacon/fetch call failed on tab close (e.g. offline)
    const lastKnownTime = row.modal_closed_at
      ? new Date(row.modal_closed_at)
      : new Date(row.updated_at);

    // Calculate gap time in milliseconds
    const now = new Date();
    const gapMs = now.getTime() - lastKnownTime.getTime();

    // Ignore small gaps (e.g. page reloads) to avoid noise
    const MIN_GAP_MS = 5000;
    if (gapMs < MIN_GAP_MS) {
      // If we have a pending modal_closed_at but the gap is too small (e.g. quick reload),
      // we should clear it to reset the state, but NOT apply the gap to durations.
      if (row.modal_closed_at) {
        await tx.quizAttempt.update({
          where: { id: attemptId },
          data: { modal_closed_at: null },
        });
      }

      return {
        total_duration_ms: Number(row.total_duration_ms),
        unfocused_duration_ms: Number(row.unfocused_duration_ms),
        gapApplied: false,
        gapMs: 0,
      };
    }

    // Add gap to both total and unfocused durations
    const newTotalMs = Number(row.total_duration_ms) + gapMs;
    const newUnfocusedMs = Number(row.unfocused_duration_ms) + gapMs;

    // Update the attempt and clear modal_closed_at
    const updated = await tx.quizAttempt.update({
      where: { id: attemptId },
      data: {
        total_duration_ms: Math.max(0, Math.round(newTotalMs)),
        unfocused_duration_ms: Math.max(0, Math.round(newUnfocusedMs)),
        modal_closed_at: null, // Clear the timestamp
      },
      select: {
        total_duration_ms: true,
        unfocused_duration_ms: true,
      },
    });

    return {
      ...updated,
      gapApplied: true,
      gapMs: Math.round(gapMs),
    };
  });
};

export const findByQuiz = async quizId => {
  const attempts = await prisma.quizAttempt.findMany({
    where: { quiz_id: quizId },
    include: {
      user: true,
    },
    orderBy: { started_at: 'desc' },
  });

  return attempts;
};

export const findByUser = async (userId, organizationId = null) => {
  const whereClause = {
    user_id: userId.toString(),
  };

  if (organizationId) {
    whereClause.quiz = {
      classroom_id: organizationId.toString(),
    };
  }

  return prisma.quizAttempt.findMany({
    where: whereClause,
    include: {
      quiz: {
        include: {
          module: true,
          classroom: true,
        },
      },
    },
    orderBy: { started_at: 'desc' },
  });
};

export const getAttemptStatsByQuiz = async quizId => {
  const attempts = await prisma.quizAttempt.findMany({
    where: {
      quiz_id: quizId,
      completed_at: { not: null },
    },
    select: {
      partial_credit_percentage: true,
      completed_at: true,
      started_at: true,
    },
  });

  if (attempts.length === 0) {
    return {
      totalAttempts: 0,
      completedAttempts: 0,
      averageScore: null,
      minScore: null,
      maxScore: null,
      averageTimeMinutes: null,
    };
  }

  const scores = attempts
    .map(a => a.partial_credit_percentage)
    .filter(value => value !== null && value !== undefined);
  const times = attempts.map(a => {
    const duration = new Date(a.completed_at) - new Date(a.started_at);
    return duration / (1000 * 60); // Convert to minutes
  });

  return {
    totalAttempts: attempts.length,
    completedAttempts: attempts.length,
    averageScore:
      scores.length > 0 ? Math.round(scores.reduce((sum, s) => sum + s, 0) / scores.length) : null,
    minScore: scores.length > 0 ? Math.min(...scores) : null,
    maxScore: scores.length > 0 ? Math.max(...scores) : null,
    averageTimeMinutes:
      times.length > 0 ? Math.round(times.reduce((sum, t) => sum + t, 0) / times.length) : null,
  };
};

export const deleteAttempt = async attemptId => {
  // Check for AIConversation (new unified storage)
  const conversation = await prisma.aIConversation.findFirst({
    where: { quiz_attempt: { id: attemptId } },
  });

  if (conversation) {
    // Delete AIConversationMessages first
    await prisma.aIConversationMessage.deleteMany({
      where: { conversation_id: conversation.id },
    });
    // Delete AIConversation
    await prisma.aIConversation.delete({
      where: { id: conversation.id },
    });
  }

  // Then delete the attempt
  return prisma.quizAttempt.delete({
    where: { id: attemptId },
  });
};

export const getUserAttemptForQuiz = async (quizId, userId) => {
  return prisma.quizAttempt.findFirst({
    where: {
      quiz_id: quizId,
      user_id: userId.toString(),
    },
    include: {
      quiz: {
        include: {
          module: true,
        },
      },
    },
  });
};

// Get attempt with messages for AI processing
export const findWithMessages = async attemptId => {
  const attempt = await findById(attemptId);
  if (!attempt) {
    throw new Error('Attempt not found');
  }

  // All messages are stored in AIConversation (ai-agent owns persistence)
  const conversation = await prisma.aIConversation.findFirst({
    where: { quiz_attempt: { id: attemptId } },
    include: {
      messages: {
        orderBy: { created_at: 'asc' },
      },
    },
  });

  // Format messages for UI display (lowercase roles = industry standard)
  const messages = conversation?.messages?.map(msg => ({
    id: msg.id,
    role: msg.role.toLowerCase(),
    content: msg.content,
    metadata: msg.metadata || null, // Contains explorationSteps for code-aware quizzes
    timestamp: msg.created_at,
  })) || [];

  return {
    attempt,
    messages,
    systemPrompt: attempt.quiz.system_prompt,
    rubricPrompt: attempt.quiz.rubric_prompt,
    subject: attempt.quiz.subject,
    difficultyLevel: attempt.quiz.difficulty_level,
    questionsAsked: attempt.questions_asked || 0,
    questionCount: attempt.quiz.question_count || 5,
    // Include classroom settings for LLM configuration
    classroomSettings: attempt.quiz.classroom?.settings,
  };
};

// Function to increment the questions asked counter
export const incrementQuestionsAsked = async attemptId => {
  const attempt = await prisma.quizAttempt.findUnique({
    where: { id: attemptId }, // UUID string, no BigInt conversion needed
    select: { questions_asked: true },
  });

  return prisma.quizAttempt.update({
    where: { id: attemptId }, // UUID string, no BigInt conversion needed
    data: {
      questions_asked: (attempt.questions_asked || 0) + 1,
    },
  });
};

// Update agent_config field for an attempt
export const updateAgentConfig = async (attemptId, config) => {
  const attempt = await prisma.quizAttempt.findUnique({
    where: { id: attemptId },
    select: { agent_config: true },
  });

  return prisma.quizAttempt.update({
    where: { id: attemptId },
    data: {
      agent_config: { ...(attempt?.agent_config || {}), ...config },
    },
  });
};

// Development-only function to restart a quiz from scratch
export const restartQuizAttempt = async (quizId, userId, membership) => {
  // Only allow in development mode
  if (process.env.NODE_ENV !== 'development') {
    throw new Error('Quiz restart is only available in development mode');
  }

  if (!membership) {
    throw new Error('Membership required to restart quiz attempt');
  }

  const quiz = await prisma.quiz.findUnique({
    where: { id: quizId },
    select: {
      id: true,
      classroom_id: true,
    },
  });

  if (!quiz) {
    throw new Error('Quiz not found');
  }

  const quizClassroomId = quiz.classroom_id?.toString();
  const membershipClassroomId =
    membership.classroom_id?.toString() ?? membership.organization_id?.toString() ?? null;

  if (membershipClassroomId && quizClassroomId && membershipClassroomId !== quizClassroomId) {
    throw new Error('Membership does not match quiz classroom');
  }

  const requestedUserId = userId.toString();
  const membershipUserId = membership.user_id?.toString() ?? membership.userId?.toString();

  if (membership.role === 'STUDENT' && membershipUserId && membershipUserId !== requestedUserId) {
    throw new Error('Students may only restart their own quiz attempts');
  }

  // Find existing attempt
  const existingAttempt = await prisma.quizAttempt.findFirst({
    where: {
      quiz_id: quizId,
      user_id: userId.toString(),
    },
  });

  if (!existingAttempt) {
    return { success: false, message: 'No existing attempt found' };
  }

  // Check for AIConversation (new unified storage)
  const conversation = await prisma.aIConversation.findFirst({
    where: { quiz_attempt: { id: existingAttempt.id } },
  });

  if (conversation) {
    // Delete AIConversationMessages first
    await prisma.aIConversationMessage.deleteMany({
      where: { conversation_id: conversation.id },
    });
    // Delete AIConversation
    await prisma.aIConversation.delete({
      where: { id: conversation.id },
    });
  }

  // Delete the attempt
  await prisma.quizAttempt.delete({
    where: { id: existingAttempt.id },
  });

  return { success: true, message: 'Quiz attempt restarted successfully' };
};

/**
 * Create a new quiz attempt with max_attempts validation
 * @param {string} quizId - The quiz ID
 * @param {string|BigInt} userId - The user ID
 * @param {Object} membership - The user's membership object
 * @returns {Promise<Object>} Result object with success status and attempt details
 */
export const createNew = async (quizId, userId, membership) => {
  if (!membership) {
    throw new Error('Membership required to create quiz attempt');
  }

  const quiz = await prisma.quiz.findUnique({
    where: { id: quizId },
    select: {
      id: true,
      classroom_id: true,
      max_attempts: true,
      name: true,
      status: true,
    },
  });

  if (!quiz) {
    throw new Error('Quiz not found');
  }

  // Verify classroom access
  const quizClassroomId = quiz.classroom_id?.toString();
  const membershipClassroomId = membership.classroom_id?.toString() ?? membership.organization_id?.toString();
  if (quizClassroomId !== membershipClassroomId) {
    throw new Error('Membership does not match quiz classroom');
  }

  // Check if user can create new attempt
  const isInstructor = ['OWNER', 'ASSISTANT', 'TEACHER'].includes(membership.role);
  console.log(`[createNew] userId=${userId}, role=${membership.role}, isInstructor=${isInstructor}`);

  // SECURITY: Check for incomplete attempts (students only)
  // Instructors (OWNER, ASSISTANT, TEACHER) can have multiple concurrent attempts for testing
  // Prevents students from having multiple in-progress attempts which could:
  // - Exhaust database connections
  // - Create orphaned quiz-agent sessions
  // - Bypass max_attempts limits by leaving attempts incomplete
  if (!isInstructor) {
    const incompleteAttempts = await prisma.quizAttempt.findMany({
      where: {
        quiz_id: quizId,
        user_id: userId.toString(),
        completed_at: null,
      },
      select: {
        id: true,
        started_at: true,
      },
      orderBy: {
        started_at: 'desc',
      },
      take: 1,
    });

    if (incompleteAttempts.length > 0) {
      return {
        success: false,
        message:
          'You have an incomplete attempt for this quiz. Please complete or abandon it before starting a new attempt.',
        reason: 'incomplete_attempt_exists',
        existingAttemptId: incompleteAttempts[0].id,
        canResume: true,
      };
    }
  }

  // Count existing attempts
  const existingAttemptsCount = await prisma.quizAttempt.count({
    where: {
      quiz_id: quizId,
      user_id: userId.toString(),
    },
  });

  const maxAttempts = quiz.max_attempts || 0;
  const hasUnlimitedAttempts = maxAttempts === 0;

  if (!isInstructor) {
    // Students must respect max_attempts limit
    if (!hasUnlimitedAttempts && existingAttemptsCount >= maxAttempts) {
      return {
        success: false,
        message: `Maximum number of attempts (${maxAttempts}) reached for this quiz`,
        reason: 'max_attempts_reached',
        attemptCount: existingAttemptsCount,
        maxAttempts: maxAttempts,
      };
    }

    // Students can only take published quizzes
    if (quiz.status !== 'PUBLISHED') {
      return {
        success: false,
        message: 'Quiz is not published',
        reason: 'quiz_not_published',
      };
    }
  }
  // Instructors can always create attempts (for preview/testing)

  // Create the new attempt
  const newAttempt = await prisma.quizAttempt.create({
    data: {
      quiz_id: quizId,
      user_id: userId.toString(),
      started_at: new Date(),
    },
  });

  return {
    success: true,
    canCreateAttempt: true,
    attemptCount: existingAttemptsCount + 1,
    maxAttempts: maxAttempts,
    attemptId: newAttempt.id,
    newAttempt: true,
  };
};

/**
 * Calculate quiz score based on grading strategy
 * @param {string} quizId - The quiz ID
 * @param {string|BigInt} userId - The user ID
 * @returns {Promise<Object>} Score calculation result
 */
export const calculateQuizScore = async (quizId, userId) => {
  const quiz = await prisma.quiz.findUnique({
    where: { id: quizId },
    select: {
      grading_strategy: true,
      max_attempts: true,
    },
  });

  if (!quiz) {
    throw new Error('Quiz not found');
  }

  // Get all completed attempts
  const attempts = await prisma.quizAttempt.findMany({
    where: {
      quiz_id: quizId,
      user_id: userId.toString(),
      completed_at: { not: null },
      partial_credit_percentage: { not: null },
    },
    select: {
      id: true,
      partial_credit_percentage: true,
      completed_at: true,
      started_at: true,
    },
    orderBy: {
      completed_at: 'asc',
    },
  });

  if (attempts.length === 0) {
    return {
      score: null,
      totalAttempts: 0,
      strategy: quiz.grading_strategy,
      countingAttemptId: null,
    };
  }

  let finalScore = null;
  let countingAttemptId = null;

  switch (quiz.grading_strategy) {
    case 'HIGHEST': {
      // Use the highest score across all attempts
      const highest = attempts.reduce((max, a) =>
        a.partial_credit_percentage > max.partial_credit_percentage ? a : max
      );
      finalScore = highest.partial_credit_percentage;
      countingAttemptId = highest.id;
      break;
    }

    case 'MOST_RECENT': {
      // Use the most recent completed attempt
      const mostRecent = attempts[attempts.length - 1];
      finalScore = mostRecent.partial_credit_percentage;
      countingAttemptId = mostRecent.id;
      break;
    }

    case 'FIRST': {
      // Use the first completed attempt
      const first = attempts[0];
      finalScore = first.partial_credit_percentage;
      countingAttemptId = first.id;
      break;
    }

    default: {
      // Default to highest if strategy is unknown
      const highest = attempts.reduce((max, a) =>
        a.partial_credit_percentage > max.partial_credit_percentage ? a : max
      );
      finalScore = highest.partial_credit_percentage;
      countingAttemptId = highest.id;
      break;
    }
  }

  return {
    score: finalScore,
    totalAttempts: attempts.length,
    strategy: quiz.grading_strategy,
    countingAttemptId,
    allScores: attempts.map(a => ({
      attemptId: a.id,
      score: a.partial_credit_percentage,
      completedAt: a.completed_at,
    })),
  };
};

/**
 * Initialize a code-aware quiz by cloning the student's repository and generating opening message
 * @param {Object} attempt - The quiz attempt object with quiz and assignment info
 * @param {string} userId - The user ID
 * @param {Object} codebaseManager - The codebase manager instance
 * @param {Function} getInstallationToken - Function to get GitHub installation token
 * @param {Function} createQuizAgent - Function to create quiz agent config
 * @param {Function} generateQuizResponse - Function to generate quiz response
 * @returns {Promise<{codebasePath: string, openingMessage: string, explorationSteps: Array}>}
 */
export const initializeCodeAwareQuiz = async (
  attempt,
  userId,
  codebaseManager,
  getInstallationToken,
  createQuizAgent,
  generateQuizResponse,
  findStudentRepository,
  findClassroomById,
  addMessage,
  incrementQuestionsAsked
) => {
  // Find student's repository
  const repo = await findStudentRepository(attempt.quiz.module_id, userId);
  if (!repo) {
    throw new Error('No repository found for this module');
  }

  // Get classroom and GitHub token
  const classroom = await findClassroomById(attempt.quiz.classroom_id);
  const githubToken = await getInstallationToken(classroom.git_organization?.github_installation_id);

  // Clone repository
  const codebasePath = await codebaseManager.cloneForAttempt(
    attempt.id.toString(),
    classroom.slug,
    repo.name,
    githubToken
  );

  // Create agent configuration
  const agentConfig = createQuizAgent(
    codebasePath,
    {
      systemPrompt: attempt.quiz.system_prompt,
      rubricPrompt: attempt.quiz.rubric_prompt,
      questionCount: attempt.quiz.question_count || 5,
      subject: attempt.quiz.subject,
      difficultyLevel: attempt.quiz.difficulty_level,
    },
    attempt.id
  );

  // Generate opening message
  const openingResult = await generateQuizResponse(
    agentConfig,
    [], // Empty conversation history
    agentConfig.systemPrompt,
    0, // No questions asked yet
    attempt.quiz.question_count || 5
  );

  if (!openingResult || !openingResult.response) {
    throw new Error('Agent returned empty response');
  }

  const openingMessage = openingResult.response;
  const hasQuestion = openingMessage.includes('?');

  // Store with exploration metadata if available
  const openingMetadata =
    openingResult.explorationSteps && openingResult.explorationSteps.length > 0
      ? { explorationSteps: openingResult.explorationSteps }
      : null;

  // Save opening message
  await addMessage(attempt.id, 'ASSISTANT', openingMessage, hasQuestion, openingMetadata);

  if (hasQuestion) {
    await incrementQuestionsAsked(attempt.id);
  }

  return {
    codebasePath,
    openingMessage,
    explorationSteps: openingResult.explorationSteps || [],
  };
};

/**
 * Clear all quiz attempts for a user in an organization
 * @param {string|BigInt} userId - The user ID
 * @param {string|BigInt} organizationId - The organization ID
 * @returns {Promise<Object>} Deletion result with count
 */
export const clearForUser = async (userId, classroomId) => {
  // Find all attempts for this user in this classroom
  const attempts = await prisma.quizAttempt.findMany({
    where: {
      user_id: userId.toString(),
      quiz: {
        classroom_id: classroomId.toString(),
      },
    },
    select: {
      id: true,
    },
  });

  if (attempts.length === 0) {
    return {
      success: true,
      deletedCount: 0,
    };
  }

  const attemptIds = attempts.map(a => a.id);

  // Find all AIConversations for these attempts (new unified storage)
  const conversations = await prisma.aIConversation.findMany({
    where: {
      quiz_attempt: { id: { in: attemptIds } },
    },
    select: { id: true },
  });

  if (conversations.length > 0) {
    const conversationIds = conversations.map(c => c.id);
    // Delete AIConversationMessages first
    await prisma.aIConversationMessage.deleteMany({
      where: { conversation_id: { in: conversationIds } },
    });
    // Delete AIConversations
    await prisma.aIConversation.deleteMany({
      where: { id: { in: conversationIds } },
    });
  }

  // Delete all attempts
  const deleteResult = await prisma.quizAttempt.deleteMany({
    where: {
      user_id: userId.toString(),
      quiz: {
        classroom_id: classroomId.toString(),
      },
    },
  });

  return {
    success: true,
    deletedCount: deleteResult.count,
  };
};

/**
 * Clear all quiz attempts for a user for a specific quiz
 * Authorization is handled by assertClassroomAccess in the route
 * @param {string|BigInt} userId - The user ID whose attempts will be cleared
 * @param {string} quizId - The quiz ID (UUID)
 * @param {string} classroomId - The classroom ID (for verification)
 * @returns {Promise<Object>} Deletion result with count
 */
export const clearForUserAndQuiz = async (userId, quizId, classroomId) => {
  // Verify the quiz exists and belongs to the classroom
  const quiz = await prisma.quiz.findUnique({
    where: { id: quizId },
    select: {
      id: true,
      classroom_id: true,
    },
  });

  if (!quiz) {
    throw new Error('Quiz not found');
  }

  const quizClassroomId = quiz.classroom_id?.toString();
  const requestClassroomId = classroomId?.toString();

  if (quizClassroomId !== requestClassroomId) {
    throw new Error('Quiz does not belong to this classroom');
  }

  // Find all attempts for this user for this specific quiz
  const attempts = await prisma.quizAttempt.findMany({
    where: {
      user_id: userId.toString(),
      quiz_id: quizId,
    },
    select: {
      id: true,
    },
  });

  if (attempts.length === 0) {
    return {
      success: true,
      deletedCount: 0,
    };
  }

  const attemptIds = attempts.map(a => a.id);

  // Find all AIConversations for these attempts (new unified storage)
  const conversations = await prisma.aIConversation.findMany({
    where: {
      quiz_attempt: { id: { in: attemptIds } },
    },
    select: { id: true },
  });

  if (conversations.length > 0) {
    const conversationIds = conversations.map(c => c.id);
    // Delete AIConversationMessages first
    await prisma.aIConversationMessage.deleteMany({
      where: { conversation_id: { in: conversationIds } },
    });
    // Delete AIConversations
    await prisma.aIConversation.deleteMany({
      where: { id: { in: conversationIds } },
    });
  }

  // Delete all attempts
  const deleteResult = await prisma.quizAttempt.deleteMany({
    where: {
      user_id: userId.toString(),
      quiz_id: quizId,
    },
  });

  return {
    success: true,
    deletedCount: deleteResult.count,
  };
};

// ============================================================================
// Progressive Question Grading Functions
// ============================================================================

/**
 * Get emoji mappings for an attempt's classroom.
 * Returns a map of { emoji: grade } for use with gradeToEmoji().
 *
 * @param {string} attemptId - Quiz attempt ID (UUID)
 * @returns {Object} Map of emoji shortcode to grade value, e.g. { heart: 100, '+1': 90 }
 */
export const getEmojiMappingsForAttempt = async attemptId => {
  const attempt = await prisma.quizAttempt.findUnique({
    where: { id: attemptId },
    include: {
      quiz: {
        include: {
          classroom: {
            include: { emoji_mappings: true },
          },
        },
      },
    },
  });

  const classroomMappings = attempt?.quiz?.classroom?.emoji_mappings;

  // Fall back to sensible defaults if classroom hasn't configured emoji mappings
  if (!classroomMappings || classroomMappings.length === 0) {
    return { ...DEFAULT_EMOJI_GRADE_MAPPINGS };
  }

  // Convert array to { emoji: grade } map
  return classroomMappings.reduce((acc, m) => {
    acc[m.emoji] = m.grade;
    return acc;
  }, {});
};

/**
 * Append a question result to the attempt's question_results_json.
 * Called by record_question_result tool handler.
 *
 * Uses upsert behavior - if a result for the same question_num exists, it's replaced.
 *
 * @param {string} attemptId - The quiz attempt ID (UUID string)
 * @param {Object} result - Result from LLM:
 *   - question_num: number (1-indexed)
 *   - attempts: number (0 = skipped, clarifying questions don't count)
 *   - eventually_correct: boolean
 *   - credit_earned: number (0-100)
 * @param {string} emojiKey - Pre-calculated emoji key from gradeToEmoji()
 */
export const appendQuestionResult = async (attemptId, result, emojiKey) => {
  const attempt = await prisma.quizAttempt.findUnique({
    where: { id: attemptId },
    select: { question_results_json: true },
  });

  const existing = attempt?.question_results_json || [];

  // Prevent duplicates (upsert behavior) - filter out any existing result for this question
  const filtered = existing.filter(r => r.question_num !== result.question_num);

  const updated = [
    ...filtered,
    {
      question_num: result.question_num,
      attempts: result.attempts,
      eventually_correct: result.eventually_correct,
      credit_earned: result.credit_earned,
      emoji: emojiKey, // Store emoji for later display (lowercase)
      recorded_at: new Date().toISOString(),
      // first_attempt_correct is NOT stored - derive via (attempts === 1 && eventually_correct)
    },
  ];

  return prisma.quizAttempt.update({
    where: { id: attemptId },
    data: { question_results_json: updated },
  });
};

/**
 * Calculate final percentages from stored question results.
 * Called by completeAttempt when quiz ends, OR can be used to derive scores from DB.
 *
 * @param {Array} questionResults - Array from question_results_json
 * @returns {Object} { partial_credit_percentage, first_attempt_percentage }
 */
export const calculatePercentagesFromResults = questionResults => {
  if (!questionResults || questionResults.length === 0) {
    return { partial_credit_percentage: null, first_attempt_percentage: null };
  }

  const total = questionResults.length;

  // Partial credit = average of credit_earned
  const partialSum = questionResults.reduce((sum, r) => sum + r.credit_earned, 0);
  const partial_credit_percentage = partialSum / total;

  // First attempt = percentage of questions correct on first try
  const firstAttemptCorrect = questionResults.filter(
    r => r.attempts === 1 && r.eventually_correct
  ).length;
  const first_attempt_percentage = (firstAttemptCorrect / total) * 100;

  return {
    partial_credit_percentage: Math.round(partial_credit_percentage * 10) / 10,
    first_attempt_percentage: Math.round(first_attempt_percentage * 10) / 10,
  };
};

/**
 * Get the stored question results for an attempt.
 * Used by submit_quiz_evaluation to compute scores server-side instead of asking LLM.
 *
 * @param {string} attemptId - The quiz attempt ID (UUID string)
 * @returns {Promise<Array|null>} Array of question results or null if none
 */
export const getQuestionResults = async attemptId => {
  const attempt = await prisma.quizAttempt.findUnique({
    where: { id: attemptId },
    select: { question_results_json: true },
  });
  return attempt?.question_results_json || [];
};

// Aliases for consistent naming across services
export const getAttemptsByQuiz = findByQuiz;
export const getAttemptById = findById;
export const getAttemptsByUser = findByUser;
export const clearUserAttempts = clearForUser;
export const clearUserAttemptsForQuiz = clearForUserAndQuiz;
export const createNewQuizAttempt = createNew;
export const getAttemptWithMessages = findWithMessages;
export const updateDurations = updateAttemptDurations;

