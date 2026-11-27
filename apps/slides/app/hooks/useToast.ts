import { useMemo } from 'react';
import { useCallout } from '@classmoji/ui-components';

/**
 * Transient feedback, in the app's own notification surface.
 *
 * Slides used to call antd's static `message` API directly, which renders
 * outside the React tree: it reads neither the root ConfigProvider's theme nor
 * dark mode. Same call shape, so a site reads the same:
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
