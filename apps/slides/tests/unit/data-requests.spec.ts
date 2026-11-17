/**
 * Client navigations: the root gate answers `/x.data?_routes=…` as it answers `/x`.
 *
 * React Router 8 hands every loader the raw request (`/x.data?_routes=…`, the
 * root as `/_.data`) and a normalized `url` (`/x`). The gate reads the path
 * from `url`; reading it from `request.url` would send a stranger following a
 * share link or opening a public deck to sign in, and bring a visitor back from
 * sign-in to a `.data` URL.
 *
 * The real gate runs. The session and the deck lookup are stubbed at import
 * (`importWithStubs`), so nothing here needs Postgres.
 */

import { test, expect } from '@playwright/test';

import {
  importWithStubs,
  routerArgs,
  routerUrl,
  stubModule,
} from '../helpers/dataRequest.helpers.ts';

const PUBLIC_DECK = '0b6c4f8e-1111-4222-8333-444455556666';
const PRIVATE_DECK = '0b6c4f8e-1111-4222-8333-777788889999';

(globalThis as unknown as { __slidesPublicDecks: Set<string> }).__slidesPublicDecks = new Set([
  PUBLIC_DECK,
]);

const WEBAPP = 'http://localhost:3000';
const signInFor = (page: string) => `${WEBAPP}?redirect=${encodeURIComponent(page)}`;
const location = (result: unknown) =>
  result instanceof Response ? result.headers.get('Location') : null;

type Loader = (args: { request: Request; url: URL }) => Promise<unknown>;
let loader: Loader;
const savedWebappUrl = process.env.WEBAPP_URL;

// Later specs in the same worker must see the environment they started with.
test.afterAll(() => {
  if (savedWebappUrl === undefined) delete process.env.WEBAPP_URL;
  else process.env.WEBAPP_URL = savedWebappUrl;
});

test.beforeAll(async () => {
  process.env.WEBAPP_URL = WEBAPP;
  ({ loader } = await importWithStubs<{ loader: Loader }>(
    new URL('../../app/root.server.ts', import.meta.url),
    {
      '@classmoji/auth/server': stubModule('export const getAuthSession = async () => null;'),
      '@classmoji/database': stubModule(`
export const GIT_IDENTITY = {};
const prisma = {
  slide: {
    findUnique: async ({ where }) =>
      globalThis.__slidesPublicDecks.has(where.id) ? { is_public: true, is_draft: false } : null,
  },
  user: { findUnique: async () => null },
};
export default () => prisma;
`),
    }
  ));
});

const load = (raw: string) => loader(routerArgs(`http://localhost${raw}`));

test('builds url the way React Router 8 does', () => {
  expect(routerUrl('http://localhost/_.data?_routes=root').href).toBe('http://localhost/');
  expect(routerUrl('http://localhost/c/follow.data?shareCode=x&_routes=root').href).toBe(
    'http://localhost/c/follow?shareCode=x'
  );
  expect(routerUrl('http://localhost/c/x.data?index&_routes=root').search).toBe('');
});

test('lets a stranger follow a share link', async () => {
  expect(await load('/c/follow.data?shareCode=abc&_routes=root')).toMatchObject({
    user: null,
    isPublicAccess: true,
  });
});

test('lets a stranger open a public deck', async () => {
  expect(await load(`/${PUBLIC_DECK}.data?_routes=root`)).toMatchObject({
    isPublicAccess: true,
  });
  expect(await load(`/${PUBLIC_DECK}/present.data?_routes=root`)).toMatchObject({
    isPublicAccess: true,
  });
});

test('brings a stranger back from sign-in to the deck, not the .data URL', async () => {
  expect(location(await load(`/${PRIVATE_DECK}/speaker.data?_routes=root`))).toBe(
    signInFor(`http://localhost/${PRIVATE_DECK}/speaker`)
  );
});
