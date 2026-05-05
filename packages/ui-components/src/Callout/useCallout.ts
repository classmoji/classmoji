import { useContext } from 'react';
import { CalloutHandleContext } from './CalloutProvider.tsx';
import type { CalloutHandle } from './types.ts';

export function useCallout(): CalloutHandle {
  const handle = useContext(CalloutHandleContext);
  if (handle === null) {
    throw new Error(
      'useCallout must be used inside a <CalloutProvider>. ' +
        'Wrap your app root with <CalloutProvider> from @classmoji/ui-components.',
    );
  }
  return handle;
}
