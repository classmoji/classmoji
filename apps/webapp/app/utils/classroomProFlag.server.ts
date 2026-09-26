import { ClassmojiService } from '@classmoji/services';

/**
 * Whether a classroom is on Pro, as a bare boolean — the one fact the staff
 * nav needs to decide whether to show its Pro-only entries (Quizzes, Forms).
 *
 * Decided by `subscription.getProStateForClassroomId`, the same rule the Pro
 * route gates (`assertProTier`) apply, so the nav cannot offer an entry whose
 * route then refuses. Only the boolean leaves this function: the resolver also
 * hands back the paying owner's subscription row, and that row is owner
 * information (it is why `/api/get-org-subscription` admits OWNER alone).
 *
 * A failed lookup answers `false` rather than throwing. The staff layouts call
 * this inside the same try block as their access check, and a throw there
 * would replace the whole nav with the empty fallback; hiding the Pro entries
 * is the smaller failure, and the routes behind them run their own Pro gate.
 *
 * Takes a classroom id the CALLER has already authorized. This function gates
 * nothing itself; it belongs after a layout loader's access check.
 */
export const loadClassroomIsPro = async (classroomId: string): Promise<boolean> => {
  try {
    const { isPro } = await ClassmojiService.subscription.getProStateForClassroomId(classroomId);
    return isPro === true;
  } catch (error) {
    console.error('[loadClassroomIsPro] Pro state lookup failed', error);
    return false;
  }
};
