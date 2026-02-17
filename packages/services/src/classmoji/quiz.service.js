import prisma from '@classmoji/database';

export const create = async data => {
  return prisma.quiz.create({
    data: {
      name: data.name,
      classroom_id: data.classroomId,
      module_id: data.moduleId || null,
      system_prompt: data.systemPrompt || null,
      rubric_prompt: data.rubricPrompt,
      subject: data.subject || null,
      difficulty_level: data.difficultyLevel || null,
      due_date: data.dueDate ? new Date(data.dueDate) : null,
      status: data.status || 'DRAFT',
      weight: parseInt(data.weight) || 0,
      question_count: Math.min(20, Math.max(1, parseInt(data.questionCount) || 5)),
      include_code_context: data.includeCodeContext || false,
      max_attempts: data.maxAttempts !== undefined ? parseInt(data.maxAttempts) : 1,
      grading_strategy: data.gradingStrategy || 'HIGHEST',
    },
    include: {
      module: true,
      attempts: {
        include: {
          user: true,
        },
      },
    },
  });
};

export const update = async (quizId, data) => {
  const updateData = {};

  if (data.name !== undefined) updateData.name = data.name;
  if (data.moduleId !== undefined) {
    // Use relation syntax for updating module
    if (data.moduleId === null) {
      updateData.module = { disconnect: true };
    } else {
      updateData.module = { connect: { id: data.moduleId } };
    }
  }
  if (data.systemPrompt !== undefined) updateData.system_prompt = data.systemPrompt;
  if (data.rubricPrompt !== undefined) updateData.rubric_prompt = data.rubricPrompt;
  if (data.subject !== undefined) updateData.subject = data.subject;
  if (data.difficultyLevel !== undefined) updateData.difficulty_level = data.difficultyLevel;
  if (data.dueDate !== undefined)
    updateData.due_date = data.dueDate ? new Date(data.dueDate) : null;
  if (data.status !== undefined) updateData.status = data.status;
  if (data.weight !== undefined) updateData.weight = parseInt(data.weight);
  if (data.questionCount !== undefined) updateData.question_count = Math.min(20, Math.max(1, parseInt(data.questionCount) || 5));
  if (data.includeCodeContext !== undefined)
    updateData.include_code_context = data.includeCodeContext;
  if (data.maxAttempts !== undefined) updateData.max_attempts = parseInt(data.maxAttempts);
  if (data.gradingStrategy !== undefined) updateData.grading_strategy = data.gradingStrategy;

  return prisma.quiz.update({
    where: { id: quizId },
    data: updateData,
    include: {
      module: true,
      attempts: {
        include: {
          user: true,
        },
      },
    },
  });
};

const deleteQuiz = async quizId => {
  return prisma.quiz.delete({
    where: { id: quizId },
  });
};
export { deleteQuiz as delete };

export const findById = async quizId => {
  return prisma.quiz.findUnique({
    where: { id: quizId },
    include: {
      module: true,
      classroom: true,
      attempts: {
        include: {
          user: true,
        },
      },
    },
  });
};

export const findByClassroom = async (classroomId, membership) => {
  return getQuizzesByOrganization(classroomId, membership);
};

export const getQuizzesByOrganization = async (classroomId, membership) => {
  if (!membership) {
    throw new Error('Membership required to access classroom quizzes');
  }

  const allowedRoles = ['OWNER', 'ASSISTANT'];
  if (!allowedRoles.includes(membership.role)) {
    throw new Error('Unauthorized classroom quiz access');
  }

  const membershipClassroomId =
    membership.classroom_id?.toString() ?? null;
  if (membershipClassroomId && membershipClassroomId !== classroomId.toString()) {
    throw new Error('Membership does not match classroom');
  }

  const quizzes = await prisma.quiz.findMany({
    where: { classroom_id: classroomId },
    include: {
      module: true,
      attempts: {
        include: {
          user: true,
        },
      },
      _count: {
        select: { attempts: true },
      },
    },
    orderBy: { created_at: 'desc' },
  });

  // Calculate statistics for each quiz
  return quizzes.map(quiz => {
    const completedAttempts = quiz.attempts.filter(
      a => a.completed_at !== null && a.partial_credit_percentage !== null
    );
    const avgScore =
      completedAttempts.length > 0
        ? completedAttempts.reduce((sum, a) => sum + (a.partial_credit_percentage || 0), 0) /
          completedAttempts.length
        : null;

    return {
      ...quiz,
      attemptsCount: quiz._count.attempts,
      avgScore: avgScore !== null ? Math.round(avgScore) : null,
    };
  });
};

export const getQuizzesForStudent = async (classroomId, userId, membership) => {
  if (!membership) {
    throw new Error('Membership required to access student quizzes');
  }

  const membershipClassroomId = membership.classroom_id?.toString() ?? null;
  if (membershipClassroomId && membershipClassroomId !== classroomId.toString()) {
    throw new Error('Membership does not match classroom');
  }

  const allowedRoles = ['STUDENT', 'ASSISTANT', 'OWNER'];
  if (!allowedRoles.includes(membership.role)) {
    throw new Error('Unauthorized role for student quiz access');
  }

  if (membership.role === 'STUDENT') {
    const membershipUserId = membership.user_id?.toString() ?? membership.userId?.toString();
    if (membershipUserId && membershipUserId !== userId.toString()) {
      throw new Error('Students may only access their own quizzes');
    }
  }

  const quizzes = await prisma.quiz.findMany({
    where: {
      classroom_id: classroomId,
      status: 'PUBLISHED',
    },
    include: {
      module: true,
      attempts: {
        where: { user_id: userId },
        orderBy: { started_at: 'desc' }, // Most recent first
      },
    },
    orderBy: { created_at: 'desc' },
  });

  // Add attempt metadata for each quiz
  return quizzes.map(quiz => {
    const attempts = quiz.attempts || [];
    const attemptCount = attempts.length;
    const maxAttempts = quiz.max_attempts ?? 1;
    const hasUnlimitedAttempts = maxAttempts === 0;

    // Check if user can create new attempts
    const isInstructor = ['OWNER', 'ASSISTANT'].includes(membership.role);
    const canCreateNew = isInstructor || hasUnlimitedAttempts || attemptCount < maxAttempts;

    // Process all attempts with metadata (without counting flag yet)
    const baseAttempts = attempts.map((attempt, index) => {
      const attemptNumber = attemptCount - index; // Reverse numbering (oldest = 1)
      const isCompleted = !!attempt.completed_at;

      // Calculate focus metrics
      let focusMetrics = null;
      const totalMs = attempt.total_duration_ms ?? null;
      const unfocusedMs = attempt.unfocused_duration_ms ?? null;
      if (totalMs !== null && unfocusedMs !== null) {
        const focusedMs = Math.max(0, totalMs - unfocusedMs);
        const percentage = totalMs > 0 ? Math.round((focusedMs / totalMs) * 100) : 100;
        focusMetrics = { totalMs, unfocusedMs, focusedMs, percentage };
      }

      const partialCreditScore =
        typeof attempt.partial_credit_percentage === 'number'
          ? attempt.partial_credit_percentage
          : null;
      const firstAttemptScore =
        typeof attempt.first_attempt_percentage === 'number'
          ? attempt.first_attempt_percentage
          : null;

      return {
        ...attempt,
        attemptNumber,
        status: isCompleted ? 'completed' : 'in_progress',
        focusMetrics,
        partialCreditScore,
        firstAttemptScore,
      };
    });

    const completedAttempts = baseAttempts.filter(
      attempt => attempt.completed_at && attempt.partialCreditScore !== null
    );

    let countingAttemptId = null;
    let currentScore = null;
    let bestScore = null;

    if (completedAttempts.length > 0) {
      bestScore = Math.max(...completedAttempts.map(a => a.partialCreditScore));

      switch (quiz.grading_strategy) {
        case 'HIGHEST': {
          const highest = completedAttempts.reduce((max, attempt) =>
            attempt.partialCreditScore > max.partialCreditScore ? attempt : max
          );
          countingAttemptId = highest.id;
          currentScore = highest.partialCreditScore;
          break;
        }
        case 'MOST_RECENT': {
          const sorted = [...completedAttempts].sort((a, b) => {
            const aTime = a.completed_at ? new Date(a.completed_at).getTime() : 0;
            const bTime = b.completed_at ? new Date(b.completed_at).getTime() : 0;
            return bTime - aTime;
          });

          const mostRecent = sorted[0];
          if (mostRecent) {
            countingAttemptId = mostRecent.id;
            currentScore = mostRecent.partialCreditScore;
          }
          break;
        }
        case 'FIRST': {
          const sorted = [...completedAttempts].sort((a, b) => {
            const aTime = a.started_at ? new Date(a.started_at).getTime() : 0;
            const bTime = b.started_at ? new Date(b.started_at).getTime() : 0;
            return aTime - bTime;
          });

          const first = sorted[0];
          if (first) {
            countingAttemptId = first.id;
            currentScore = first.partialCreditScore;
          }
          break;
        }
        default: {
          const highest = completedAttempts.reduce((max, attempt) =>
            attempt.partialCreditScore > max.partialCreditScore ? attempt : max
          );
          countingAttemptId = highest.id;
          currentScore = highest.partialCreditScore;
          break;
        }
      }
    }

    const processedAttempts = baseAttempts.map(attempt => ({
      ...attempt,
      isCounting: attempt.id === countingAttemptId,
    }));

    return {
      ...quiz,
      attemptCount,
      attempts: processedAttempts,
      attemptsSummary: {
        count: attemptCount,
        canCreateNew,
        bestScore,
        currentScore,
        countingAttemptId,
      },
    };
  });
};

export const publish = async quizId => {
  return prisma.quiz.update({
    where: { id: quizId },
    data: { status: 'PUBLISHED' },
  });
};

export const getStatsByClassroom = async classroomId => {
  return getQuizStatsByOrganization(classroomId);
};

export const getQuizStatsByOrganization = async classroomId => {
  const quizzes = await prisma.quiz.findMany({
    where: { classroom_id: classroomId },
    include: {
      _count: {
        select: { attempts: true },
      },
      attempts: {
        where: { completed_at: { not: null } },
        select: { score: true },
      },
    },
  });

  const stats = {
    totalQuizzes: quizzes.length,
    publishedCount: quizzes.filter(q => q.status === 'PUBLISHED').length,
    draftCount: quizzes.filter(q => q.status === 'DRAFT').length,
    archivedCount: quizzes.filter(q => q.status === 'ARCHIVED').length,
    totalWeight: quizzes
      .filter(q => q.status !== 'ARCHIVED')
      .reduce((sum, q) => sum + (q.weight || 0), 0),
    totalAttempts: quizzes.reduce((sum, q) => sum + q._count.attempts, 0),
    averageScore: null,
  };

  // Calculate overall average score
  const allScores = quizzes
    .flatMap(q => q.attempts.map(a => a.partial_credit_percentage))
    .filter(s => s !== null && s !== undefined);
  if (allScores.length > 0) {
    stats.averageScore = Math.round(allScores.reduce((sum, s) => sum + s, 0) / allScores.length);
  }

  return stats;
};

// Aliases for consistent naming across services
export const createQuiz = create;
export const updateQuiz = update;
export const getQuizById = findById;
export const getQuizzesByClassroom = findByClassroom;
export const publishQuiz = publish;
export const getQuizStatsByClassroom = getStatsByClassroom;
