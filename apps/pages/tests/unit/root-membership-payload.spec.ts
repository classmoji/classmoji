/**
 * The root loader's user read: each membership's classroom is read without
 * the invite link's code, the plan owner's id and the creator's id, so the
 * payload every member receives carries none of them.
 *
 * The real root loader runs with its database module stubbed
 * (`importWithStubs`); the query it makes is what is pinned.
 */
import { test, expect } from '@playwright/test';

import { importWithStubs, routerArgs, stubModule } from '../helpers/dataRequest.helpers.ts';

type Captured = { args: unknown[] };
const captured: Captured = { args: [] };
(globalThis as unknown as { __rootUserQuery: Captured }).__rootUserQuery = captured;

const DB_SERVER = stubModule(`
const c = () => globalThis.__rootUserQuery;
export const GIT_IDENTITY = {};
export const getAuthSession = async () => ({ userId: 'user-1' });
export const prisma = {
  page: { findUnique: async () => null },
  user: {
    findUnique: async (args) => {
      c().args.push(args);
      return { id: 'user-1', name: 'U', accounts: [], classroom_memberships: [] };
    },
  },
  classroom: { findFirst: async () => null },
};
export const ClassmojiService = {
  form: { findBySlug: async () => null },
  site: { getSiteByCustomDomain: async () => null },
};
`);

test('reads each membership classroom without its invite code, plan owner or creator', async () => {
  const { loader } = await importWithStubs<{
    loader: (args: { request: Request; url: URL }) => Promise<unknown>;
    // Its own instance (`?payload`): another spec in this worker may hold one
    // stubbed differently.
  }>(new URL('../../app/root.tsx?payload', import.meta.url), {
    '.css': stubModule(''),
    '/app/utils/db.server.ts': DB_SERVER,
    '/app/utils/sentry.client.ts': stubModule(
      'export const captureRouteError = () => {}; export const setSentryUser = () => {};'
    ),
  });

  await loader(routerArgs('http://localhost/c/forms.data?_routes=root')).catch(() => undefined);

  const query = captured.args[0] as {
    include: { classroom_memberships: { select: { classroom: { omit: Record<string, true> } } } };
  };
  expect(query.include.classroom_memberships.select.classroom.omit).toEqual({
    join_code: true,
    plan_owner_id: true,
    created_by: true,
  });
});

test('says whether the session is "View as", so the browser names no user then', async () => {
  const load = async (instance: string, session: object) => {
    (globalThis as unknown as { __rootSession: object }).__rootSession = session;
    const { loader } = await importWithStubs<{
      loader: (args: { request: Request; url: URL }) => Promise<unknown>;
    }>(new URL(`../../app/root.tsx?${instance}`, import.meta.url), {
      '.css': stubModule(''),
      '/app/utils/db.server.ts': stubModule(`
export const GIT_IDENTITY = {};
export const getAuthSession = async () => ({ userId: 'user-1', session: globalThis.__rootSession });
export const prisma = {
  page: { findUnique: async () => null },
  user: { findUnique: async () => ({ id: 'user-1', accounts: [], classroom_memberships: [] }) },
};
`),
      '/app/utils/sentry.client.ts': stubModule(
        'export const captureRouteError = () => {}; export const setSentryUser = () => {};'
      ),
    });
    return (await loader(routerArgs('http://localhost/'))) as { impersonating?: boolean };
  };
  const viewedAs = await load('viewAs', { session: { impersonatedBy: 'admin-1' } });
  expect(viewedAs.impersonating).toBe(true);
  const own = await load('own', { session: {} });
  expect(own.impersonating).toBe(false);
});
