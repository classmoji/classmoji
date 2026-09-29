import { useCallback } from 'react';
import { useFetcher, useOutletContext, useRouteLoaderData, type SubmitTarget } from 'react-router';

import type {
  SetActionData,
  SetIntent,
  SetIntentPayloads,
  SetStatusPayload,
  TeamSetLayoutData,
  TeamSetOutletContext,
} from './types.ts';

/**
 * The fetcher every team-set mutation goes through.
 *
 * ── Why this exists: the `?index` trap ─────────────────────────────────────
 * Every set mutation posts to the SET LAYOUT's action (`set.tsx`, route id
 * 'team-set'). A plain `useFetcher()` inside the Setup tab — the layout's
 * index route — submits to `…/teams/:set?index` by default, which targets the
 * index route; it has no action, so the post fails with a 405 and nothing
 * saves. This hook always passes the layout's own URL (`paths.set`, from its
 * loader data) as `action`, and posts JSON with an `intent`, as the builder
 * does. Teams components use it and never `useFetcher` directly.
 *
 * Outside a set page (no 'team-set' loader data) it throws when a post is
 * attempted, rather than fall back to the default target.
 *
 *   const { post, busy, data } = useSetFetcher();
 *   post('patch', { patch: { fairness: 70 } });
 *   post('run');
 *
 * `data` is the action's answer to THIS fetcher's last post; its `intent`
 * says which post that was.
 */

/** The set layout's route id (routes.ts). */
export const TEAM_SET_ROUTE_ID = 'team-set';

/** The set layout's loader data, for any component under a set page. */
export function useTeamSetLayoutData(): TeamSetLayoutData | undefined {
  return useRouteLoaderData(TEAM_SET_ROUTE_ID) as TeamSetLayoutData | undefined;
}

/**
 * The set layout's status poll, as its latest answer (null before the first,
 * or outside a set page). The layout polls while a run or a create moves and
 * passes the answer through `<Outlet context>`; pages read it here instead of
 * polling again.
 */
export function useSetLiveStatus(): SetStatusPayload | null {
  const context = useOutletContext<TeamSetOutletContext | undefined>();
  return context?.live ?? null;
}

/**
 * An intent's payload is optional when it has no required keys (an empty
 * object fits it), and required otherwise.
 */
type PayloadArgs<I extends SetIntent> =
  Record<string, never> extends SetIntentPayloads[I]
    ? [payload?: SetIntentPayloads[I]]
    : [payload: SetIntentPayloads[I]];

export function useSetFetcher(options: { key?: string } = {}) {
  const layout = useTeamSetLayoutData();
  const fetcher = useFetcher<SetActionData>(options);
  const action = layout?.paths.set ?? null;
  const { submit } = fetcher;

  const post = useCallback(
    <I extends SetIntent>(intent: I, ...[payload]: PayloadArgs<I>) => {
      if (action === null) {
        throw new Error('useSetFetcher: no team-set layout data; post from inside a set page.');
      }
      // One cast, as in the builder: the payloads are plain JSON, which no
      // structural type of React Router's describes.
      const body = { ...(payload ?? {}), intent } as unknown as SubmitTarget;
      return submit(body, { method: 'post', encType: 'application/json', action });
    },
    [action, submit]
  );

  return {
    fetcher,
    post,
    /** A post is in flight or its revalidation is running. */
    busy: fetcher.state !== 'idle',
    data: fetcher.data as SetActionData | undefined,
  };
}
