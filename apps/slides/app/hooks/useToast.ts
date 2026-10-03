import { useMemo } from 'react';
import { useCallout } from '@classmoji/ui-components';

/**
 * Transient feedback, in the app's own notification surface.
 *
 * Slides used to call antd's `message` API directly, which renders its own
 * chrome outside the theme (this app mounts no ConfigProvider, so those toasts
 * ignored dark mode entirely). Same call shape, so a site reads the same:
 * `toast.success('Saved')`.
 */
export const useToast = () => {
  const callout = useCallout();
  return useMemo(
    () => ({
      success: (title: string) => callout.show({ variant: 'success', title }),
      error: (title: string) => callout.show({ variant: 'error', title }),
      info: (title: string) => callout.show({ variant: 'info', title }),
    }),
    [callout]
  );
};
