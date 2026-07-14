import getPrisma from '@classmoji/database';
import type { Prisma, TokenTransactionType } from '@prisma/client';

interface UpdateExtensionInput {
  classroom_id: string;
  student_id: string;
  amount: number;
  [key: string]: unknown;
}

interface AssignToStudentInput {
  classroomId: string;
  studentId: string;
  amount: number;
  type?: TokenTransactionType | string;
  description?: string;
  repositoryAssignmentId?: string | null;
  [key: string]: unknown;
}

export const getBalance = async (classroomId: string, studentId: string) => {
  const transaction = await getPrisma().tokenTransaction.findFirst({
    where: {
      classroom_id: classroomId,
      student_id: studentId,
    },
    orderBy: {
      created_at: 'desc',
    },
  });

  if (!transaction) {
    return 0;
  }

  return transaction.balance_after;
};

export const updateExtension = async (data: UpdateExtensionInput) => {
  return getPrisma().$transaction(async tx => {
    const transaction = await tx.tokenTransaction.findFirst({
      where: {
        classroom_id: data.classroom_id,
        student_id: data.student_id,
      },
      orderBy: {
        created_at: 'desc',
      },
    });

    // Handle case where student has no previous transactions
    const studentBalance = transaction?.balance_after || 0;
    const newBalance = studentBalance + data.amount;

    // Validate that balance won't go negative
    if (newBalance < 0) {
      throw new Error(
        `Insufficient token balance. Current balance: ${studentBalance}, attempting to spend: ${Math.abs(data.amount)}`
      );
    }

    return tx.tokenTransaction.create({
      data: {
        ...(data as Prisma.TokenTransactionUncheckedCreateInput),
        balance_after: newBalance,
        // `description` is non-nullable (@default('')); coalesce a possibly-null value from
        // the spread so it can't trigger Prisma's misleading "Argument `classroom` is
        // missing" error (same guard as assignToStudent).
        description: (data.description as string | null | undefined) ?? '',
      },
    });
  });
};

/**
 * Student purchase of late-hour extensions (plan §5.2 gap 6, extract-first —
 * moved from the student.$class.assignments purchaseExtensionHours action).
 *
 * Price and eligibility are recomputed HERE from the DB — callers must never
 * trust a client-supplied price (S9). Re-enforces the popover's gates: no late
 * override, tokens_per_hour configured, deadline passed, and the purchasable
 * cap = hours past deadline minus hours already purchased (OPEN submissions
 * only). The balance check runs inside updateExtension's transaction.
 *
 * NOTE: callers are responsible for authorizing `studentId` (self-access or
 * teaching-team) and for verifying the submission belongs to that student
 * where required — this mirrors the original route contract.
 */
export const purchaseExtensionHours = async ({
  classroomId,
  studentId,
  gitRepoAssignmentId,
  hours,
}: {
  classroomId: string;
  studentId: string;
  gitRepoAssignmentId: string;
  hours: number;
}) => {
  if (!Number.isInteger(hours) || hours <= 0) {
    throw new Error('Invalid hours: Must be a positive whole number.');
  }

  const repoAssignment = await getPrisma().gitRepoAssignment.findUnique({
    where: { id: gitRepoAssignmentId },
    include: { assignment: true, git_repo: true },
  });
  if (!repoAssignment || repoAssignment.git_repo?.classroom_id !== classroomId) {
    throw new Error('Repository assignment not found.');
  }
  if (repoAssignment.is_late_override) {
    throw new Error('Extensions are unavailable: a late override is in effect.');
  }

  const tokensPerHour = repoAssignment.assignment?.tokens_per_hour ?? 0;
  if (tokensPerHour <= 0) {
    throw new Error('Token cost not configured for this assignment.');
  }

  const deadlineMs = repoAssignment.assignment?.student_deadline
    ? new Date(repoAssignment.assignment.student_deadline).getTime()
    : null;
  if (deadlineMs === null || deadlineMs >= Date.now()) {
    throw new Error('The deadline for this assignment has not passed yet.');
  }

  // Mirror the popover's num_late_hours cap: hours past the deadline minus
  // hours already purchased. Only OPEN submissions can accrue late hours.
  const purchaseTransactions = await getPrisma().tokenTransaction.findMany({
    where: {
      git_repo_assignment_id: repoAssignment.id,
      student_id: studentId,
      type: 'PURCHASE',
    },
  });
  const alreadyPurchasedHours = purchaseTransactions.reduce(
    (sum, t) => sum + (t.hours_purchased ?? 0),
    0
  );
  const hoursPastDeadline = Math.max(0, Math.ceil((Date.now() - deadlineMs) / 3_600_000));
  const numLateHours =
    repoAssignment.status === 'OPEN' ? Math.max(0, hoursPastDeadline - alreadyPurchasedHours) : 0;

  if (numLateHours <= 0) {
    throw new Error('No purchasable late hours remain for this assignment.');
  }
  if (hours > numLateHours) {
    throw new Error(
      `You can purchase at most ${numLateHours} more late hour(s) for this assignment.`
    );
  }

  // Recompute the price; the balance check still runs inside updateExtension.
  return updateExtension({
    classroom_id: classroomId,
    student_id: studentId,
    git_repo_assignment_id: repoAssignment.id,
    amount: -(tokensPerHour * hours),
    hours_purchased: hours,
    type: 'PURCHASE',
    description: `Purchase of ${hours} hour(s).`,
  });
};

export const findTransactions = async (query: Prisma.TokenTransactionWhereInput) => {
  return getPrisma().tokenTransaction.findMany({
    where: query,
    include: {
      student: true,
      git_repo_assignment: {
        include: {
          assignment: true,
        },
      },
      assignment_grade: true,
    },
    orderBy: {
      created_at: 'desc',
    },
  });
};

export const assignToStudent = async (data: AssignToStudentInput) => {
  return getPrisma().$transaction(async tx => {
    const transaction = await tx.tokenTransaction.findFirst({
      where: {
        classroom_id: data.classroomId,
        student_id: data.studentId,
      },
      orderBy: {
        created_at: 'desc',
      },
    });

    const studentBalance = transaction?.balance_after || 0;
    const newBalance = studentBalance + data.amount;

    return tx.tokenTransaction.create({
      data: {
        type: (data.type as TokenTransactionType) || 'GAIN',
        amount: data.amount,
        balance_after: newBalance,
        student_id: data.studentId,
        classroom_id: data.classroomId,
        // `description` is a non-nullable column (@default('')). A null here makes
        // Prisma's create validation fail with a misleading "Argument `classroom`
        // is missing", so coalesce null/undefined to an empty string.
        description: data.description ?? '',
        git_repo_assignment_id: data.repositoryAssignmentId,
      },
    });
  });
};

export const updateTransaction = async (id: string, data: Record<string, unknown>) => {
  return getPrisma().tokenTransaction.update({
    where: { id },
    data: data as Prisma.TokenTransactionUncheckedUpdateInput,
  });
};
