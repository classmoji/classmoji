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
 * private. The last test in this file guards that wiring at the source level,
 * because a loader test would need Postgres, GitHub and a session.
 */

import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import {
  deckDeliveryContext,
  isThemeRef,
  rebaseThemeRef,
  resolveDeckAssets,
  resolveDeckDelivery,
  sharedThemeName,
  type DeckDeliveryResolvers,
  type DeliveryContext,
} from '../../app/utils/deckDelivery.server.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ORG = 'cs98-org';
const REPO = 'cs98-content';
const CLASSROOM = '11111111-2222-3333-4444-555555555555';
const ORIGIN = 'https://content-staging.classmoji.io';

const SLIDE = {
  classroom: { id: CLASSROOM, content_key_version: 3, content_repo: REPO },
};

function ctx(): NonNullable<DeliveryContext> {
  const built = deckDeliveryContext(SLIDE, ORG, REPO, { canEdit: true });
  if (!built) throw new Error('expected a delivery context');
  return built;
}

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

  test('is a no-op when the delivery layer is unconfigured', async () => {
    // The REAL resolvers, with CONTENT_SIGNING_SECRET / CONTENT_DELIVERY_ORIGIN
    // unset: resolveMany hands every ref back unchanged before it ever reaches
    // the asset map, and resolveThemeBase returns null.
    delete process.env.CONTENT_SIGNING_SECRET;
    delete process.env.CONTENT_DELIVERY_ORIGIN;
    const html = [
      `<link rel="stylesheet" href="/content/${ORG}/${REPO}/.slidesthemes/cs98/lib/offline-v2.css">`,
      `<div class="reveal" data-theme="shared:cs98"><div class="slides">`,
      `<section><img src="/content/${ORG}/${REPO}/slides/w1/images/hero.jpeg"></section>`,
      `</div></div>`,
    ].join('');
    const { html: out, themeBase } = await resolveDeckDelivery(html, ctx());
    expect(out).toBe(html);
    expect(themeBase).toBeNull();
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

test.describe('every deck surface runs the pass', () => {
  // A loader test would need Postgres, GitHub and a session; this is the
  // cheapest honest guard that the three presentation routes did not quietly
  // stop resolving. Precedent: tests/unit/session-cookie.spec.ts.
  const ROUTES = ['$slideId_.present', '$slideId_.follow', '$slideId_.speaker'];

  for (const route of ROUTES) {
    test(`${route} resolves deck assets in its loader`, () => {
      const file = path.join(__dirname, '../../app/routes', route, 'route.tsx');
      const source = fs.readFileSync(file, 'utf-8');
      expect(source).toContain("from '~/utils/deckDelivery.server'");
      expect(source).toContain('resolveDeckDelivery(');
      expect(source).toContain('deckDeliveryContext(');
      // The tier comes from the access result, never from a literal.
      expect(source).toMatch(/canEdit[,\s]/);
    });
  }

  test('$slideId keeps resolving through the shared module', () => {
    const file = path.join(__dirname, '../../app/routes/$slideId/route.tsx');
    const source = fs.readFileSync(file, 'utf-8');
    expect(source).toContain("from '~/utils/deckDelivery.server'");
    expect(source).toContain('resolveDeckAssets(slideContent, deliveryCtx)');
  });
});
