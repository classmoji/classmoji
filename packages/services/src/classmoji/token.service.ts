import getPrisma, { GIT_IDENTITY } from '@classmoji/database';
import { effectiveTokensPerHour, withLogins } from '@classmoji/utils';
import { Prisma } from '@prisma/client';
import type { TokenTransactionType } from '@prisma/client';
import { recordPushAfterExtension } from './gitRepoAssignment.service.ts';

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

/**
 * A student's ledger is ordered by created_at, newest first. The id breaks a
 * tie between rows stored at the same millisecond, so every reader and writer
 * agrees on which row is the latest.
 */
const LATEST_FIRST: Prisma.TokenTransactionOrderByWithRelationInput[] = [
  { created_at: 'desc' },
  { id: 'desc' },
];

export type LedgerTx = Prisma.TransactionClient;

export const LEDGER_TX = { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted };

/**
 * Serialize writes to one student's ledger in one classroom, so each new row
 * is computed from the true latest balance. Every ledger writer calls this
 * inside its transaction before it reads the latest row; the lock is released
 * when the transaction commits or rolls back. Two pairs that hash to the same
 * key only wait on each other, which is harmless.
 *
 * The lock relies on read-committed statement-level snapshots: the read that
 * follows it sees every row committed by the writer that held the lock before.
 * Callers therefore pin `LEDGER_TX` (read committed) explicitly rather than
 * depend on the database default.
 *
 * `$executeRaw` because pg_advisory_xact_lock returns void, which `$queryRaw`
 * cannot deserialize. The values are bound as parameters.
 */
const lockLedger = async (tx: LedgerTx, classroomId: string, studentId: string) => {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${classroomId}::text || ':' || ${studentId}::text, 0))`;
};

/**
 * Lock several students' ledgers in one classroom, for a transaction that
 * writes to all of them (a team's grade). Each id is locked once, in sorted
 * order, so two transactions over overlapping sets of students always take
 * their locks in the same order and cannot wait on each other in a cycle.
 */
export const lockLedgers = async (tx: LedgerTx, classroomId: string, studentIds: string[]) => {
  for (const studentId of [...new Set(studentIds)].sort()) {
    await lockLedger(tx, classroomId, studentId);
  }
};

/**
 * Serialize grade changes on one submission (GitRepoAssignment). Grade
 * transactions take this first, before any ledger lock, so two grade changes
 * on the same submission run one after the other even when it pays nobody (a
 * repo with no owner, or a team with no members) and so takes no ledger lock.
 * Purchases and cancels take only ledger locks, so the order of locks stays
 * the same everywhere. An advisory lock, not a row lock on the submission:
 * ledger inserts already take key-share locks on that row.
 */
export const lockSubmission = async (tx: LedgerTx, gitRepoAssignmentId: string) => {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('gra:' || ${gitRepoAssignmentId}::text, 0))`;
};

/** The latest row of a student's ledger. Call only after `lockLedger`. */
const findLatest = (tx: LedgerTx, classroomId: string, studentId: string) =>
  tx.tokenTransaction.findFirst({
    where: { classroom_id: classroomId, student_id: studentId },
    orderBy: LATEST_FIRST,
  });

/**
 * created_at for a new ledger row: now, but always strictly after the latest
 * row it was computed from, so the ledger's order is the order rows were
 * written in. A default timestamp comes from whichever clock fills it (the
 * writing process, or the database at transaction start), and two rows can
 * land in the same millisecond; either could sort a new row at or before the
 * one it was computed from. The column keeps milliseconds, hence +1 ms.
 */
const nextCreatedAt = (latest: { created_at: Date } | null) =>
  new Date(Math.max(Date.now(), latest ? latest.created_at.getTime() + 1 : 0));

export const getBalance = async (classroomId: string, studentId: string) => {
  const transaction = await getPrisma().tokenTransaction.findFirst({
    where: {
      classroom_id: classroomId,
      student_id: studentId,
    },
    orderBy: LATEST_FIRST,
  });

  if (!transaction) {
    return 0;
  }

  return transaction.balance_after;
};

export const updateExtension = async (data: UpdateExtensionInput) => {
  return getPrisma().$transaction(async tx => {
    await lockLedger(tx, data.classroom_id, data.student_id);
    const transaction = await findLatest(tx, data.classroom_id, data.student_id);

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
        created_at: nextCreatedAt(transaction),
      },
    });
  }, LEDGER_TX);
};

/**
 * Student purchase of extension hours (plan §5.2 gap 6, extract-first —
 * moved from the student.$class.assignments purchaseExtensionHours action).
 *
 * Price and eligibility are recomputed HERE from the DB — callers must never
 * trust a client-supplied price (S9). Re-enforces the popover's gates: no late
 * override, a price per hour (the assignment's own tokens_per_hour, else the
 * classroom's default_tokens_per_hour) and a deadline to extend. The balance
 * check runs inside updateExtension's transaction.
 *
 * Hours can be bought at any time: before the deadline (they push the
 * student's own deadline out, which is the cutoff recordPush reads), while the
 * work is late, and after it is submitted or graded (num_late_hours subtracts
 * them, so the late penalty shrinks). There is no cap but the balance.
 *
 * The submission must be the paying student's own: their repo, or a repo of a
 * team they are on. Anything else reads as not found.
 *
 * On a push-mode (REPO) submission, a push the old cutoff left out is
 * re-read once the purchase has committed (`recordPushAfterExtension`).
 *
 * NOTE: callers are responsible for authorizing `studentId` (self-access or
 * teaching-team).
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
  const gitRepo = repoAssignment.git_repo;
  const onTeam =
    gitRepo.student_id !== studentId && gitRepo.team_id
      ? await getPrisma().teamMembership.findFirst({
          where: { team_id: gitRepo.team_id, user_id: studentId },
          select: { id: true },
        })
      : null;
  if (gitRepo.student_id !== studentId && !onTeam) {
    throw new Error('Repository assignment not found.');
  }
  if (repoAssignment.is_late_override) {
    throw new Error('Extensions are unavailable: a late override is in effect.');
  }
  if (!repoAssignment.assignment?.student_deadline) {
    throw new Error('Extensions are unavailable: this assignment has no deadline.');
  }

  // The assignment's own price, else the classroom's default.
  const settings = await getPrisma().classroomSettings.findUnique({
    where: { classroom_id: classroomId },
    select: { default_tokens_per_hour: true },
  });
  const tokensPerHour = effectiveTokensPerHour(
    repoAssignment.assignment?.tokens_per_hour,
    settings?.default_tokens_per_hour
  );
  if (tokensPerHour <= 0) {
    throw new Error('Token cost not configured for this assignment.');
  }

  // Recompute the price; the balance check still runs inside updateExtension.
  const transaction = await updateExtension({
    classroom_id: classroomId,
    student_id: studentId,
    git_repo_assignment_id: repoAssignment.id,
    amount: -(tokensPerHour * hours),
    hours_purchased: hours,
    type: 'PURCHASE',
    description: `Purchase of ${hours} hour(s).`,
  });

  // Push mode: a push the old cutoff left out may count now. The purchase has
  // committed, so a failure here is logged, never thrown; the next push
  // stamps the submission as usual.
  if (repoAssignment.assignment.submission_mode === 'REPO') {
    try {
      await recordPushAfterExtension(repoAssignment.id);
    } catch (error) {
      console.error('[token] could not re-read the submission after an extension purchase', {
        gitRepoAssignmentId: repoAssignment.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return transaction;
};

/**
 * Cancel a purchase of extension hours and refund it, exactly once. Only a
 * PURCHASE that is not yet cancelled qualifies; the flip to `is_cancelled` is
 * conditional and shares a DB transaction with the REFUND row, so a repeated
 * or concurrent request finds nothing to flip and refunds nothing. The REFUND
 * carries the hours as a negative, which takes the extension back wherever
 * hours are summed.
 */
export const cancelPurchase = async (transactionId: string) => {
  return getPrisma().$transaction(async tx => {
    // The ledger to lock is the purchase's; a row's classroom and student
    // never change, so they can be read before the lock.
    const owner = await tx.tokenTransaction.findUnique({
      where: { id: transactionId },
      select: { classroom_id: true, student_id: true },
    });
    if (!owner) {
      throw new Error('Only a purchase that is not already cancelled can be cancelled.');
    }
    await lockLedger(tx, owner.classroom_id, owner.student_id);

    const flipped = await tx.tokenTransaction.updateMany({
      where: { id: transactionId, type: 'PURCHASE', is_cancelled: false },
      data: { is_cancelled: true },
    });
    if (flipped.count !== 1) {
      throw new Error('Only a purchase that is not already cancelled can be cancelled.');
    }

    const purchase = await tx.tokenTransaction.findUniqueOrThrow({ where: { id: transactionId } });
    const latest = await findLatest(tx, purchase.classroom_id, purchase.student_id);
    const refund = Math.abs(purchase.amount);
    const hours = purchase.hours_purchased ?? 0;

    return tx.tokenTransaction.create({
      data: {
        classroom_id: purchase.classroom_id,
        student_id: purchase.student_id,
        git_repo_assignment_id: purchase.git_repo_assignment_id,
        amount: refund,
        hours_purchased: 0 - hours,
        type: 'REFUND',
        balance_after: (latest?.balance_after ?? 0) + refund,
        description: `Refund of ${hours} hours.`,
        created_at: nextCreatedAt(latest),
      },
    });
  }, LEDGER_TX);
};

export const findTransactions = async (query: Prisma.TokenTransactionWhereInput) => {
  return withLogins(
    await getPrisma().tokenTransaction.findMany({
      where: query,
      include: {
        student: { include: GIT_IDENTITY },
        git_repo_assignment: {
          include: {
            assignment: true,
          },
        },
        assignment_grade: true,
      },
      orderBy: LATEST_FIRST,
    })
  );
};

/** The write behind assignToStudent. Call only after `lockLedger`. */
const appendToLedger = async (tx: LedgerTx, data: AssignToStudentInput) => {
  const transaction = await findLatest(tx, data.classroomId, data.studentId);

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
      created_at: nextCreatedAt(transaction),
    },
  });
};

/**
 * Append a row to a student's ledger. Without `tx` it runs in its own
 * transaction and takes the student's ledger lock. With `tx` it writes inside
 * the caller's transaction, so the row commits or rolls back with the rest of
 * the caller's work; the caller must already hold the lock (`lockLedgers`)
 * and run at read committed.
 */
export const assignToStudent = async (data: AssignToStudentInput, tx?: LedgerTx) => {
  if (tx) return appendToLedger(tx, data);
  return getPrisma().$transaction(async ownTx => {
    await lockLedger(ownTx, data.classroomId, data.studentId);
    return appendToLedger(ownTx, data);
  }, LEDGER_TX);
};

export const updateTransaction = async (id: string, data: Record<string, unknown>) => {
  return getPrisma().tokenTransaction.update({
    where: { id },
    data: data as Prisma.TokenTransactionUncheckedUpdateInput,
  });
};
