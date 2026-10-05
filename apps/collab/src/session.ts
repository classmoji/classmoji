/**
 * The real session lookup: better-auth's getSession from the socket's cookie,
 * with the cookie cache OFF (the cache would keep a revoked session valid for
 * up to a day), plus the dev fallback `apps/slides/server.ts`'s
 * getSocketAuthSession uses for test-login sessions.
 *
 * Imported only by index.ts: `@classmoji/auth/server` builds better-auth and
 * Prisma at module load, and the server core (and its tests) take a
 * `SessionResolver` instead.
 */
import getPrisma, { GIT_IDENTITY } from '@classmoji/database';
import { auth } from '@classmoji/auth/server';
import { sessionTokenFromCookieHeader } from '@classmoji/auth/secret';
import { withLogin } from '@classmoji/utils';

import type { CollabSession, SessionResolver } from './auth.ts';

async function displayName(userId: string, fallback?: string | null): Promise<string> {
  const user = await getPrisma().user.findUnique({
    where: { id: userId },
    include: { ...GIT_IDENTITY },
  });
  const withIdentity = user
    ? (withLogin(user) as { name?: string | null; login?: string | null })
    : null;
  return withIdentity?.name || withIdentity?.login || fallback || 'Someone';
}

export function createSessionResolver(): SessionResolver {
  return {
    async resolve(cookieHeader) {
      if (!cookieHeader) return null;

      const session = await auth.api.getSession({
        headers: new Headers({ cookie: cookieHeader }),
        query: { disableCookieCache: true },
      });
      if (session?.user) {
        return {
          userId: session.user.id,
          name: await displayName(session.user.id, session.user.name),
          sessionToken: session.session.token,
        } satisfies CollabSession;
      }

      // Dev test sessions (see apps/slides/server.ts getSocketAuthSession):
      // a direct DB read by the configured cookie name.
      if (process.env.NODE_ENV === 'development') {
        const fromCookie = sessionTokenFromCookieHeader(cookieHeader);
        if (fromCookie) {
          const token = fromCookie.split('.')[0];
          const direct = await getPrisma().session.findUnique({ where: { token } });
          if (direct && direct.expires_at > new Date()) {
            return {
              userId: direct.user_id,
              name: await displayName(direct.user_id),
              sessionToken: direct.token,
            };
          }
        }
      }

      return null;
    },
  };
}
