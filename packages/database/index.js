import { PrismaClient } from '@prisma/client';
import dayjs from 'dayjs';

// Helper function to calculate extension hours from transactions
const calculateExtensionHours = tokenTransactions => {
  return (tokenTransactions || []).reduce(
    (acc, transaction) => acc + (transaction.hours_purchased || 0),
    0
  );
};

// Helper function to calculate late hours
const calculateLateHours = (closedAt, studentDeadline, tokenTransactions) => {
  let totalHoursLate = dayjs(closedAt || dayjs()).diff(studentDeadline, 'hours');
  totalHoursLate = Math.max(totalHoursLate, 0);
  return totalHoursLate - calculateExtensionHours(tokenTransactions);
};

let prisma;

if (typeof window === 'undefined') {
  // Initialize Prisma client
  const basePrisma = new PrismaClient();

  // Client extensions for computed fields
  prisma = basePrisma.$extends({
    result: {
      user: {
        avatar_url: {
          needs: { provider_id: true },
          compute(user) {
            // Use provider_id (GitHub user ID) for avatar
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
          compute(team) {
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
          compute(gitOrg) {
            return `https://avatars.githubusercontent.com/u/${gitOrg.provider_id}?v=4`;
          },
        },
      },
      classroom: {
        num_students: {
          needs: { memberships: true },
          compute(classroom) {
            return classroom.memberships.filter(membership => membership.role === 'STUDENT').length;
          },
        },
        num_staff: {
          needs: { memberships: true },
          compute(classroom) {
            return classroom.memberships.filter(membership => membership.role !== 'STUDENT').length;
          },
        },
      },
      repositoryAssignment: {
        extension_hours: {
          needs: { token_transactions: true },
          compute(repoAssignment) {
            return calculateExtensionHours(repoAssignment.token_transactions);
          },
        },
        num_late_hours: {
          needs: { assignment: true, token_transactions: true, closed_at: true },
          compute(repoAssignment) {
            return calculateLateHours(
              repoAssignment.closed_at,
              repoAssignment.assignment.student_deadline,
              repoAssignment.token_transactions
            );
          },
        },
        is_late: {
          needs: { assignment: true, closed_at: true, is_late_override: true, token_transactions: true },
          compute(repoAssignment) {
            // Check for override
            if (repoAssignment.is_late_override) return false;

            const studentDeadline = dayjs(repoAssignment.assignment?.student_deadline);

            if (!studentDeadline.isValid()) return false; // No deadline, not late
            if (!repoAssignment.closed_at) return dayjs().isAfter(studentDeadline); // Not closed, compare with current time

            // Use helper function instead of referencing computed field
            return calculateLateHours(
              repoAssignment.closed_at,
              studentDeadline,
              repoAssignment.token_transactions
            ) > 0;
          },
        },
        should_be_zero: {
          needs: { assignment: true, closed_at: true, grades: true, status: true, is_late_override: true },
          compute(repoAssignment) {
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
  });

  // Graceful shutdown handling
  const gracefulShutdown = async signal => {
    console.log(`Received ${signal}. Closing Prisma connection...`);
    await prisma.$disconnect();
    // eslint-disable-next-line no-process-exit
    process.exit(0);
  };

  process.on('SIGINT', gracefulShutdown);
  process.on('SIGTERM', gracefulShutdown);
  process.on('beforeExit', async () => {
    await prisma.$disconnect();
  });

  // Handle uncaught exceptions
  process.on('uncaughtException', async error => {
    console.error('Uncaught Exception:', error);
    await prisma.$disconnect();
    // eslint-disable-next-line no-process-exit
    process.exit(1);
  });

  process.on('unhandledRejection', async (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
    await prisma.$disconnect();
    // eslint-disable-next-line no-process-exit
    process.exit(1);
  });
}

export default prisma;
