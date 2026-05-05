import { useFetcher } from 'react-router';
import { useEffect, useRef } from 'react';
import { useCallout } from '@classmoji/ui-components';
import type { CalloutPayload } from '@classmoji/ui-components';

export const useNotifiedFetcher = () => {
  const calloutIds = useRef(new Map<string, string>());
  const callout = useCallout();
  const fetcher = useFetcher();

  const finalize = (
    action: string | undefined,
    payload: Pick<CalloutPayload, 'variant' | 'title' | 'autoDismissMs'>,
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
    } else if (fetcher.data?.info) {
      callout.show({ variant: 'info', title: fetcher.data.info });
      fetcher.reset();
    }
    // `callout` and `finalize` are intentionally omitted: callout is stable per
    // CalloutProvider, finalize closes over them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetcher.state, fetcher.data]);

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

  return { fetcher, notify };
};
