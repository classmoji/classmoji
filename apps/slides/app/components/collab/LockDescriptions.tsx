import type { SlideLockView } from '~/utils/collab/bridgeLogic';
import { editingLabel } from '~/utils/collab/bridgeLogic';

/** The id of a held slide's description (its section's aria-describedby). */
export const lockDescriptionId = (slideId: string) => `cm-lock-desc-${slideId}`;

/**
 * Visually hidden descriptions for slides someone else is editing; the bridge
 * points each read-only section's aria-describedby here.
 */
export default function LockDescriptions({ locks }: { locks: Record<string, SlideLockView> }) {
  const others = Object.values(locks).filter(lock => lock.state !== 'mine');
  if (others.length === 0) return null;
  return (
    <div className="sr-only">
      {others.map(lock => (
        <span key={lock.slideId} id={lockDescriptionId(lock.slideId)}>
          {editingLabel(lock.holder.name)} this slide; it is read-only for you.
        </span>
      ))}
    </div>
  );
}
