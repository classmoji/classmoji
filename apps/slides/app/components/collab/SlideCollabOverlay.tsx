import type { CollabPeer } from '~/utils/collab/collab';
import { editingLabel, type SlideLockView } from '~/utils/collab/bridgeLogic';

import { PeerAvatar } from './CollabHeaderControls';

/**
 * Over the slide being shown in the live editor: who else is on this slide,
 * and — when someone else holds it — that it is theirs right now, with a
 * Take over button once they have gone quiet.
 */
export default function SlideCollabOverlay({
  lock,
  peersHere,
  onTakeOver,
}: {
  /** The lock on the shown slide, if any (mine included). */
  lock: SlideLockView | null;
  /** Other people on this slide. */
  peersHere: CollabPeer[];
  onTakeOver(slideId: string): void;
}) {
  const other = lock && lock.state !== 'mine' ? lock : null;
  if (!other && peersHere.length === 0) return null;

  return (
    <div
      className="pointer-events-none absolute top-3 right-3 z-20 flex flex-col items-end gap-2"
      data-testid="slide-collab-overlay"
    >
      {other && (
        <div
          className="pointer-events-auto flex items-center gap-2 rounded-full bg-white/95 py-1 pl-1 pr-3 text-sm shadow-md ring-1 ring-amber-300 dark:bg-gray-800/95 dark:ring-amber-600"
          data-testid="slide-lock-badge"
          data-holder={other.holder.name}
        >
          <PeerAvatar peer={other.holder} size="sm" />
          <span
            className="max-w-[16rem] truncate font-medium text-amber-900 dark:text-amber-100"
            title={editingLabel(other.holder.name)}
          >
            {editingLabel(other.holder.name)}
          </span>
          {other.canTakeOver && (
            <button
              type="button"
              onClick={() => onTakeOver(other.slideId)}
              className="ml-1 rounded-full bg-amber-600 px-2.5 py-0.5 text-xs font-semibold text-white hover:bg-amber-700 dark:bg-amber-500 dark:text-amber-950 dark:hover:bg-amber-400"
              data-testid="slide-take-over"
            >
              Take over
            </button>
          )}
        </div>
      )}
      {peersHere.length > 0 && (
        <div className="flex -space-x-1" data-testid="slide-peers">
          {peersHere.map(peer => (
            <PeerAvatar key={peer.key} peer={peer} size="sm" />
          ))}
        </div>
      )}
    </div>
  );
}
