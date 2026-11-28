import { reportError } from '@classmoji/utils/error-report';

/**
 * Report a failed multiplex `join`, unless the client sent a slide id that is
 * not a string: anyone can open the socket, and the lookup then fails on the
 * input (Prisma's validation error), which is the client's, not a fault.
 * Only the report is skipped; the caller logs and answers as before.
 */
export function reportJoinFailure(error: unknown, slideId: unknown): void {
  if (typeof slideId !== 'string') return;
  if ((error as { name?: unknown } | null)?.name === 'PrismaClientValidationError') return;
  reportError(error, { surface: 'slides.multiplex.join' });
}
