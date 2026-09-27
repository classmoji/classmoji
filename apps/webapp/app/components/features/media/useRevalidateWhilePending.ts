import { useEffect, useRef } from 'react';
import { useRevalidator } from 'react-router';
import type { MediaProcessing, MediaStatus } from '@classmoji/services';

import { PENDING_REVALIDATE_MS, hasPendingProcessing } from './mediaState';

/**
 * While any row is still optimising, reload the route's data now and then so
 * its label moves on without the owner reloading the page.
 *
 * Keyed on `records`: every fresh load re-arms ONE timer, and a load with
 * nothing pending arms none, so the reloads stop by themselves. A reload
 * already in flight (after a delete or an upload) is not doubled.
 */
export function useRevalidateWhilePending(
  records: readonly { status: MediaStatus; processing: MediaProcessing }[]
): void {
  const revalidator = useRevalidator();
  const { revalidate } = revalidator;
  const state = useRef(revalidator.state);
  state.current = revalidator.state;

  useEffect(() => {
    if (!hasPendingProcessing(records)) return;
    const timer = window.setTimeout(() => {
      if (state.current === 'idle') void revalidate();
    }, PENDING_REVALIDATE_MS);
    return () => window.clearTimeout(timer);
  }, [records, revalidate]);
}
