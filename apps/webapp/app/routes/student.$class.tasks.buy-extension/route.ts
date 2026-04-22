/**
 * Student-facing action: spend tokens to waive the late flag on one of the
 * student's own repository assignments. Owners are the only party who can
 * create a full extension via the main /api/extension endpoint; this variant
 * lets a student self-purchase a `is_late_override = true` on an assignment
 * they own, consuming tokens at `assignment.tokens_per_hour` per hour.
 */
import getPrisma from '@classmoji/database';
import { ClassmojiService } from '@classmoji/services';
import { requireStudentAccess } from '~/utils/helpers';
import type { Route } from './+types/route';

interface BuyExtensionPayload {
  repository_assignment_id?: string;
  hours?: number;
}

export const loader = () => null;

export const action = async ({ params, request }: Route.ActionArgs) => {
  const { userId, classroom } = await requireStudentAccess(request, params.class!, {
    resourceType: 'EXTENSION',
    action: 'buy_extension_with_tokens',
  });

  const body = (await request.json()) as BuyExtensionPayload;
  const repositoryAssignmentId = body.repository_assignment_id;
  const hours = Number(body.hours);
  if (!repositoryAssignmentId || !Number.isFinite(hours) || hours <= 0) {
    return Response.json({ error: 'Invalid request' }, { status: 400 });
  }

  const prisma = getPrisma();
  const ra = await prisma.repositoryAssignment.findUnique({
    where: { id: repositoryAssignmentId },
    include: {
      repository: { select: { classroom_id: true, student_id: true } },
      assignment: { select: { tokens_per_hour: true } },
    },
  });

  if (
    !ra ||
    ra.repository.classroom_id !== classroom.id ||
    ra.repository.student_id !== userId
  ) {
    return Response.json({ error: 'Assignment not found or not yours' }, { status: 403 });
  }

  const tokensPerHour = ra.assignment.tokens_per_hour ?? 0;
  if (tokensPerHour <= 0) {
    return Response.json(
      { error: 'Token extensions are disabled for this assignment.' },
      { status: 400 }
    );
  }

  const cost = Math.round(hours * tokensPerHour);
  const balance = await ClassmojiService.token.getBalance(classroom.id, userId);
  if (cost > balance) {
    return Response.json(
      { error: `Insufficient tokens. Need ${cost}, have ${balance}.` },
      { status: 402 }
    );
  }

  await prisma.$transaction(async tx => {
    await tx.repositoryAssignment.update({
      where: { id: ra.id },
      data: { is_late_override: true },
    });
    const lastTx = await tx.tokenTransaction.findFirst({
      where: { classroom_id: classroom.id, student_id: userId },
      orderBy: { created_at: 'desc' },
    });
    const prevBalance = lastTx?.balance_after ?? 0;
    await tx.tokenTransaction.create({
      data: {
        classroom_id: classroom.id,
        student_id: userId,
        repository_assignment_id: ra.id,
        amount: -cost,
        type: 'PURCHASE',
        hours_purchased: hours,
        balance_after: prevBalance - cost,
        description: `Waived late flag (${hours}h × ${tokensPerHour} tok/h)`,
      },
    });
  });

  return Response.json({ success: true, spent: cost, newBalance: balance - cost });
};
