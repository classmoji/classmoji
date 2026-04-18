import getPrisma from '@classmoji/database';
import { ClassmojiService } from '@classmoji/services';
import { gradeToEmoji, getEmojiSymbol } from '@classmoji/utils';
import { hashHue, getInitials } from '~/utils/hue';
import type { RosterStudent, RosterInvite } from '~/components/features/roster';

/**
 * Aggregates roster rows for the OWNER's redesigned `/admin/:class/students` screen.
 *
 * For each STUDENT in the classroom we compute:
 *   - submitted count: number of CLOSED repo-assignments / total repo-assignments
 *   - avg grade: average numeric grade across their grades (emoji -> number map)
 *   - tokens: latest token-transaction balance for this classroom
 *   - focus: mean pct_focused across the student's completed quiz attempts
 *
 * Also returns pending classroom invitations so admins can see/revoke them.
 */
export const loadRosterScreenData = async (
  classroomId: string,
  classroomSlug: string
): Promise<{ students: RosterStudent[]; invitations: RosterInvite[] }> => {
  const prisma = getPrisma();

  const [memberships, emojiMappings, invites] = await Promise.all([
    prisma.classroomMembership.findMany({
      where: { classroom_id: classroomId, role: 'STUDENT' },
      include: { user: true },
      orderBy: { user: { name: 'asc' } },
    }),
    prisma.emojiMapping.findMany({
      where: { classroom_id: classroomId },
      orderBy: { grade: 'desc' },
    }),
    ClassmojiService.classroomInvite.findInvitesByClassroomId(classroomId),
  ]);

  const emojiToNumber: Record<string, number> = {};
  for (const m of emojiMappings) {
    emojiToNumber[m.emoji] = Math.trunc(m.grade as unknown as number);
  }

  const rows = await Promise.all(
    memberships.map(async ({ user }) => {
      const studentId = user.id;

      // Submitted: count CLOSED vs total repo-assignments across this student's repos.
      const [totalRepoAssignments, closedRepoAssignments] = await Promise.all([
        prisma.repositoryAssignment.count({
          where: {
            repository: { classroom_id: classroomId, student_id: studentId },
          },
        }),
        prisma.repositoryAssignment.count({
          where: {
            status: 'CLOSED',
            repository: { classroom_id: classroomId, student_id: studentId },
          },
        }),
      ]);

      // Avg grade: collect all emoji grades on this student's repo-assignments,
      // convert through the classroom mapping, and average.
      const grades = await prisma.assignmentGrade.findMany({
        where: {
          repository_assignment: {
            repository: { classroom_id: classroomId, student_id: studentId },
          },
        },
        select: { emoji: true },
      });

      let avg: number | null = null;
      let avgEmoji: string | null = null;
      if (grades.length > 0 && Object.keys(emojiToNumber).length > 0) {
        let sum = 0;
        let n = 0;
        for (const g of grades) {
          const v = emojiToNumber[g.emoji];
          if (typeof v === 'number') {
            sum += v;
            n += 1;
          }
        }
        if (n > 0) {
          avg = sum / n;
          const key = gradeToEmoji(avg, emojiToNumber);
          avgEmoji = key ? getEmojiSymbol(key) : null;
        }
      }

      // Tokens: latest transaction's balance_after.
      const latestTxn = await prisma.tokenTransaction.findFirst({
        where: { classroom_id: classroomId, student_id: studentId },
        orderBy: { created_at: 'desc' },
        select: { balance_after: true },
      });
      const tokens = latestTxn?.balance_after ?? 0;

      // Focus: average pct_focused across completed attempts.
      const attempts = await prisma.quizAttempt.findMany({
        where: {
          user_id: studentId,
          completed_at: { not: null },
          total_duration_ms: { not: null },
          quiz: { classroom_id: classroomId },
        },
        select: {
          total_duration_ms: true,
          unfocused_duration_ms: true,
        },
      });

      let focus: number | null = null;
      if (attempts.length > 0) {
        const ratios: number[] = [];
        for (const a of attempts) {
          const total = a.total_duration_ms ?? 0;
          if (total <= 0) continue;
          const unfocused = a.unfocused_duration_ms ?? 0;
          ratios.push(Math.max(0, Math.min(1, (total - unfocused) / total)));
        }
        if (ratios.length > 0) {
          const mean = ratios.reduce((s, r) => s + r, 0) / ratios.length;
          focus = Math.round(mean * 100);
        }
      }

      const displayName = user.name || user.login || 'Unknown';
      const href = user.login
        ? `/admin/${classroomSlug}/students/${user.login}`
        : `/admin/${classroomSlug}/students`;

      return {
        id: user.id,
        name: displayName,
        initials: getInitials(user.name, user.login),
        hue: hashHue(user.id),
        submitted: `${closedRepoAssignments}/${totalRepoAssignments}`,
        avg,
        avgEmoji,
        tokens,
        focus,
        href,
      } satisfies RosterStudent;
    })
  );

  const invitations: RosterInvite[] = invites.map((inv) => ({
    id: inv.id,
    email: inv.school_email,
    initials: getInitials(null, inv.school_email),
    hue: hashHue(inv.id),
    invitedAt:
      inv.created_at instanceof Date ? inv.created_at.toISOString() : String(inv.created_at),
  }));

  return { students: rows, invitations };
};
