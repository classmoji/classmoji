import { useFetcher } from 'react-router';
import { useEffect, useRef } from 'react';
import { useCallout } from '@classmoji/ui-components';

export const useNotifiedFetcher = () => {
  const calloutIds = useRef(new Map<string, string>()); // Track callouts by action key
  const callout = useCallout();
  const fetcher = useFetcher();

  useEffect(() => {
    if (fetcher.data?.success) {
      const action = fetcher.data.action;
      const id = action ? calloutIds.current.get(action) : undefined;
      if (id) {
        callout.update(id, {
          variant: 'success',
          title: fetcher.data.success,
          autoDismissMs: 2000,
        });
        calloutIds.current.delete(action);
      } else {
        // Fallback if no progress callout was shown
        callout.show({
          variant: 'success',
          title: fetcher.data.success,
          autoDismissMs: 2000,
        });
      }
      fetcher.reset();
    } else if (fetcher.data?.error) {
      const action = fetcher.data.action;
      const id = action ? calloutIds.current.get(action) : undefined;
      if (id) {
        callout.update(id, {
          variant: 'error',
          title: fetcher.data.error,
        });
        calloutIds.current.delete(action);
      } else {
        // Fallback if no progress callout was shown
        callout.show({
          variant: 'error',
          title: fetcher.data.error,
        });
      }
      fetcher.reset();
    } else if (fetcher.data?.info) {
      callout.show({
        variant: 'info',
        title: fetcher.data.info,
      });
      fetcher.reset();
    }
  }, [fetcher.state, fetcher.data]);

  const notify = (action: string, message?: string, _position?: unknown) => {
    // Suppress unused-arg lint for backward-compatible signature.
    void _position;

    const existingId = calloutIds.current.get(action);
    if (existingId) {
      callout.dismiss(existingId);
    }

    const id = callout.show({
      variant: 'progress',
      title: message ?? '…',
      persistent: true,
    });

    calloutIds.current.set(action, id);
  };

  const reset = () => {
    fetcher.submit(null, {
      method: 'post',
      action: '/reset-fetcher',
    });
  };

  fetcher.reset = reset;

  return { fetcher, notify };
};
