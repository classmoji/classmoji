/**
 * The "Live editing" switch on the Content settings tab: turns live
 * collaborative editing of pages and slides on or off for one classroom
 * (`Classroom.collab_enabled`).
 *
 * The route action gates (OWNER + classroom open to writes) and hands the
 * gate's result here; everything after the gate lives in this module so it
 * can be tested without the route's view layer.
 *
 * Order: write the column, THEN tell the collab server. The column is the
 * truth every editor's join and the collab server's periodic re-check read,
 * so it lands first; the collab call only makes the change take effect now
 * instead of at the next re-check.
 *
 * When the collab server cannot be reached, the flag is still written —
 * refusing would leave the owner unable to turn live editing OFF exactly when
 * the live service is in trouble, which is the safer direction:
 *   - turning OFF: every open connection is re-checked by the collab server
 *     (about once a minute) and closed when the flag is off; the last editor
 *     leaving triggers a final checkpoint, so nothing typed is lost. The owner
 *     is told editors will be asked to reload.
 *   - turning ON: nothing is open yet; the flag is read at join time, and a
 *     stale clean document is reseeded from git on load. Nothing to say.
 * Turning ON is refused only when this deployment has no collab server
 * configured at all.
 *
 * An unchanged value is a no-op: the flag endpoint closes every open room,
 * so re-sending the current value would kick live editors for nothing.
 */

import { ActionTypes } from '~/constants/actionTypes';

export const LIVE_EDITING_TOOL = 'web:settings.live_editing';

export const LIVE_EDITING_COPY = {
  on: 'Live editing turned on',
  off: 'Live editing turned off',
  offPendingReload: 'Anyone editing right now will be asked to reload.',
  unavailable: 'Live editing is not available on this server.',
  invalid: 'Choose on or off.',
} as const;

export interface LiveEditingDeps {
  /** Whether this deployment has a collab server configured. */
  collabAvailable: () => boolean;
  /** Write `Classroom.collab_enabled`. */
  writeFlag: (classroomId: string, enabled: boolean) => Promise<unknown>;
  /** Tell the collab server; never throws. */
  notifyCollab: (classroomId: string, enabled: boolean) => Promise<{ ok: boolean }>;
  /** Record the change (never throws). */
  audit: (entry: {
    classroomId: string;
    userId: string;
    role: string | undefined;
    action: string;
    resourceType: string;
    resourceId: string;
    metadata: Record<string, unknown>;
  }) => Promise<unknown>;
}

export type LiveEditingResult =
  | { success: string; info?: string; action: string }
  | { error: string; action: string };

export async function setLiveEditing(
  {
    classroom,
    userId,
    role,
    enabled,
  }: {
    classroom: { id: string; collab_enabled?: boolean | null };
    userId: string;
    role: string | undefined;
    enabled: unknown;
  },
  deps: LiveEditingDeps
): Promise<LiveEditingResult> {
  const action = ActionTypes.SAVE_LIVE_EDITING;
  if (typeof enabled !== 'boolean') return { error: LIVE_EDITING_COPY.invalid, action };

  const current = classroom.collab_enabled === true;
  if (enabled === current) {
    return { success: enabled ? LIVE_EDITING_COPY.on : LIVE_EDITING_COPY.off, action };
  }
  if (enabled && !deps.collabAvailable()) {
    return { error: LIVE_EDITING_COPY.unavailable, action };
  }

  await deps.writeFlag(classroom.id, enabled);
  const notified = await deps.notifyCollab(classroom.id, enabled);

  await deps.audit({
    classroomId: classroom.id,
    userId,
    role,
    action: 'UPDATE',
    resourceType: 'CONTENT_SETTINGS',
    resourceId: classroom.id,
    metadata: {
      tool: LIVE_EDITING_TOOL,
      field: 'collab_enabled',
      from: current,
      value: enabled,
      collab_notified: notified.ok,
    },
  });

  if (enabled) return { success: LIVE_EDITING_COPY.on, action };
  return notified.ok
    ? { success: LIVE_EDITING_COPY.off, action }
    : { success: LIVE_EDITING_COPY.off, info: LIVE_EDITING_COPY.offPendingReload, action };
}
