/**
 * The media routes' shared plumbing now lives with the handlers, in
 * `@classmoji/auth/media-http`, so the pages and slides apps answer exactly as
 * this one does. Re-exported here for the webapp code that already imports it
 * (the Settings → Media route's delete action reads bodies with `readJsonBody`).
 */
export {
  mediaError,
  mediaErrorResponse,
  readJsonBody,
  requireMediaAccess,
  requireMediaAccessForObject,
  requireMediaId,
  requireMethod,
} from '@classmoji/auth/media-http';
