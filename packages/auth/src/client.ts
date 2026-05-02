import { createAuthClient } from 'better-auth/react';
import { adminClient } from 'better-auth/client/plugins';

// In better-auth 1.6.x, the adminClient plugin's return type isn't a strict
// BetterAuthClientPlugin so its type augmentations (`admin.*` endpoints)
// don't propagate onto authClient. Runtime is fine. Bumping was required
// for oauth-provider compatibility. Pre-existing webapp call sites using
// `authClient.admin.*` were broken by the bump and may need cast on use.
export const authClient = createAuthClient({
  baseURL: typeof window !== 'undefined' ? window.location.origin : '',
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  plugins: [adminClient() as any],
});

export const { signIn, signOut, useSession } = authClient;
