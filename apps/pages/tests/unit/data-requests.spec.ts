/**
 * Client navigations: a loader answers `/x.data?_routes=…` as it answers `/x`.
 *
 * React Router 8 hands every loader the raw request (`/x.data?_routes=…`, the
 * root as `/_.data`) and a normalized `url` (`/x`). The gates and sign-in
 * links here read the path from `url`; reading it from `request.url` would
 * send a stranger on a public page or form to sign in, and bring a visitor
 * back from sign-in to a `.data` URL.
 *
 * The real gate code runs. What it would ask Postgres or the session is
 * stubbed at import (`importWithStubs`): the session, the page and form
 * lookups, and the custom-domain claim.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';

import { siteRouterContext } from '../../server/loadContext.ts';
import { signInUrlFor } from '~/utils/pageSections.server.ts';
import {
  importWithStubs,
  routerArgs,
  routerUrl,
  stubModule,
} from '../helpers/dataRequest.helpers.ts';

type Fakes = {
  session: { userId: string } | null;
  publicPageIds: Set<string>;
  form: Record<string, unknown> | null;
  customDomainLookup: Record<string, unknown> | null;
};
const fakes: Fakes = {
  session: null,
  publicPageIds: new Set(['page-1']),
  form: null,
  customDomainLookup: null,
};
(globalThis as unknown as { __dataRequestFakes: Fakes }).__dataRequestFakes = fakes;

const DB_SERVER = stubModule(`
const f = () => globalThis.__dataRequestFakes;
export const GIT_IDENTITY = {};
export const getAuthSession = async () => f().session;
export const prisma = {
  page: {
    findUnique: async ({ where }) =>
      f().publicPageIds.has(where.id) ? { is_public: true, is_draft: false } : null,
  },
  user: { findUnique: async () => null },
  classroom: { findFirst: async () => ({ id: 'class-1', name: 'Class', settings: null }) },
};
export const ClassmojiService = {
  form: { findBySlug: async () => f().form },
  site: { getSiteByCustomDomain: async () => f().customDomainLookup },
};
`);

const WEBAPP = 'http://localhost:3000';
const signInFor = (page: string) => `${WEBAPP}?redirect=${encodeURIComponent(page)}`;
const location = (result: unknown) =>
  result instanceof Response ? result.headers.get('Location') : null;
const app = (path: string) => new URL(`../../app/${path}`, import.meta.url);

const thrown = async (run: () => Promise<unknown>): Promise<unknown> => {
  try {
    await run();
  } catch (error: unknown) {
    return error;
  }
  throw new Error('expected a thrown response');
};

test.beforeAll(() => {
  process.env.WEBAPP_URL = WEBAPP;
  process.env.SITE_BASE_DOMAIN = 'classmoji.test';
});

test.beforeEach(() => {
  fakes.session = null;
  fakes.form = null;
  fakes.customDomainLookup = null;
});

test('builds url the way React Router 8 does', () => {
  expect(routerUrl('http://localhost/_.data?_routes=root').href).toBe('http://localhost/');
  expect(routerUrl('http://localhost/c/forms/signup/_.data').pathname).toBe('/c/forms/signup/');
  expect(routerUrl('http://localhost/c/page-1.data?_routes=root&tab=a').href).toBe(
    'http://localhost/c/page-1?tab=a'
  );
  expect(routerUrl('http://localhost/c/x.data?index&_routes=root').search).toBe('');
});

test.describe('root gate', () => {
  type Loader = (args: { request: Request; url: URL }) => Promise<unknown>;
  let loader: Loader;

  test.beforeAll(async () => {
    ({ loader } = await importWithStubs<{ loader: Loader }>(app('root.tsx'), {
      '.css': stubModule(''),
      '/app/utils/db.server.ts': DB_SERVER,
      '/app/utils/sentry.client.ts': stubModule(
        'export const captureRouteError = () => {}; export const setSentryUser = () => {};'
      ),
    }));
  });

  const load = (raw: string) => loader(routerArgs(`http://localhost${raw}`));

  test('lets a stranger reach the landing page', async () => {
    expect(await load('/_.data?_routes=root')).toMatchObject({ user: null });
  });

  test('lets a stranger open a public form', async () => {
    expect(await load('/c/forms/signup/_.data?_routes=root')).toMatchObject({
      isPublicAccess: true,
    });
  });

  test('lets a stranger open a public page', async () => {
    expect(await load('/c/page-1.data?_routes=root')).toMatchObject({ isPublicAccess: true });
  });

  test('sends a stranger on the admin forms list to sign in, back to the list', async () => {
    expect(location(await load('/c/forms.data?_routes=root,routes/c.forms'))).toBe(
      signInFor('http://localhost/c/forms')
    );
  });

  test('brings a stranger back from sign-in to the page, not the .data URL', async () => {
    expect(location(await load('/c/page-2.data?tab=a&_routes=root'))).toBe(
      signInFor('http://localhost/c/page-2?tab=a')
    );
  });
});

test.describe('sign-in links', () => {
  test('the admin forms gate sends a stranger to sign in, back to the page', async () => {
    const { assertFormAdmin } = await importWithStubs<typeof import('~/utils/formAuth.server.ts')>(
      app('utils/formAuth.server.ts'),
      {
        '@classmoji/auth/server': stubModule(`
export const requireClassroomStaff = async () => {
  throw new Response('Unauthorized', { status: 401 });
};
export const assertProTier = async () => {};
export const formMutationBlocked = () => false;
`),
      }
    );
    const refusal = await thrown(() =>
      assertFormAdmin('c', routerArgs('http://localhost/c/forms/new.data?_routes=root'))
    );
    expect(location(refusal)).toBe(signInFor('http://localhost/c/forms/new'));
  });

  test('a class-only form sends a stranger to sign in, back to the form', async () => {
    const { loadPublicForm } = await importWithStubs<
      typeof import('~/forms/fill/publicForm.server.ts')
    >(app('forms/fill/publicForm.server.ts'), {
      '/app/utils/db.server.ts': DB_SERVER,
      '/app/forms/fill/classroomForm.server.ts': stubModule(
        'export const resolveClassroomForm = async ({ loginUrl }) => ({ view: "signin", loginUrl });'
      ),
    });
    fakes.form = {
      id: 'form-1',
      title: 'Sign-up',
      description: null,
      status: 'OPEN',
      access: 'CLASSROOM',
    };
    const result = await loadPublicForm({
      classroomSlug: 'c',
      formSlug: 'signup',
      ...routerArgs('http://localhost/c/forms/signup.data?ref=x&_routes=root'),
    });
    expect(result).toMatchObject({ loginUrl: signInFor('http://localhost/c/forms/signup?ref=x') });
  });

  test('a page names itself, not its .data URL, in its sign-in link', () => {
    expect(signInUrlFor(routerUrl('http://localhost/c/page-1.data?_routes=root').href)).toBe(
      signInFor('http://localhost/c/page-1')
    );
    // The page loader needs Postgres and a content repo, so its call is pinned
    // from source (as page-sections.spec.ts pins the redaction).
    const loaderSource = readFileSync(
      fileURLToPath(app('routes/$classroomSlug.$pageId/route.server.ts')),
      'utf8'
    );
    expect(loaderSource).toContain('signInUrlFor(url.href)');
    expect(loaderSource).not.toMatch(/signInUrlFor\(\s*request\.url/);
  });

  test('a lapsed custom domain sends the visitor to the same page on the subdomain', async () => {
    const { resolveSiteContext } = await importWithStubs<typeof import('~/site/tenant.server.ts')>(
      app('site/tenant.server.ts'),
      { '/app/utils/db.server.ts': DB_SERVER }
    );
    fakes.customDomainLookup = { state: 'lapsed', site: { subdomain: 'cs52' } };
    const refusal = await thrown(() =>
      resolveSiteContext({
        ...routerArgs('http://course.example.edu/_site/cs52/syllabus.data?week=2&_routes=root'),
        params: { subdomain: 'cs52' },
        context: siteRouterContext({ customDomain: 'course.example.edu' }),
      })
    );
    expect((refusal as Response).status).toBe(302);
    expect(location(refusal)).toMatch(
      /^https?:\/\/cs52\.classmoji\.test(:\d+)?\/syllabus\?week=2$/
    );
  });
});
