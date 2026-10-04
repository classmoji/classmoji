import type { CollabPeer } from '~/utils/collab/collab';
import type { SlideAgentTouch } from '~/components/SlideOverview/SlideGrid';
import { editingLabel, type SlideLockView } from '~/utils/collab/bridgeLogic';

import { PeerAvatar } from './CollabHeaderControls';

/**
 * Over the slide being shown in the live editor: who else is on this slide,
 * and — when someone else holds it — that it is theirs right now, with a
 * Take over button once they have gone quiet. When an agent has just changed
 * the slide, a frame and a name chip in the agent's colour that fade out.
 */
export default function SlideCollabOverlay({
  lock,
  peersHere,
  agentTouch = null,
  onTakeOver,
}: {
  /** The lock on the shown slide, if any (mine included). */
  lock: SlideLockView | null;
  /** Other people on this slide. */
  peersHere: CollabPeer[];
  /** An agent's recent change to this slide, while it shows. */
  agentTouch?: SlideAgentTouch | null;
  onTakeOver(slideId: string): void;
}) {
  const other = lock && lock.state !== 'mine' ? lock : null;
  if (!other && peersHere.length === 0 && !agentTouch) return null;

  return (
    <>
      {agentTouch && (
        // Keyed by batch: a new change restarts the fade.
        <div
          key={`frame-${agentTouch.batch}`}
          className="pointer-events-none absolute inset-0 z-10 rounded-lg motion-safe:animate-[cm-agent-touch-fade_5s_ease-out_forwards]"
          style={{ boxShadow: `inset 0 0 0 3px ${agentTouch.color}` }}
          data-testid="agent-touch"
          data-agent-name={agentTouch.name}
          aria-hidden
        />
      )}
      <div
        className="pointer-events-none absolute top-3 right-3 z-20 flex flex-col items-end gap-2"
        data-testid="slide-collab-overlay"
      >
        {agentTouch && (
          <div
            key={`chip-${agentTouch.batch}`}
            className="flex items-center gap-1.5 rounded-full bg-white/95 py-0.5 pl-1.5 pr-2.5 text-xs font-semibold text-gray-800 shadow-md ring-1 ring-gray-200 motion-safe:animate-[cm-agent-touch-fade_5s_ease-out_forwards] dark:bg-gray-800/95 dark:text-gray-100 dark:ring-gray-700"
            data-testid="agent-touch-chip"
          >
            <span
              className="h-2.5 w-2.5 rounded-full"
              style={{ backgroundColor: agentTouch.color }}
              aria-hidden
            />
            {agentTouch.name}
          </div>
        )}
        {other && (
          <div
            className="pointer-events-auto flex items-center gap-2 rounded-full bg-white/95 py-1 pl-1 pr-3 text-sm shadow-md ring-1 ring-amber-300 dark:bg-gray-800/95 dark:ring-amber-600"
            data-testid="slide-lock-badge"
            role="status"
            aria-live="polite"
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
          <div
            className="flex -space-x-1"
            data-testid="slide-peers"
            role="group"
            aria-label={`Also on this slide: ${peersHere.map(p => p.name).join(', ')}`}
          >
            {peersHere.map(peer => (
              <PeerAvatar key={peer.key} peer={peer} size="sm" />
            ))}
          </div>
        )}
      </div>
    </>
  );
}
