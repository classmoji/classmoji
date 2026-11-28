/**
 * Secret values the Sentry privacy tests send through a real `@sentry/node`
 * client and then look for in the serialized envelope.
 *
 * They live in their own module, away from any function that throws: the SDK
 * attaches five lines of source around every stack frame (ContextLines), so a
 * literal next to a `throw` would land in the envelope as source code and
 * fail the test for the wrong reason.
 */
export const JOIN_CODE = 'SECRETCODE';
export const INVITE_JWT = 'eyJhbGciOi.SECRET.JWT';
export const COOKIE_VALUE = 'COOKIESECRET';
// A credential's length (the Bearer rule needs 16+ characters, so prose such
// as "Bearer realm missing" stays).
export const BEARER_VALUE = 'BEARERSECRET0123456789';
export const COLLAB_SECRET = 'COLLABSECRET';
export const BODY_SECRET = 'BODYSECRET';
export const CLIENT_IP = '203.0.113.9';
export const USER_EMAIL = 'ada.secret@example.edu';

export const REQUEST_PATH = `/join/${JOIN_CODE}?invite=${INVITE_JWT}&x=1`;
export const REQUEST_HEADERS: Record<string, string> = {
  cookie: `session=${COOKIE_VALUE}`,
  authorization: `Bearer ${BEARER_VALUE}`,
  'x-collab-secret': COLLAB_SECRET,
  'x-forwarded-for': CLIENT_IP,
  'content-type': 'application/json',
};
export const REQUEST_BODY = JSON.stringify({ note: BODY_SECRET });
export const ERROR_MESSAGE = `upstream https://x.test/join/${JOIN_CODE}?invite=abc refused Bearer ${BEARER_VALUE}`;

/** Every string that must not appear anywhere in what is sent. */
export const FORBIDDEN = [
  JOIN_CODE,
  COOKIE_VALUE,
  BEARER_VALUE,
  COLLAB_SECRET,
  BODY_SECRET,
  CLIENT_IP,
  'invite=',
  INVITE_JWT,
  USER_EMAIL,
];
