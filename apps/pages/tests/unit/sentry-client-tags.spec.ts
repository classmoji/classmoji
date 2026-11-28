/**
 * The browser client (app/utils/sentry.client.ts) names its app and its
 * runtime on every event (tags) and every streamed span (attributes), as
 * the admin client and the servers do. The SDK is stubbed: this pins what
 * `init` is given, nothing is sent.
 */
import { test, expect } from '@playwright/test';

import { importWithStubs, stubModule } from '../helpers/dataRequest.helpers.ts';

const SDK_STUB = stubModule(`
  const noop = () => {};
  export const captureException = noop;
  export const captureReactException = noop;
  export const createSentryClientInstrumentation = () => ({});
  export const init = options => { globalThis.__sentryInitOptions = options; };
  export const reactRouterTracingIntegration = () => ({});
  export const sentryOnError = noop;
  export const setTag = noop;
  export const setUser = noop;
  export const withScope = noop;
`);
const CONFIG_STUB = stubModule(`
  export const SENTRY_CONFIG_ELEMENT_ID = 'sentry-config';
  export const parseSentryConfig = () => ({ dsn: 'https://public@o0.ingest.sentry.io/0', environment: 'test' });
`);

test('tags events and spans with the app and runtime: browser', async () => {
  const { initSentry } = await importWithStubs<{ initSentry: (app: 'pages') => unknown }>(
    new URL('../../app/utils/sentry.client.ts', import.meta.url),
    { '@sentry/react-router': SDK_STUB, '@classmoji/utils/sentry': CONFIG_STUB }
  );
  const globals = globalThis as { document?: unknown; __sentryInitOptions?: unknown };
  const original = globals.document;
  globals.document = { getElementById: () => ({ textContent: '{}' }) };
  try {
    expect(initSentry('pages')).not.toBeNull();
  } finally {
    globals.document = original;
  }
  const options = globals.__sentryInitOptions as { initialScope?: unknown };
  expect(options.initialScope).toEqual({
    tags: { app: 'pages', runtime: 'browser' },
    attributes: { app: 'pages', runtime: 'browser' },
  });
});
