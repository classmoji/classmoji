import { useEffect, useRef, useState } from 'react';
import { useRevalidator } from 'react-router';

import { statusSettled } from './teamsView.ts';
import type { SetStatusPayload } from './types.ts';

/** How often the set pages ask while a run or a create is moving. */
export const SET_POLL_MS = 1_000;

/**
 * A client ceiling, as a backstop: the service expires a lost create 35
 * minutes after its last sign of life (CREATE_RUNNING_TTL_MS), and a lost run
 * sooner, and the status route reads through both expiries, so a poll ends on
 * its own well before this.
 */
export const SET_POLL_CAP_MS = 35 * 60_000;

/**
 * Poll a set's status resource route while a run or a create is moving.
 *
 * The fill page's delivery watch (`forms/fill/fill.tsx`), not a new mechanism:
 * a `setTimeout` chain (the next ask is scheduled after the answer, so asks
 * never overlap), `fetch` with an AbortController, no asking while the tab is
 * hidden (the loop keeps its place and resumes when it is shown), a stop on
 * `pagehide` and on unmount, and a failed ask ignored.
 *
 * A resource route rather than `revalidator` on a timer: a revalidation re-runs
 * the root loader, the set layout's and the page's, every tick. Here each tick
 * is one light read, and the page's own data is reloaded ONCE — when the poll
 * first sees nothing moving (the run finished, the create ended) — and then the
 * loop stops. It starts again when the page's data says something is moving.
 *
 * Returns the latest answer (null before the first), so the Creating banner
 * and progress card render from it between revalidations. The answer carries
 * counts and states only (`CreatePollView`); names come with the page's data.
 *
 *   const live = useSetStatusPoll(layout.paths.status, layoutPollActive(layout), layout.statusSignature);
 *   const progress = layout.create ? liveCreate(layout.create, live?.create ?? null) : null;
 *
 * `signature` is the one the page's data was loaded with: when a revalidation
 * brings new data the answer is dropped (the new data is newer, and has the
 * names the answer doesn't), and the loop restarts if that data says
 * something is still moving.
 *
 * An answer belongs to the set and the data it was asked for: it is returned
 * only while `statusUrl` and `signature` are still the ones its loop started
 * from, so the render that follows a move to another set (the layout stays
 * mounted) never shows the previous set's answer.
 */
export function useSetStatusPoll(
  statusUrl: string,
  active: boolean,
  signature?: string
): SetStatusPayload | null {
  const key = `${statusUrl}\n${signature ?? ''}`;
  const [latest, setLatest] = useState<{ key: string; payload: SetStatusPayload } | null>(null);

  // revalidate's identity is not stable across renders; the loop reads the
  // current one through a ref so a re-render never restarts it.
  const { revalidate } = useRevalidator();
  const revalidateRef = useRef(revalidate);
  revalidateRef.current = revalidate;

  useEffect(() => {
    // The page's data this effect starts from is newer than any earlier
    // answer, the settled one that ended the last loop included.
    setLatest(null);
    if (!active) return;

    const controller = new AbortController();
    const startedAt = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;

    const stop = () => {
      stopped = true;
      controller.abort();
      if (timer) clearTimeout(timer);
    };

    const next = () => {
      if (!stopped && Date.now() - startedAt < SET_POLL_CAP_MS) {
        timer = setTimeout(poll, SET_POLL_MS);
      }
    };

    const poll = async () => {
      if (stopped) return;
      // A hidden tab is not reading: skip this ask, keep the loop's place.
      if (typeof document !== 'undefined' && document.hidden) {
        next();
        return;
      }

      try {
        const response = await fetch(statusUrl, {
          signal: controller.signal,
          headers: { accept: 'application/json' },
        });
        if (response.ok) {
          const payload = (await response.json()) as SetStatusPayload;
          if (stopped) return;
          setLatest({ key, payload });
          if (statusSettled(payload)) {
            // Finished: reload the page's data once, then stop asking.
            stop();
            void revalidateRef.current();
            return;
          }
        }
      } catch {
        // A failed ask (offline for a moment, an aborted request) is not news;
        // the next one tries again.
      }

      next();
    };

    timer = setTimeout(poll, SET_POLL_MS);
    window.addEventListener('pagehide', stop);

    return () => {
      stop();
      window.removeEventListener('pagehide', stop);
    };
  }, [statusUrl, active, signature, key]);

  return latest?.key === key ? latest.payload : null;
}
