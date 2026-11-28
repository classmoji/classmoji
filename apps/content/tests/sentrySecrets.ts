/**
 * Credentials the Sentry tests put in front of this Worker and then look for
 * in what it sends. In a module of their own, away from any function that
 * throws, so a value cannot reach an envelope as quoted source code and fail
 * the test for the wrong reason.
 */
export const DSN = 'https://public@o0.ingest.sentry.io/0';
export const INGEST_HOST = 'o0.ingest.sentry.io';

export const MASTER_SECRET = 'MASTERSECRETVALUE0123456789abcdef';
export const SHARED_SECRET = 'SHAREDSECRETVALUE';
/** The installation token the (fake) token endpoint mints. */
export const INSTALLATION_TOKEN = 'ghs_INSTALLTOKENSECRET';
export const BEARER_VALUE = 'BEARERSECRETVALUE';
export const COOKIE_VALUE = 'COOKIESECRETVALUE';
export const CLIENT_IP = '203.0.113.9';

export const REQUEST_HEADERS: Record<string, string> = {
  authorization: `Bearer ${BEARER_VALUE}`,
  cookie: `session=${COOKIE_VALUE}`,
  'x-forwarded-for': CLIENT_IP,
  'cf-connecting-ip': CLIENT_IP,
};

/** Strings that must never appear in anything sent, whatever the URL. */
export const ALWAYS_FORBIDDEN = [
  MASTER_SECRET,
  SHARED_SECRET,
  INSTALLATION_TOKEN,
  BEARER_VALUE,
  COOKIE_VALUE,
  CLIENT_IP,
  'sig=',
  'exp=',
];
