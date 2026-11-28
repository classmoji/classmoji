/**
 * The browser's Sentry settings (DSN + environment) for the root loader, read
 * at request time: runtime config, never baked into the bundle.
 *
 * On a Worker they come from its bindings (`SENTRY_DSN` secret,
 * `SENTRY_ENVIRONMENT` var in wrangler.jsonc); on Fly, where there is no
 * Worker context, from `process.env` (the environment from `FLY_APP_NAME`).
 * No DSN means null, and the browser leaves Sentry off.
 */
import type { RouterContextProvider } from 'react-router';
import type { SentryBrowserConfig } from '@classmoji/utils/sentry';
import { sentryServerEnvironment } from '@classmoji/utils/sentry-server';
import { cloudflareContext } from '@classmoji/workers/context';

export const browserSentryConfig = (
  context: Readonly<RouterContextProvider>
): SentryBrowserConfig | null => {
  const env: object = context.get(cloudflareContext)?.env ?? process.env;
  const dsn = (env as Record<string, unknown>).SENTRY_DSN;
  if (typeof dsn !== 'string' || !dsn.trim()) return null;
  return { dsn: dsn.trim(), environment: sentryServerEnvironment(env) };
};
