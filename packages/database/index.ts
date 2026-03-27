import { PrismaClient } from '@prisma/client';
import dayjs, { type Dayjs } from 'dayjs';

interface TokenTransaction {
  hours_purchased?: number | null;
}

const calculateExtensionHours = (tokenTransactions: TokenTransaction[]): number => {
  return (tokenTransactions || []).reduce(
    (acc, transaction) => acc + (transaction.hours_purchased || 0),
    0
  );
};

const calculateLateHours = (
  closedAt: Date | Dayjs | null,
  studentDeadline: Date | Dayjs | string,
  tokenTransactions: TokenTransaction[]
): number => {
  let totalHoursLate = dayjs(closedAt || dayjs()).diff(studentDeadline, 'hours');
  totalHoursLate = Math.max(totalHoursLate, 0);
  return totalHoursLate - calculateExtensionHours(tokenTransactions);
};

function createPrismaClient() {
  const basePrisma = new PrismaClient();

  // Prisma's $extends type system doesn't fully support relation fields in `needs`
  // under strict mode. These computed fields work correctly at runtime.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (basePrisma.$extends as any)({
    result: {
      user: {
        avatar_url: {
          needs: { provider_id: true },
          compute(user: { provider_id: string | null }) {
            if (!user.provider_id) {
              return 'https://cdn-icons-png.flaticon.com/512/25/25231.png';
            }
            return `https://avatars.githubusercontent.com/u/${user.provider_id}?v=4`;
          },
        },
      },
      team: {
        avatar_url: {
          needs: { provider_id: true },
          compute(team: { provider_id: string | null }) {
            if (!team.provider_id) {
              return 'https://cdn-icons-png.flaticon.com/512/25/25231.png';
            }
            return `https://avatars.githubusercontent.com/t/${team.provider_id}?s=116&v=4`;
          },
        },
      },
      gitOrganization: {
        avatar_url: {
          needs: { provider_id: true },
          compute(gitOrg: { provider_id: string }) {
            return `https://avatars.githubusercontent.com/u/${gitOrg.provider_id}?v=4`;
          },
        },
      },
      classroom: {
        num_students: {
          needs: { memberships: true },
          compute(classroom: { memberships: { role: string }[] }) {
            return classroom.memberships.filter(membership => membership.role === 'STUDENT').length;
          },
        },
        num_staff: {
          needs: { memberships: true },
          compute(classroom: { memberships: { role: string }[] }) {
            return classroom.memberships.filter(membership => membership.role !== 'STUDENT').length;
          },
        },
      },
      repositoryAssignment: {
        extension_hours: {
          needs: { token_transactions: true },
          compute(repoAssignment: { token_transactions: TokenTransaction[] }) {
            return calculateExtensionHours(repoAssignment.token_transactions);
          },
        },
        num_late_hours: {
          needs: { assignment: true, token_transactions: true, closed_at: true },
          compute(repoAssignment: { assignment: { student_deadline: Date }; token_transactions: TokenTransaction[]; closed_at: Date | null }) {
            return calculateLateHours(
              repoAssignment.closed_at,
              repoAssignment.assignment.student_deadline,
              repoAssignment.token_transactions
            );
          },
        },
        is_late: {
          needs: { assignment: true, closed_at: true, is_late_override: true, token_transactions: true },
          compute(repoAssignment: { assignment: { student_deadline?: Date }; closed_at: Date | null; is_late_override: boolean; token_transactions: TokenTransaction[] }) {
            if (repoAssignment.is_late_override) return false;

            const studentDeadline = dayjs(repoAssignment.assignment?.student_deadline);

            if (!studentDeadline.isValid()) return false;
            if (!repoAssignment.closed_at) return dayjs().isAfter(studentDeadline);

            return calculateLateHours(
              repoAssignment.closed_at,
              studentDeadline,
              repoAssignment.token_transactions
            ) > 0;
          },
        },
        should_be_zero: {
          needs: { assignment: true, closed_at: true, grades: true, status: true, is_late_override: true },
          compute(repoAssignment: { assignment: { student_deadline?: Date }; closed_at: Date | null; grades: unknown[]; status: string; is_late_override: boolean }) {
            const hasDeadlinePassed = dayjs(repoAssignment.assignment?.student_deadline).isBefore(
              dayjs()
            );
            const isOpen = repoAssignment.status === 'OPEN';
            return (
              hasDeadlinePassed &&
              isOpen &&
              !repoAssignment.is_late_override &&
              repoAssignment.grades.length === 0
            );
          },
        },
      },
    },
  }) as PrismaClient;
}

let _prisma: PrismaClient | null = null;

const disconnectPrisma = async () => {
  if (_prisma) {
    await _prisma.$disconnect();
  }
};

if (typeof window === 'undefined') {
  _prisma = createPrismaClient();

  const gracefulShutdown = async (signal: string) => {
    console.log(`Received ${signal}. Closing Prisma connection...`);
    await disconnectPrisma();
    // eslint-disable-next-line no-process-exit
    process.exit(0);
  };

  process.on('SIGINT', gracefulShutdown);
  process.on('SIGTERM', gracefulShutdown);
  process.on('beforeExit', async () => {
    await disconnectPrisma();
  });

  process.on('uncaughtException', async (error: Error) => {
    console.error('Uncaught Exception:', error);
    await disconnectPrisma();
    // eslint-disable-next-line no-process-exit
    process.exit(1);
  });

  process.on('unhandledRejection', async (reason: unknown, promise: Promise<unknown>) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
    await disconnectPrisma();
    // eslint-disable-next-line no-process-exit
    process.exit(1);
  });
}

export function getPrisma(): PrismaClient {
  if (!_prisma) throw new Error('[database] Prisma client accessed before initialization. Ensure the server has initialized before calling getPrisma().');
  return _prisma;
}

export default getPrisma;
