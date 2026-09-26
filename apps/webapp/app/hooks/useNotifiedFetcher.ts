import { useFetcher } from 'react-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useCallout } from '@classmoji/ui-components';
import type { CalloutPayload } from '@classmoji/ui-components';
import type { ActiveOperation, TriggerSession } from '~/contexts';

/**
 * Where a running batch is parked so a page reload can pick it back up.
 *
 * sessionStorage, not localStorage: the token inside is read-only and scoped to
 * one batch's tag, and it should die with the tab rather than sit in storage
 * for other tabs to find.
 */
const OPERATION_KEY = 'classmoji.operation';
/** Trigger's public tokens last 15 minutes, so a parked one outlives that. */
const OPERATION_MAX_AGE_MS = 15 * 60_000;

const park = (session: TriggerSession) => {
  try {
    sessionStorage.setItem(OPERATION_KEY, JSON.stringify({ session, startedAt: Date.now() }));
  } catch {
    /* Private mode, or storage is blocked. The callout still works, it just
       will not survive a reload. */
  }
};

const unpark = () => {
  try {
    sessionStorage.removeItem(OPERATION_KEY);
  } catch {
    /* As above. */
  }
};

export const useNotifiedFetcher = () => {
  const calloutIds = useRef(new Map<string, string>());
  const callout = useCallout();
  const fetcher = useFetcher();
  // Background work the action handed back. It outlives this response, and the
  // route that started it: OperationProgress watches it from the app root.
  const [operation, setOperation] = useState<ActiveOperation | null>(null);

  const finalize = (
    action: string | undefined,
    payload: Pick<CalloutPayload, 'variant' | 'title' | 'autoDismissMs'>
  ) => {
    const id = action ? calloutIds.current.get(action) : undefined;
    if (id) {
      callout.update(id, payload);
      calloutIds.current.delete(action!);
    } else {
      callout.show(payload);
    }
    fetcher.reset();
  };

  useEffect(() => {
    if (fetcher.data?.success) {
      finalize(fetcher.data.action, {
        variant: 'success',
        title: fetcher.data.success,
        autoDismissMs: 2000,
      });
    } else if (fetcher.data?.error) {
      finalize(fetcher.data.action, {
        variant: 'error',
        title: fetcher.data.error,
      });
    } else if (fetcher.data?.info && !fetcher.data?.triggerSession) {
      callout.show({ variant: 'info', title: fetcher.data.info });
      fetcher.reset();
    } else if (fetcher.data?.triggerSession && !operation) {
      // The action queued work rather than finishing it. Open a callout for the
      // batch and reset the fetcher straight away, so the next action is free
      // to run while this one is still going.
      const session = fetcher.data.triggerSession as TriggerSession;
      const calloutId = callout.show({
        variant: 'progress',
        title: 'Starting',
        persistent: true,
      });
      park(session);
      setOperation({ session, calloutId });
      // A queued batch can carry a note about what it left out (e.g. students
      // skipped for having no GitLab account connected).
      if (typeof fetcher.data.info === 'string') {
        callout.show({ variant: 'info', title: fetcher.data.info });
      }
      fetcher.reset();
    }
    // `callout` and `finalize` are intentionally omitted: callout is stable per
    // CalloutProvider, finalize closes over them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetcher.state, fetcher.data]);

  const endOperation = useCallback(() => {
    unpark();
    setOperation(null);
  }, []);

  // A reload drops the subscription but not the work: the batch is still
  // running on Trigger's side, so pick it up again and keep reporting.
  useEffect(() => {
    let parked: { session?: TriggerSession; startedAt?: number } | null = null;
    try {
      const raw = sessionStorage.getItem(OPERATION_KEY);
      parked = raw ? JSON.parse(raw) : null;
    } catch {
      return;
    }
    if (!parked?.session?.id || !parked.session.accessToken) return unpark();
    // Past the token's life there is nothing left to subscribe with, and the
    // work is long finished either way.
    if (Date.now() - (parked.startedAt ?? 0) > OPERATION_MAX_AGE_MS) return unpark();

    const session = parked.session;
    setOperation({
      session,
      calloutId: callout.show({ variant: 'progress', title: 'Starting', persistent: true }),
    });
    // `callout` is stable per provider; this runs once, on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const dismissNotify = useCallback(
    (action: string) => {
      const id = calloutIds.current.get(action);
      if (!id) return;
      callout.dismiss(id);
      calloutIds.current.delete(action);
    },
    [callout]
  );

  // Persistent progress callouts would otherwise be orphaned on unmount.
  useEffect(() => {
    const ids = calloutIds.current;
    return () => {
      for (const id of ids.values()) callout.dismiss(id);
      ids.clear();
    };
  }, [callout]);

  const notify = (action: string, message?: string) => {
    const existingId = calloutIds.current.get(action);
    if (existingId) callout.dismiss(existingId);
    const id = callout.show({
      variant: 'progress',
      title: message ?? '…',
      persistent: true,
    });
    calloutIds.current.set(action, id);
  };

  const reset = () => {
    fetcher.submit(null, { method: 'post', action: '/reset-fetcher' });
  };

  fetcher.reset = reset;

  return { fetcher, notify, operation, endOperation, dismissNotify };
};
