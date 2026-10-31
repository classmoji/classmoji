/**
 * Browser error tracking (Sentry) for the webapp, pages and slides.
 *
 * The DSN and environment are runtime settings, not build-time ones: they come
 * from the server's env (Infisical-synced Fly secrets), so nothing about Sentry
 * is baked into the bundle. Each app's root loader calls
 * `sentryBrowserConfig(process.env)`, the root document renders the result as
 * a JSON data block (`#sentry-config`), and the app's `entry.client.tsx` reads
 * it back before hydrating. No `SENTRY_DSN` means no config, and Sentry stays off.
 *
 * Everything here is pure (the env is passed in), so importing it from a
 * component never drags `process.env` into the client bundle.
 */

export type SentryBrowserConfig = { dsn: string; environment: string };

/** Id of the `<script type="application/json">` the root documents render. */
export const SENTRY_CONFIG_ELEMENT_ID = 'sentry-config';

/**
 * The Sentry environment for a Fly app name: `classmoji-webapp-staging` is
 * staging, `…-dev` is dev, any other Fly app is production, and no Fly app at
 * all (a laptop) is development.
 */
export const sentryEnvironment = (flyAppName: string | undefined): string => {
  const app = flyAppName?.trim();
  if (!app) return 'development';
  if (app.endsWith('-staging')) return 'staging';
  if (app.endsWith('-dev')) return 'dev';
  return 'production';
};

/** What the browser needs to start Sentry, or null when `SENTRY_DSN` is unset. */
export const sentryBrowserConfig = (
  env: Record<string, string | undefined>
): SentryBrowserConfig | null => {
  const dsn = env.SENTRY_DSN?.trim();
  if (!dsn) return null;
  return { dsn, environment: sentryEnvironment(env.FLY_APP_NAME) };
};

/** JSON for an inline `<script>`: `<` is escaped so no value can close the tag. */
export const serializeSentryConfig = (config: SentryBrowserConfig): string =>
  JSON.stringify(config).replace(/</g, '\\u003c');

/** Parse the `#sentry-config` block's text; anything unusable is null (off). */
export const parseSentryConfig = (text: string | null | undefined): SentryBrowserConfig | null => {
  if (!text) return null;
  try {
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== 'object') return null;
    const { dsn, environment } = value as Record<string, unknown>;
    if (typeof dsn !== 'string' || !dsn) return null;
    if (typeof environment !== 'string' || !environment) return null;
    return { dsn, environment };
  } catch {
    return null;
  }
};
