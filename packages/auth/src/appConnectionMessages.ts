/**
 * Messages for connecting apps, shared by the server-side refusal
 * (./appConnectionGuard.ts, in the shared better-auth `hooks.before`) and the
 * webapp's consent page. Plain strings only, so pages can import them.
 */
export const CONNECT_APP_VIEWING_AS_MESSAGE =
  "Connecting apps isn't available while viewing as another user.";
