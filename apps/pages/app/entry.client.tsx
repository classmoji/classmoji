import { startTransition, StrictMode } from 'react';
import { hydrateRoot } from 'react-dom/client';
import { HydratedRouter } from 'react-router/dom';
import { installClickBurst } from '@classmoji/ui-components/click-burst';
import { captureRecoverableError, captureRouteError, initSentry } from '~/utils/sentry.client.ts';

// React Router's default client entry, plus Sentry started before hydration
// when the server sent a DSN (see app/utils/sentry.client.ts). Without one,
// none of the Sentry hooks is set: no instrumentation, and React and React
// Router keep their own error logging.
const sentry = initSentry('pages');

// The burst every click of a control gives (one document listener, for the
// whole visit; editing surfaces opt out with `data-no-burst`).
installClickBurst();

startTransition(() => {
  hydrateRoot(
    document,
    <StrictMode>
      <HydratedRouter
        onError={sentry ? captureRouteError : undefined}
        instrumentations={sentry?.instrumentations}
      />
    </StrictMode>,
    sentry ? { onRecoverableError: captureRecoverableError } : undefined
  );
});
