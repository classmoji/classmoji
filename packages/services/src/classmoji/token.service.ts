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
      throw new Error(`Insufficient token balance. Current balance: ${studentBalance}, attempting to spend: ${Math.abs(data.amount)}`);
    }

    return tx.tokenTransaction.create({
      data: {
        ...(data as Prisma.TokenTransactionUncheckedCreateInput),
        balance_after: newBalance,
      },
    });
  });
};

export const findTransactions = async (query: Prisma.TokenTransactionWhereInput) => {
  return getPrisma().tokenTransaction.findMany({
    where: query,
    include: {
      student: true,
      repository_assignment: {
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
        description: data.description,
        repository_assignment_id: data.repositoryAssignmentId,
      },
    });
  });
};

export const updateTransaction = async (
  id: string,
  data: Record<string, unknown>
) => {
  return getPrisma().tokenTransaction.update({
    where: { id },
    data: data as Prisma.TokenTransactionUncheckedUpdateInput,
  });
};
