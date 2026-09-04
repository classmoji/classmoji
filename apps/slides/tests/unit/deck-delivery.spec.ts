/**
 * Unit tests for `deckDelivery.server` — the ONE read-side content-delivery
 * pass every deck surface runs.
 *
 * These run in the Playwright runner WITHOUT a browser or the dev stack. The
 * asset map lives in Postgres, so the two delivery calls are injected
 * (`opts.resolvers`); what is pinned here is the COMPOSITION the module owns —
 * which references reach the blob resolver, which are rebased onto the signed
 * theme folder, and what happens to the ones nobody claims. The resolver's own
 * "is this URL even ours" rule is pinned separately, in
 * `packages/services/src/classmoji/__tests__/contentDelivery.resolve.test.ts`.
 *
 * The regression that produced this file: the rewrite lived inside the deck
 * VIEWER route, so `/present`, `/follow` and `/speaker` served raw
 * `/content/{org}/{repo}/...` URLs — dead the moment a content repo goes
 * private. `deckAccessFor` is the per-surface half of the fix, and the last
 * block here pins it against the shapes `assertSlideAccess` actually returns.
 */

import { test, expect } from '@playwright/test';
import {
  deckAccessFor,
  deckDeliveryContext,
  isThemeRef,
  rebaseThemeRef,
  resolveDeckAssets,
  resolveDeckDelivery,
  sharedThemeName,
  type DeckDeliveryResolvers,
  type DeliveryContext,
} from '../../app/utils/deckDelivery.server.ts';

const ORG = 'cs98-org';
const REPO = 'cs98-content';
const CLASSROOM = '11111111-2222-3333-4444-555555555555';
const ORIGIN = 'https://content-staging.classmoji.io';

const SLIDE = {
  classroom: { id: CLASSROOM, content_key_version: 3, content_repo: REPO },
  is_public: false,
};

/**
 * `deckDeliveryContext` refuses to exist when the delivery layer is off, so
 * every test that wants a context has to switch it on — and put the process
 * back exactly as it found it. The runner is `workers: 1`, so a leaked delete
 * here would silently disable the layer for every later spec in the file.
 */
const ENV_KEYS = ['CONTENT_SIGNING_SECRET', 'CONTENT_DELIVERY_ORIGIN'] as const;
let savedEnv: Record<string, string | undefined> = {};

test.beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
  process.env.CONTENT_SIGNING_SECRET = 'test-master-secret';
  process.env.CONTENT_DELIVERY_ORIGIN = ORIGIN;
});

test.afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

function ctx(): NonNullable<DeliveryContext> {
  const built = deckDeliveryContext(SLIDE, ORG, REPO, { canEdit: true });
  if (!built) throw new Error('expected a delivery context');
  return built;
}

/** Owner / teacher: edits anything. */
const OWNER = { canEdit: true };
/** Assistant on a colleague's deck without `allow_team_edit`: staff, no edit. */
const ASSISTANT_NO_EDIT = { canEdit: false };
/** Student, and a shareCode guest — same shape from the tier's point of view. */
const STUDENT = { canEdit: false };
const PUBLIC_SLIDE = { ...SLIDE, is_public: true };

/**
 * Stands in for `contentDelivery.resolveMany`: signs whatever lives under this
 * classroom's own content path and hands everything else straight back, which
 * is the contract the real resolver keeps.
 */
function fakeResolvers(overrides: Partial<DeckDeliveryResolvers> = {}): DeckDeliveryResolvers {
  return {
    async resolveMany(_ctx, refs) {
      const out = new Map<string, string>();
      const own = `/content/${ORG}/${REPO}/`;
      for (const ref of refs) {
        out.set(
          ref,
          ref.startsWith(own)
            ? `${ORIGIN}/c/${CLASSROOM}/blob/sha-${ref.split('/').pop()}?p=draft`
            : ref
        );
      }
      return out;
    },
    async resolveThemeBase() {
      return null;
    },
    ...overrides,
  };
}

test.describe('tier selection', () => {
  test('runs through tierFor rather than a per-route rule', () => {
    expect(deckDeliveryContext(SLIDE, ORG, REPO, { canEdit: true })?.tier).toBe('draft');
    expect(deckDeliveryContext(SLIDE, ORG, REPO, { canEdit: false })?.tier).toBe('enrolled');
    expect(
      deckDeliveryContext(SLIDE, ORG, REPO, { canEdit: false, isPublicSite: true })?.tier
    ).toBe('public');
    // A staff preview outranks a public deck — editing, not browsing.
    expect(
      deckDeliveryContext(SLIDE, ORG, REPO, { canEdit: false, preview: true, isPublicSite: true })
        ?.tier
    ).toBe('draft');
  });

  test('no context at all when the classroom cannot be served', () => {
    expect(deckDeliveryContext(SLIDE, undefined, REPO, { canEdit: true })).toBeNull();
    expect(deckDeliveryContext(SLIDE, ORG, undefined, { canEdit: true })).toBeNull();
    expect(deckDeliveryContext({ classroom: null }, ORG, REPO, { canEdit: true })).toBeNull();
  });

  test('no context at all when the delivery layer is switched off', () => {
    delete process.env.CONTENT_SIGNING_SECRET;
    expect(deckDeliveryContext(SLIDE, ORG, REPO, { canEdit: true })).toBeNull();

    process.env.CONTENT_SIGNING_SECRET = 'test-master-secret';
    delete process.env.CONTENT_DELIVERY_ORIGIN;
    expect(deckDeliveryContext(SLIDE, ORG, REPO, { canEdit: true })).toBeNull();
  });
});

test.describe('asset rewriting', () => {
  test('signs image references into this repo', async () => {
    const html = `<div class="slides"><section><img src="/content/${ORG}/${REPO}/slides/w1/images/hero.jpeg"></section></div>`;
    const { html: out } = await resolveDeckDelivery(html, ctx(), {
      resolvers: fakeResolvers(),
    });
    expect(out).toContain(`${ORIGIN}/c/${CLASSROOM}/blob/sha-hero.jpeg?p=draft`);
    expect(out).not.toContain(`/content/${ORG}/${REPO}/slides`);
  });

  test('leaves foreign and inline URLs byte-identical', async () => {
    const html = [
      '<div class="slides"><section>',
      '<img src="https://example.com/outside.png">',
      '<img src="/content/other-org/other-repo/a.png">',
      '<img src="data:image/gif;base64,R0lGOD">',
      '</section></div>',
    ].join('');
    const { html: out } = await resolveDeckDelivery(html, ctx(), {
      resolvers: fakeResolvers(),
    });
    expect(out).toBe(html);
  });

  test('is a no-op without a delivery context', async () => {
    const html = `<img src="/content/${ORG}/${REPO}/a.png">`;
    const { html: out, themeBase } = await resolveDeckDelivery(html, null);
    expect(out).toBe(html);
    expect(themeBase).toBeNull();
  });

  test('is a no-op when the delivery layer is unconfigured — and does no work', async () => {
    const html = [
      `<link rel="stylesheet" href="/content/${ORG}/${REPO}/.slidesthemes/cs98/lib/offline-v2.css">`,
      `<div class="reveal" data-theme="shared:cs98"><div class="slides">`,
      `<section><img src="/content/${ORG}/${REPO}/slides/w1/images/hero.jpeg"></section>`,
      `</div></div>`,
    ].join('');

    delete process.env.CONTENT_SIGNING_SECRET;
    delete process.env.CONTENT_DELIVERY_ORIGIN;

    // The route builds its context exactly like this, and gets nothing — which
    // is what keeps the cheerio parse and both delivery calls off the read
    // path of a deployment that could not have rewritten anything anyway.
    const offCtx = deckDeliveryContext(SLIDE, ORG, REPO, { canEdit: true });
    expect(offCtx).toBeNull();

    let calls = 0;
    const counting: DeckDeliveryResolvers = {
      async resolveMany(_ctx, refs) {
        calls += 1;
        return fakeResolvers().resolveMany(_ctx, refs);
      },
      async resolveThemeBase() {
        calls += 1;
        return null;
      },
    };

    const { html: out, themeBase } = await resolveDeckDelivery(html, offCtx, {
      resolvers: counting,
    });
    expect(out).toBe(html);
    expect(themeBase).toBeNull();
    expect(calls).toBe(0);
  });

  test('a resolver blow-up serves the stored URLs instead of failing the read', async () => {
    const html = `<img src="/content/${ORG}/${REPO}/a.png">`;
    const { html: out } = await resolveDeckDelivery(html, ctx(), {
      resolvers: fakeResolvers({
        async resolveMany() {
          throw new Error('asset map is down');
        },
      }),
    });
    expect(out).toBe(html);
  });
});

test.describe('shared theme links', () => {
  const BASE = `${ORIGIN}/c/${CLASSROOM}/theme/cs98/${'a'.repeat(40)}/draft.3.999.sig/`;

  test('reads the declared theme off the document', () => {
    expect(sharedThemeName('<div class="reveal" data-theme="shared:cs98-dark">')).toBe('cs98-dark');
    expect(sharedThemeName('<div class="reveal" data-theme="black">')).toBeNull();
    expect(sharedThemeName(null)).toBeNull();
  });

  test('rebases a theme file onto the signed folder, keeping the filename', () => {
    expect(
      rebaseThemeRef(`/content/${ORG}/${REPO}/.slidesthemes/cs98/lib/offline-v2.css`, 'cs98', BASE)
    ).toBe(`${BASE}lib/offline-v2.css`);
    expect(
      rebaseThemeRef(`/content/${ORG}/${REPO}/.slidesthemes/cs98/custom-theme.css`, 'cs98', BASE)
    ).toBe(`${BASE}custom-theme.css`);
    // Another theme's file is not this theme's problem.
    expect(
      rebaseThemeRef(`/content/${ORG}/${REPO}/.slidesthemes/other/lib/a.css`, 'cs98', BASE)
    ).toBeNull();
    expect(rebaseThemeRef('/content/o/r/slides/w1/images/hero.jpeg', 'cs98', BASE)).toBeNull();
    expect(isThemeRef(`/content/${ORG}/${REPO}/.slidesthemes/cs98/lib/a.css`)).toBe(true);
    expect(isThemeRef(`/content/${ORG}/${REPO}/slides/w1/images/hero.jpeg`)).toBe(false);
  });

  test('signs the head links and keeps them out of the blob resolver', async () => {
    const seen: string[] = [];
    const html = [
      `<html><head>`,
      `<link rel="stylesheet" href="/content/${ORG}/${REPO}/.slidesthemes/cs98/lib/offline-v2.css">`,
      `<link rel="stylesheet" href="/content/${ORG}/${REPO}/.slidesthemes/cs98/custom-theme.css">`,
      `</head><body><div class="reveal" data-theme="shared:cs98"><div class="slides">`,
      `<section><img src="/content/${ORG}/${REPO}/slides/w1/images/hero.jpeg"></section>`,
      `</div></div></body></html>`,
    ].join('');

    const { html: out, themeBase } = await resolveDeckDelivery(html, ctx(), {
      resolvers: fakeResolvers({
        async resolveMany(_ctx, refs) {
          seen.push(...refs);
          return fakeResolvers().resolveMany(_ctx, refs);
        },
        async resolveThemeBase() {
          return BASE;
        },
      }),
    });

    expect(themeBase).toBe(BASE);
    expect(out).toContain(`${BASE}lib/offline-v2.css`);
    expect(out).toContain(`${BASE}custom-theme.css`);
    expect(out).toContain(`${ORIGIN}/c/${CLASSROOM}/blob/sha-hero.jpeg?p=draft`);
    // A theme file signed as a standalone blob would break the relative
    // `url()` references the folder signature exists for.
    expect(seen.some(ref => ref.includes('.slidesthemes/'))).toBe(false);
  });

  test('resolveDeckAssets skips the theme pass entirely', async () => {
    let themeCalls = 0;
    const html = [
      `<link rel="stylesheet" href="/content/${ORG}/${REPO}/.slidesthemes/cs98/lib/offline-v2.css">`,
      `<div class="reveal" data-theme="shared:cs98"><div class="slides">`,
      `<section><img src="/content/${ORG}/${REPO}/slides/w1/images/hero.jpeg"></section>`,
      `</div></div>`,
    ].join('');

    const out = await resolveDeckAssets(html, ctx(), {
      resolvers: fakeResolvers({
        async resolveThemeBase() {
          themeCalls += 1;
          return BASE;
        },
      }),
    });

    expect(themeCalls).toBe(0);
    expect(out).toContain(`/content/${ORG}/${REPO}/.slidesthemes/cs98/lib/offline-v2.css`);
    expect(out).toContain(`${ORIGIN}/c/${CLASSROOM}/blob/sha-hero.jpeg?p=draft`);
  });
});

test.describe('deckAccessFor — the tier inputs, per surface', () => {
  test('the viewer follows the access result exactly', () => {
    expect(deckAccessFor('viewer', OWNER, SLIDE)).toEqual({
      canEdit: true,
      preview: false,
      isPublicSite: false,
    });
    expect(deckAccessFor('viewer', ASSISTANT_NO_EDIT, SLIDE)).toEqual({
      canEdit: false,
      preview: false,
      isPublicSite: false,
    });
    expect(deckAccessFor('viewer', STUDENT, PUBLIC_SLIDE)).toEqual({
      canEdit: false,
      preview: false,
      isPublicSite: true,
    });
  });

  test('only the viewer honours a preview-BRANCH read', () => {
    const staffPreview = { canEdit: true, previewActive: true };
    expect(deckAccessFor('viewer', staffPreview, SLIDE).preview).toBe(true);
    // /follow has a `?preview=true` of its own that means "thumbnail". Even
    // handed the viewer's flag, this surface must never mint draft URLs — a
    // lecture hall of students would be signing into the 4h bucket.
    expect(deckAccessFor('follow', staffPreview, SLIDE).preview).toBe(false);
    expect(deckAccessFor('present', staffPreview, SLIDE).preview).toBeUndefined();
    expect(deckAccessFor('speaker', staffPreview, SLIDE).preview).toBeUndefined();
  });

  test('present and speaker never claim edit access, whoever is looking', () => {
    // Both surfaces stay open for hours; draft is an exact now+4h with five
    // minutes of grace, so a lazily-loaded background on slide 40 would 403
    // after lunch. Content is sha-addressed, so the longer bucket is the same
    // bytes.
    for (const surface of ['present', 'speaker'] as const) {
      for (const access of [OWNER, ASSISTANT_NO_EDIT, STUDENT]) {
        expect(deckAccessFor(surface, access, SLIDE)).toEqual({
          canEdit: false,
          isPublicSite: false,
        });
      }
      expect(deckAccessFor(surface, OWNER, PUBLIC_SLIDE).isPublicSite).toBe(true);
    }
  });

  test('follow passes a follower through untouched', () => {
    // A shareCode guest and an enrolled student are the same shape here.
    expect(deckAccessFor('follow', STUDENT, SLIDE)).toEqual({
      canEdit: false,
      preview: false,
      isPublicSite: false,
    });
    // Staff following along still edit, so they still get the draft bucket.
    expect(deckAccessFor('follow', OWNER, SLIDE).canEdit).toBe(true);
  });

  test('the tiers those shapes actually produce', () => {
    const tierOf = (
      surface: Parameters<typeof deckAccessFor>[0],
      access: typeof OWNER,
      slide = SLIDE
    ) => deckDeliveryContext(slide, ORG, REPO, deckAccessFor(surface, access, slide))?.tier;

    expect(tierOf('viewer', OWNER)).toBe('draft');
    expect(tierOf('present', OWNER)).toBe('enrolled');
    expect(tierOf('speaker', OWNER)).toBe('enrolled');
    expect(tierOf('present', OWNER, PUBLIC_SLIDE)).toBe('public');
    expect(tierOf('follow', STUDENT)).toBe('enrolled');
    expect(tierOf('follow', STUDENT, PUBLIC_SLIDE)).toBe('public');
    expect(tierOf('follow', OWNER)).toBe('draft');
  });
});
