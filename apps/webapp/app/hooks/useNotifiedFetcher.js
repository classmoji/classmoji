import { useFetcher } from 'react-router';
import { useEffect, useRef } from 'react';
import { toast } from 'react-toastify';

export const useNotifiedFetcher = () => {
  const toastIds = useRef(new Map()); // Track multiple toasts by ID
  const fetcher = useFetcher();

  const dismissToast = action => {
    toast.dismiss(toastIds.current.get(action));
  };

  useEffect(() => {
    if (fetcher.data?.success) {
      const id = toastIds.current.get(fetcher.data.action);
      if (id) {
        toast.update(id, {
          render: fetcher.data.success,
          type: 'success',
          isLoading: false,
          autoClose: 2000,
        });
      }

      fetcher.reset();
    } else if (fetcher.data?.error) {
      const id = toastIds.current.get(fetcher.data.action);
      if (id) {
        toast.update(id, {
          render: fetcher.data.error,
          type: 'error',
          isLoading: false,
          autoClose: 4000,
        });
      } else {
        // Fallback if no loading toast was shown
        toast.error(fetcher.data.error);
      }
      fetcher.reset();
    } else if (fetcher.data?.info) {
      toast.info(fetcher.data.info, {
        toastId: 'info',
      });
      fetcher.reset();
    }
  }, [fetcher.state, fetcher.data]);

  const notify = (action, message, position = 'top-center') => {
    if (toastIds.current.has(action)) {
      dismissToast(action);
    }

    // Create a new toast and store its ID
    const id = toast(message, {
      type: 'info',
      autoClose: false,
      isLoading: true,
      position,
      id: action,
    });

    toastIds.current.set(action, id); // Store ID by action type
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
