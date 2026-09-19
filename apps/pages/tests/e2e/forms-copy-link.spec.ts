import { test, expect } from '@playwright/test';

import { getTestClassroomSlug, getTestPrisma } from '../helpers';

/**
 * What "Copy link" copies — the WHOLE URL, the whole matrix, against a real
 * database.
 *
 * The whole URL is the point. An earlier version of this file asserted only the
 * origin, and the path was appended by each caller — always in the pages shape,
 * `/{classroomSlug}/forms/{formSlug}`. A class-site host does not serve that
 * path: `app/site/forms.ts` bridges the SHORT `/forms/{formSlug}` and 404s
 * everything else, so every link copied for a classroom with a site was a 404,
 * on the subdomain as well as on a custom domain. Asserting the origin alone is
 * what let it through, so these assertions name the string an instructor
 * actually pastes.
 *
 * `publicFormUrlFor` asks `canonicalOriginForSite` for the hostname, the same
 * rule the class site uses for its own `rel=canonical`, so a course that has
 * connected its own domain shares forms on that domain. The four rows below are
 * that rule seen from the forms side: a claim only counts once it is VERIFIED
 * and the classroom is actually on PRO, and every other combination stays on
 * the subdomain.
 *
 * ── Why this is here and not in tests/unit ─────────────────────────────────
 * The other specs for this decision (`custom-domains.spec.ts`) test
 * `seoOriginFor`, which is pure. What is tested here is not that rule but the
 * WIRING to it, and the wiring runs two database reads — the site row and the
 * classroom's PRO state. The Playwright runner has no module mocking, and
 * bending production code into an injection seam to fake a subscription would
 * be a bigger change than the one under test. So this seeds the rows and calls
 * the real function, in the process, with no server involved: `tests/unit` is
 * for the decisions that are pure, and this one is not.
 *
 * The fixture is INSERT-ONLY on subscriptions. The dev seed already gives both
 * owners an active PRO, so "not on PRO" cannot be arranged by leaving things
 * alone — but it must also not be arranged by editing somebody's rows. Instead
 * a newer FREE subscription is added for every accepted owner, which is what
 * `getProStateForClassroomId` reads (each owner's newest row, any active PRO
 * wins), and the added rows are deleted again afterwards.
 */

const CLASS = getTestClassroomSlug();

/** Labels no instructor would claim, so the fixture cannot collide. */
const SUBDOMAIN = 'zz-e2e-copy-link';
const CUSTOM_DOMAIN = 'zz-e2e-copy-link.example';

/**
 * The site feature is switched on IN THIS PROCESS only.
 *
 * `siteOrigin` and `customDomainOrigin` read the environment at call time, so
 * setting these here configures the function under test without touching the
 * dev server — which deliberately runs with SITE_BASE_DOMAIN unset, because a
 * `.lvh.me` cookie domain breaks every localhost login in the stack.
 */
const SITE_BASE_DOMAIN = 'classmoji.io';
const PAGES_URL = 'https://pages.classmoji.io';

const SUBDOMAIN_ORIGIN = `https://${SUBDOMAIN}.${SITE_BASE_DOMAIN}`;
const CUSTOM_DOMAIN_ORIGIN = `https://${CUSTOM_DOMAIN}`;

/** What the copied link falls back to: the origin serving the admin screen. */
const REQUEST_ORIGIN = 'http://localhost:7100';

/**
 * Any slug at all. `publicFormUrlFor` never looks the form up — it decides on
 * the CLASSROOM's site and then builds a path — so no row has to exist for
 * these assertions to be the real ones.
 */
const FORM_SLUG = 'zz-e2e-copy-link-form';

/** The short bridge path, the only forms URL a class-site host serves. */
const siteLink = (origin: string) => `${origin}/forms/${FORM_SLUG}`;
/** The canonical pages route, which the bridge redirects to. */
const pagesLink = `${REQUEST_ORIGIN}/${CLASS}/forms/${FORM_SLUG}`;

type Classroom = { id: string; status: string; is_archived: boolean };

let publicFormUrlFor: typeof import('../../app/forms/admin/adminLinks.server.ts').publicFormUrlFor;
let classroom: Classroom;
/** The site row this file displaced, if the machine had one. */
let restoreSite: (() => Promise<void>) | null = null;
/** Subscriptions this file inserted, deleted again in afterAll. */
let seededSubscriptionIds: string[] = [];
const previousEnv: Record<string, string | undefined> = {};

test.beforeAll(async () => {
  previousEnv.SITE_BASE_DOMAIN = process.env.SITE_BASE_DOMAIN;
  previousEnv.PAGES_URL = process.env.PAGES_URL;
  process.env.SITE_BASE_DOMAIN = SITE_BASE_DOMAIN;
  process.env.PAGES_URL = PAGES_URL;

  const prisma = await getTestPrisma();
  // Imported AFTER getTestPrisma has resolved DATABASE_URL from `.dev-context`
  // — the module chain constructs its Prisma client at import, and a static
  // import at the top of this file would bind the wrong database on a devport.
  ({ publicFormUrlFor } = await import('../../app/forms/admin/adminLinks.server.ts'));

  const found = await prisma.classroom.findUnique({
    where: { slug: CLASS },
    select: { id: true, status: true, is_archived: true },
  });
  if (!found) throw new Error(`test classroom ${CLASS} not found — is the dev database seeded?`);
  classroom = found;

  // A classroom holds at most one site (classroom_id is unique), so this may be
  // displacing a real one. Remember every column this file writes — including
  // the two custom-domain ones, which a developer may well have set — and put
  // them back.
  const existing = await prisma.classroomSite.findUnique({
    where: { classroom_id: classroom.id },
  });

  await prisma.classroomSite.upsert({
    where: { classroom_id: classroom.id },
    create: { classroom_id: classroom.id, subdomain: SUBDOMAIN, is_enabled: true },
    update: {
      subdomain: SUBDOMAIN,
      is_enabled: true,
      custom_domain: null,
      custom_domain_verified_at: null,
    },
  });

  restoreSite = async () => {
    if (existing) {
      await prisma.classroomSite.update({
        where: { classroom_id: classroom.id },
        data: {
          subdomain: existing.subdomain,
          is_enabled: existing.is_enabled,
          custom_domain: existing.custom_domain,
          custom_domain_verified_at: existing.custom_domain_verified_at,
        },
      });
    } else {
      await prisma.classroomSite.delete({ where: { classroom_id: classroom.id } });
    }
  };

  const owners = await prisma.classroomMembership.findMany({
    where: { classroom_id: classroom.id, role: 'OWNER', has_accepted_invite: true },
    select: { user_id: true },
  });
  if (owners.length === 0) {
    throw new Error(`${CLASS} has no accepted OWNER — the PRO cases cannot be arranged`);
  }

  // The non-PRO baseline: one FREE row per owner, newer than anything the seed
  // wrote, so every owner's newest subscription is FREE and `isPro` is false.
  const baselineAt = new Date();
  const created = await Promise.all(
    owners.map(owner =>
      prisma.subscription.create({
        data: { user_id: owner.user_id, tier: 'FREE', created_at: baselineAt },
        select: { id: true },
      })
    )
  );
  seededSubscriptionIds = created.map(row => row.id);
});

test.afterAll(async () => {
  const prisma = await getTestPrisma();
  if (seededSubscriptionIds.length > 0) {
    await prisma.subscription.deleteMany({ where: { id: { in: seededSubscriptionIds } } });
    seededSubscriptionIds = [];
  }
  if (restoreSite) await restoreSite();
  restoreSite = null;

  process.env.SITE_BASE_DOMAIN = previousEnv.SITE_BASE_DOMAIN;
  process.env.PAGES_URL = previousEnv.PAGES_URL;
  // Deleting rather than assigning undefined: `process.env.X = undefined` sets
  // the STRING "undefined", which would leave the site feature on for whatever
  // spec runs next in this worker.
  if (previousEnv.SITE_BASE_DOMAIN === undefined) delete process.env.SITE_BASE_DOMAIN;
  if (previousEnv.PAGES_URL === undefined) delete process.env.PAGES_URL;
});

/** Point the site row at a custom domain (or not), verified or not. */
async function setCustomDomain(options: { domain: string | null; verified: boolean }) {
  const prisma = await getTestPrisma();
  await prisma.classroomSite.update({
    where: { classroom_id: classroom.id },
    data: {
      custom_domain: options.domain,
      // The DB CHECK forbids a stamp without a domain, which is also exactly
      // the state this helper should never be asked to build.
      custom_domain_verified_at: options.domain && options.verified ? new Date() : null,
    },
  });
}

/** Give the first accepted owner an active PRO, newer than the FREE baseline. */
async function withProSubscription(run: () => Promise<void>) {
  const prisma = await getTestPrisma();
  const owner = await prisma.classroomMembership.findFirst({
    where: { classroom_id: classroom.id, role: 'OWNER', has_accepted_invite: true },
    select: { user_id: true },
  });
  const pro = await prisma.subscription.create({
    data: {
      user_id: owner!.user_id,
      tier: 'PRO',
      // No `ends_at` is what "still live" means to isSubscriptionActive, and a
      // later created_at is what makes this the row that owner's tier is read
      // from.
      ends_at: null,
      created_at: new Date(Date.now() + 60_000),
    },
    select: { id: true },
  });

  try {
    await run();
  } finally {
    await prisma.subscription.delete({ where: { id: pro.id } });
  }
}

/** The URL the copy button would hand out for `FORM_SLUG` on this classroom. */
async function copiedLink(withClassroom: Classroom = classroom): Promise<string> {
  const build = await publicFormUrlFor(withClassroom, REQUEST_ORIGIN, CLASS);
  return build(FORM_SLUG);
}

test.describe('the URL "Copy link" copies', () => {
  test('a site with no custom domain keeps the subdomain', async () => {
    // The behaviour before this change, and the one almost every classroom has.
    await setCustomDomain({ domain: null, verified: false });

    expect(await copiedLink()).toBe(siteLink(SUBDOMAIN_ORIGIN));
  });

  test('a VERIFIED custom domain on an active PRO is what gets copied', async () => {
    // The point of the change: a course that has connected its own domain
    // shares its forms on that domain, the same hostname its pages call
    // canonical.
    await setCustomDomain({ domain: CUSTOM_DOMAIN, verified: true });

    await withProSubscription(async () => {
      expect(await copiedLink()).toBe(siteLink(CUSTOM_DOMAIN_ORIGIN));
    });
  });

  test('an UNVERIFIED claim is not copied', async () => {
    // Nothing has proved the hostname resolves to us yet. Handing an instructor
    // a link on it would be handing them a link that may never load.
    await setCustomDomain({ domain: CUSTOM_DOMAIN, verified: false });

    await withProSubscription(async () => {
      expect(await copiedLink()).toBe(siteLink(SUBDOMAIN_ORIGIN));
    });
  });

  test('a verified domain whose PRO has LAPSED falls back to the subdomain', async () => {
    // Deliberate, and the reason the site's own rule is reused rather than
    // restated: while PRO is lapsed the custom host 302s visitors to the
    // subdomain, so the subdomain link is the one that keeps working. A longer
    // URL beats a broken one.
    await setCustomDomain({ domain: CUSTOM_DOMAIN, verified: true });

    expect(await copiedLink()).toBe(siteLink(SUBDOMAIN_ORIGIN));
  });
});

test.describe('the guards that keep a copied link off a site that does not serve', () => {
  test('a disabled site, an archived or unpublished classroom all copy the request origin', async () => {
    // Unchanged by the canonical rule, and each of them would otherwise mint a
    // short link that 404s: `getSiteBySubdomain` refuses all three, and the
    // bridge resolves through it.
    await setCustomDomain({ domain: CUSTOM_DOMAIN, verified: true });

    await withProSubscription(async () => {
      const prisma = await getTestPrisma();

      expect(await copiedLink({ ...classroom, is_archived: true })).toBe(pagesLink);
      expect(await copiedLink({ ...classroom, status: 'UNPUBLISHED' })).toBe(pagesLink);

      await prisma.classroomSite.update({
        where: { classroom_id: classroom.id },
        data: { is_enabled: false },
      });
      try {
        expect(await copiedLink()).toBe(pagesLink);
      } finally {
        await prisma.classroomSite.update({
          where: { classroom_id: classroom.id },
          data: { is_enabled: true },
        });
      }
    });
  });
});
