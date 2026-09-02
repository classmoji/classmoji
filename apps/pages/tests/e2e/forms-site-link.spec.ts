import { test, expect, type APIRequestContext } from '@playwright/test';

import { getPagesBaseURL, getTestClassroomSlug, getTestPrisma } from '../helpers';

/**
 * The short form link on a class-site host, over real HTTP.
 *
 * The product owner hit this in production: `cs52.classmoji.io/forms/cs52-
 * waitlist` 404'd while `cs52.classmoji.io/` served fine. The `_site` subtree
 * declared no `forms` route, so the rewritten path matched nothing. What is
 * asserted here is the fix: a site host answers those paths with a 302 to the
 * canonical pages host, carrying the query string — which for `/verify?token=…`
 * IS the magic link, so dropping it would break every emailed link shared over
 * a course site.
 *
 * ── Why this can skip, and what covers it when it does ─────────────────────
 * The rewriter is inert unless SITE_BASE_DOMAIN is set, and the ordinary dev
 * stack deliberately leaves it unset: setting it derives a `.lvh.me` cookie
 * domain, and a `.lvh.me` cookie is never sent to `localhost`, so every
 * localhost login in the stack would stop working. Rather than pretend, this
 * file PROBES the server it is pointed at and skips with a message when sites
 * are off there.
 *
 * To actually run it, start a second pages server with the feature on and point
 * this file at it:
 *
 *   cd apps/pages && npm run pages:build
 *   # devport.sh run is not optional: it exports the DATABASE_URL of THIS
 *   # worktree's database. Without it the server boots against the default
 *   # `classmoji` one and the fixture below is written to the wrong place.
 *   ../../scripts/devport.sh run env SITE_BASE_DOMAIN=lvh.me PORT=7159 \
 *     PAGES_URL=http://localhost:7159 NODE_ENV=production \
 *     node --experimental-strip-types server.ts
 *   FORMS_SITE_PAGES_URL=http://localhost:7159 \
 *     npx playwright test tests/e2e/forms-site-link.spec.ts
 *
 * The bridge's decision — which shapes bridge and which are refused — is a pure
 * function with its own spec in `tests/unit/forms-site-bridge.spec.ts`, so the
 * skip costs coverage of the wiring, not of the rule.
 */

const CLASS = getTestClassroomSlug();
const BASE = process.env.FORMS_SITE_PAGES_URL || getPagesBaseURL();
const SITE_BASE_DOMAIN = process.env.SITE_BASE_DOMAIN || 'lvh.me';
/** A DNS label no instructor would claim, so the fixture cannot collide. */
const SUBDOMAIN = 'zz-e2e-shortlink';
const FORM_SLUG = 'zz-e2e-short-link';

const PORT = new URL(BASE).port;
const siteHost = `${SUBDOMAIN}.${SITE_BASE_DOMAIN}${PORT ? `:${PORT}` : ''}`;

/**
 * Does the server behind BASE have the class-site rewriter switched on?
 *
 * A hostname nobody claims is a plain-text 404 from the middleware when the
 * feature is live, and falls through to the editor app's HTML when it is inert.
 * That difference is the whole capability check, and it needs no fixture.
 */
async function sitesEnabled(request: APIRequestContext): Promise<boolean> {
  const response = await request.get(`${BASE}/`, {
    headers: { host: 'nobody-claims-this.example' },
    maxRedirects: 0,
    failOnStatusCode: false,
  });
  return response.status() === 404;
}

/** The site row this file owns, and whatever it displaced. */
let restore: (() => Promise<void>) | null = null;

test.beforeAll(async ({ request }) => {
  if (!(await sitesEnabled(request))) return;

  const prisma = await getTestPrisma();
  const classroom = await prisma.classroom.findUnique({
    where: { slug: CLASS },
    select: { id: true },
  });
  if (!classroom) throw new Error(`test classroom ${CLASS} not found`);

  // A classroom holds at most one site (classroom_id is unique), so this may be
  // displacing a real one on a developer's machine. Remember what was there and
  // put it back — deleting somebody's claimed subdomain would be a rude test.
  const existing = await prisma.classroomSite.findUnique({
    where: { classroom_id: classroom.id },
  });

  await prisma.classroomSite.upsert({
    where: { classroom_id: classroom.id },
    create: { classroom_id: classroom.id, subdomain: SUBDOMAIN, is_enabled: true },
    update: { subdomain: SUBDOMAIN, is_enabled: true },
  });

  restore = async () => {
    if (existing) {
      await prisma.classroomSite.update({
        where: { classroom_id: classroom.id },
        data: { subdomain: existing.subdomain, is_enabled: existing.is_enabled },
      });
    } else {
      await prisma.classroomSite.delete({ where: { classroom_id: classroom.id } });
    }
  };
});

test.afterAll(async () => {
  if (restore) await restore();
  restore = null;
});

test.describe('the short form link on a class-site host', () => {
  test.beforeEach(async ({ request }) => {
    test.skip(
      !(await sitesEnabled(request)),
      `${BASE} has SITE_BASE_DOMAIN unset — see the header for how to run this`
    );
  });

  const bridged = async (request: APIRequestContext, path: string) => {
    const response = await request.get(`${BASE}${path}`, {
      headers: { host: siteHost },
      maxRedirects: 0,
      failOnStatusCode: false,
    });
    expect(response.status(), `${path} should 302`).toBe(302);
    const location = response.headers()['location'];
    expect(location, `${path} should carry a Location`).toBeTruthy();
    return new URL(location);
  };

  test('a fill link 302s to the canonical host, query intact', async ({ request }) => {
    const target = await bridged(request, `/forms/${FORM_SLUG}?x=1`);

    expect(target.pathname).toBe(`/${CLASS}/forms/${FORM_SLUG}`);
    expect(target.search).toBe('?x=1');
    // The point of the hop: it leaves the tenant hostname behind.
    expect(target.host).not.toBe(siteHost);
  });

  test('a magic link keeps its token', async ({ request }) => {
    // The one query parameter that is not decoration: without it the far side
    // renders "this link has expired" to someone holding a valid link.
    const target = await bridged(request, `/forms/${FORM_SLUG}/verify?token=abc123&utm=mail`);

    expect(target.pathname).toBe(`/${CLASS}/forms/${FORM_SLUG}/verify`);
    expect(target.searchParams.get('token')).toBe('abc123');
    expect(target.searchParams.get('utm')).toBe('mail');
  });

  test('the delivery poll is bridged too', async ({ request }) => {
    const target = await bridged(request, `/forms/${FORM_SLUG}/delivery`);
    expect(target.pathname).toBe(`/${CLASS}/forms/${FORM_SLUG}/delivery`);
  });

  test('the admin surfaces are not bridged', async ({ request }) => {
    // A course site is anonymous and script-less; a staff screen reached from
    // it could only bounce the visitor to a login on another origin.
    for (const path of [
      '/forms',
      '/forms/new',
      `/forms/${FORM_SLUG}/edit`,
      `/forms/${FORM_SLUG}/responses`,
      `/forms/${FORM_SLUG}/responses/export`,
    ]) {
      const response = await request.get(`${BASE}${path}`, {
        headers: { host: siteHost },
        maxRedirects: 0,
        failOnStatusCode: false,
      });
      expect(response.status(), `${path} should not bridge`).toBe(404);
    }
  });

  test('an address that matches no route is a branded not-found, not an outage', async ({
    request,
  }) => {
    // Lives in this file to reuse its site fixture (the `beforeAll` above is
    // the only place a class site is claimed for a test host), and because it
    // is the same class of bug: a link somebody shared, on a course host, that
    // the `_site` tree had no route for. The forms bridge got a route; two
    // segments past the host still fell through to React Router's built-in 404
    // and the ROOT error boundary's "This page is unavailable / Try again in a
    // moment." — a bad link reading as a broken server.
    //
    // The route-ranking half of the fix is covered without a server in
    // `tests/unit/site-routes.spec.ts`; this is the rendered proof.
    const response = await request.get(`${BASE}/dartmouth-cs52-26f/forms/cs52-waitlist`, {
      headers: { host: siteHost },
      maxRedirects: 0,
      failOnStatusCode: false,
    });

    expect(response.status()).toBe(404);
    const body = await response.text();
    // The apostrophe in "There's no site here" is HTML-escaped by the SSR pass,
    // so match the halves that survive verbatim.
    expect(body).toContain('no site here');
    expect(body).toContain('Classmoji course website');
    expect(body).not.toContain('Try again in a moment.');
    // The site tree is script-less; an error document is no exception.
    expect(body).not.toContain('window.__reactRouterContext');
  });

  test('the internal namespace stays unreachable from the canonical host', async ({ request }) => {
    // The bridge added a route under `/_site`; the middleware's refusal of that
    // prefix on the canonical host has to keep covering it.
    const response = await request.get(`${BASE}/_site/${SUBDOMAIN}/forms/${FORM_SLUG}`, {
      maxRedirects: 0,
      failOnStatusCode: false,
    });
    expect(response.status()).toBe(404);
  });
});
