/**
 * The browser's Sentry config from the root loader: the Worker's bindings on
 * Cloudflare (SENTRY_ENVIRONMENT var), process.env on Fly (environment from
 * FLY_APP_NAME), null without a DSN.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RouterContextProvider } from 'react-router';
import { cloudflareContext } from '@classmoji/workers/context';
import { browserSentryConfig } from '../sentryConfig.server';

const DSN = 'https://public@o0.ingest.sentry.io/0';

const workerContext = (env: Record<string, unknown>) => {
  const context = new RouterContextProvider();
  context.set(cloudflareContext, {
    env,
    ctx: { waitUntil: () => {}, passThroughOnException: () => {} },
  });
  return context;
};

afterEach(() => vi.unstubAllEnvs());

describe('browserSentryConfig', () => {
  it('reads the Worker bindings on Cloudflare, not process.env', () => {
    vi.stubEnv('SENTRY_DSN', 'https://other@o0.ingest.sentry.io/1');
    expect(
      browserSentryConfig(workerContext({ SENTRY_DSN: ` ${DSN} `, SENTRY_ENVIRONMENT: 'staging' }))
    ).toEqual({ dsn: DSN, environment: 'staging' });
  });

  it('is null on a Worker without a DSN, even when process.env has one', () => {
    vi.stubEnv('SENTRY_DSN', DSN);
    expect(browserSentryConfig(workerContext({ SENTRY_ENVIRONMENT: 'production' }))).toBeNull();
  });

  it('reads process.env on Fly, the environment from the Fly app name', () => {
    vi.stubEnv('SENTRY_DSN', DSN);
    vi.stubEnv('FLY_APP_NAME', 'classmoji-admin-staging');
    vi.stubEnv('SENTRY_ENVIRONMENT', '');
    expect(browserSentryConfig(new RouterContextProvider())).toEqual({
      dsn: DSN,
      environment: 'staging',
    });
  });

  it('is null on Fly without SENTRY_DSN', () => {
    vi.stubEnv('SENTRY_DSN', '');
    expect(browserSentryConfig(new RouterContextProvider())).toBeNull();
  });
});
