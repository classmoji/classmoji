import { useCallback, useEffect } from 'react';
import { useBlocker, type BlockerFunction } from 'react-router';

import { leavesLiveEditor } from '~/utils/collab/collab';
import LiveLeaveDialog from './LiveLeaveDialog';

/**
 * The live editor's in-app leave guard: asks before a navigation to another
 * page while live edits are still on their way.
 *
 * Mounted ONLY while something could be lost (the editor renders it while
 * edits are unacknowledged, or while editing without a connection), because
 * a mounted blocker is consulted on every history change — including Reveal's
 * slide navigation, which writes `location.hash` behind the router's back.
 * The router cannot block those (it did not create the history entries) and
 * warns about every one while any blocker is registered. Hash-only and
 * search-only changes never leave the editor (`leavesLiveEditor`), so they
 * are never blocked even while the guard is up.
 *
 * `onBusyChange` reports a dialog or a proceeding navigation: the editor
 * keeps the guard mounted until it settles, even if the risk clears meanwhile.
 */
export default function LiveLeaveGuard({
  isRisky,
  onBusyChange,
}: {
  /** Read at navigation time (includes edits not yet written into the doc). */
  isRisky: () => boolean;
  onBusyChange: (busy: boolean) => void;
}) {
  const shouldBlock = useCallback<BlockerFunction>(
    ({ currentLocation, nextLocation }) =>
      leavesLiveEditor(currentLocation, nextLocation) && isRisky(),
    [isRisky]
  );
  const blocker = useBlocker(shouldBlock);
  const busy = blocker.state !== 'unblocked';
  useEffect(() => {
    onBusyChange(busy);
  }, [busy, onBusyChange]);
  if (blocker.state !== 'blocked') return null;
  return <LiveLeaveDialog onStay={() => blocker.reset()} onLeave={() => blocker.proceed()} />;
}
