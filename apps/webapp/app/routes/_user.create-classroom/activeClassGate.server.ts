import { ClassmojiService } from '@classmoji/services';
import type { ActiveClassroomSummary } from '@classmoji/services';

/**
 * The Free plan's one-active-class rule at classroom creation, shared by the
 * Github and Gitlab create paths.
 *
 * With a free slot, the classroom is created ACTIVE, and the create
 * transaction re-checks under the plan-owner lock (`assertCanCreateActive`),
 * so two creates at once cannot both take the slot. Without one, the page is
 * told which of the creator's classes hold it; picking one ("Archive X and
 * continue") creates the new classroom LOCKED, so it holds no slot while the
 * Github/Gitlab provisioning runs, and only after that succeeds are the old
 * class archived and the new one activated, in one step
 * (`classroomLifecycle.swapActive`). A failed provisioning leaves the old
 * class exactly as it was.
 */

/** What the create page needs to offer "Archive X and continue". */
export interface ActiveClassLimitPayload {
  error: string;
  activeClassLimit: { activeClassrooms: ActiveClassroomSummary[] };
}

export type CreateGate =
  | { ok: true; status: 'ACTIVE' | 'LOCKED'; archiveClassroomId: string | null }
  | { ok: false; response: ActiveClassLimitPayload | { error: string } };

export const limitPayload = (
  message: string,
  activeClassrooms: ActiveClassroomSummary[]
): ActiveClassLimitPayload => ({ error: message, activeClassLimit: { activeClassrooms } });

export const gateClassroomCreate = async (
  userId: string,
  archiveClassroomId: unknown
): Promise<CreateGate> => {
  const allowance = await ClassmojiService.classroomLifecycle.allowanceFor(userId);
  if (allowance.canCreate) return { ok: true, status: 'ACTIVE', archiveClassroomId: null };

  if (typeof archiveClassroomId !== 'string' || !archiveClassroomId) {
    return {
      ok: false,
      response: limitPayload(
        'The Free plan includes one active class at a time. Archive your current class to start another, or upgrade to Pro.',
        allowance.active
      ),
    };
  }
  // Only one of the classes that hold their slot: their own, by construction.
  if (!allowance.active.some(classroom => classroom.id === archiveClassroomId)) {
    return { ok: false, response: { error: 'That class is not one of your active classes.' } };
  }
  return { ok: true, status: 'LOCKED', archiveClassroomId };
};

/**
 * After provisioning: archive the chosen class and activate the new one.
 * Returns a sentence for the page when that could not happen (the new class
 * then stays locked and the old one active), or null.
 */
export const finishArchiveAndContinue = async ({
  newClassroomId,
  archiveClassroomId,
  userId,
}: {
  newClassroomId: string;
  archiveClassroomId: string;
  userId: string;
}): Promise<string | null> => {
  try {
    await ClassmojiService.classroomLifecycle.swapActive({
      activateClassroomId: newClassroomId,
      archiveClassroomId,
      actorUserId: userId,
      tool: 'web:classroom.create_archive_and_continue',
    });
    return null;
  } catch (error: unknown) {
    console.error('[create-classroom] archive-and-continue failed:', error);
    return 'Your new class was created but is still locked, and your other class is still active. Archive it in its Class Settings, then set the new class to Active.';
  }
};
