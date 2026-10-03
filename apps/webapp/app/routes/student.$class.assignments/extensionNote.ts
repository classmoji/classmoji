import dayjs from 'dayjs';

export interface ExtensionNote {
  text: string;
  /** `good` when the hours bought cleared a late submission. */
  tone: 'info' | 'good';
  /**
   * Past the assignment's deadline but inside the hours bought: the row is not
   * late, so its date must not read "overdue".
   */
  inWindow: boolean;
}

interface ExtensionNoteInput {
  /** The assignment's own deadline (ISO). It stays what the row shows. */
  deadline: string | null;
  done: boolean;
  extensionHours: number;
  numLateHours: number;
  isLateOverride: boolean;
  /** When the work was submitted (ISO), if it was. */
  closedAt: string | null;
}

/**
 * What a student's bought extension hours did, said under the row's date. The
 * date itself stays the assignment's deadline; this note says how many hours
 * were applied and whether the student is (still) late. Null when nothing was
 * bought, there is no deadline, or a late override already waives lateness.
 */
export const extensionNote = (
  { deadline, done, extensionHours, numLateHours, isLateOverride, closedAt }: ExtensionNoteInput,
  now = dayjs()
): ExtensionNote | null => {
  if (!deadline || extensionHours <= 0 || isLateOverride) return null;
  const due = dayjs(deadline);
  const extendedTo = due.add(extensionHours, 'hour');
  const applied = `+${extensionHours}h applied`;

  if (!done) {
    if (!now.isAfter(extendedTo)) {
      return {
        text: `${applied} · not late until ${extendedTo.format('MMM D, h:mm A')}`,
        tone: 'info',
        inWindow: now.isAfter(due),
      };
    }
    return { text: `${applied} · ${numLateHours}h still late`, tone: 'info', inWindow: false };
  }

  if (numLateHours > 0) {
    return { text: `${applied} · ${numLateHours}h still late`, tone: 'info', inWindow: false };
  }
  const submittedLate = closedAt !== null && dayjs(closedAt).isAfter(due);
  return submittedLate
    ? { text: `${applied} · no longer late 🎉`, tone: 'good', inWindow: false }
    : { text: applied, tone: 'info', inWindow: false };
};
