import { describe, it, expect } from 'vitest';
import {
  parseSentryConfig,
  sentryBrowserConfig,
  sentryEnvironment,
  serializeSentryConfig,
} from '../sentry.ts';

const DSN = 'https://public@o0.ingest.sentry.io/0';

describe('sentryEnvironment', () => {
  it('reads the environment from the Fly app name', () => {
    expect(sentryEnvironment('classmoji-webapp-staging')).toBe('staging');
    expect(sentryEnvironment('classmoji-pages-dev')).toBe('dev');
    expect(sentryEnvironment('classmoji-slides')).toBe('production');
  });

  it('is development off Fly', () => {
    expect(sentryEnvironment(undefined)).toBe('development');
    expect(sentryEnvironment('  ')).toBe('development');
  });
});

describe('sentryBrowserConfig', () => {
  it('is null without a DSN, so Sentry stays off', () => {
    expect(sentryBrowserConfig({})).toBeNull();
    expect(sentryBrowserConfig({ SENTRY_DSN: ' ', FLY_APP_NAME: 'classmoji-webapp' })).toBeNull();
  });

  it('returns the DSN and the environment only', () => {
    expect(
      sentryBrowserConfig({
        SENTRY_DSN: ` ${DSN} `,
        FLY_APP_NAME: 'classmoji-webapp-staging',
        DATABASE_URL: 'postgres://secret',
      })
    ).toEqual({ dsn: DSN, environment: 'staging' });
  });
});

describe('serializeSentryConfig / parseSentryConfig', () => {
  it('round-trips', () => {
    const config = { dsn: DSN, environment: 'production' };
    expect(parseSentryConfig(serializeSentryConfig(config))).toEqual(config);
  });

  it('cannot close the script tag it is embedded in', () => {
    const json = serializeSentryConfig({
      dsn: '</script><script>alert(1)</script>',
      environment: 'x',
    });
    expect(json).not.toContain('<');
    expect(parseSentryConfig(json)?.dsn).toBe('</script><script>alert(1)</script>');
  });

  it('treats a missing or malformed block as off', () => {
    expect(parseSentryConfig(null)).toBeNull();
    expect(parseSentryConfig('')).toBeNull();
    expect(parseSentryConfig('{not json')).toBeNull();
    expect(parseSentryConfig('{"dsn":"","environment":"x"}')).toBeNull();
    expect(
      parseSentryConfig('{"dsn":"https://k@o0.ingest.sentry.io/0","environment":""}')
    ).toBeNull();
    expect(parseSentryConfig('[1]')).toBeNull();
  });
});
