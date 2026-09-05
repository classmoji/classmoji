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
 * private. `deckAccessFor` is the per-surface half of the fix, and the block
 * below pins it against the shapes `assertSlideAccess` actually returns: the
 * deck VIEWER is the only editing surface, and every other surface takes the
 * DECK's visibility.
 */

import { test, expect } from '@playwright/test';
import {
  deckAccessFor,
  deckDeliveryContext,
  gitBlobSha,
  isThumbnailRequest,
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
  classroom: {
    id: CLASSROOM,
    content_key_version: 3,
    content_repo: REPO,
    // The classroom's own switch. `deckDeliveryContext` refuses a context
    // without it, exactly as it refuses one with the env unset.
    content_delivery_enabled: true,
  },
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
    /**
     * Both halves out of one pass, exactly as the real resolver does it.
     *
     * The `src` inside a candidate set is the SAME string the url map carries
     * for that reference — that pairing is the contract, and it only holds
     * because both were minted together.
     */
    async resolveDelivery(_ctx, refs) {
      const urls = new Map<string, string>();
      const srcSets = new Map<string, { src: string; srcset: string }>();
      const own = `/content/${ORG}/${REPO}/`;
      for (const ref of refs) {
        if (!ref.startsWith(own)) {
          urls.set(ref, ref);
          continue;
        }
        const src = `${ORIGIN}/c/${CLASSROOM}/blob/sha-${ref.split('/').pop()}?p=edit`;
        urls.set(ref, src);
        if (/\.(png|jpe?g|webp|avif)$/i.test(ref)) {
          srcSets.set(ref, {
            src,
            srcset: [800, 1600, 2560].map(w => `${src}&w=${w}&fmt=auto ${w}w`).join(', '),
          });
        }
      }
      return { urls, srcSets };
    },
    async resolveThemeBase() {
      return null;
    },
    ...overrides,
  };
}

test.describe('tier selection', () => {
  test('runs through tierFor rather than a per-route rule', () => {
    expect(deckDeliveryContext(SLIDE, ORG, REPO, { canEdit: true })?.tier).toBe('edit');
    expect(deckDeliveryContext(SLIDE, ORG, REPO, { canEdit: false })?.tier).toBe('week');
    expect(deckDeliveryContext(SLIDE, ORG, REPO, { canEdit: false, isPublic: true })?.tier).toBe(
      'month'
    );
    // A staff preview outranks a public deck — editing, not browsing.
    expect(
      deckDeliveryContext(SLIDE, ORG, REPO, { canEdit: false, preview: true, isPublic: true })?.tier
    ).toBe('edit');
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
    expect(out).toContain(`${ORIGIN}/c/${CLASSROOM}/blob/sha-hero.jpeg?p=edit`);
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
      async resolveDelivery(_ctx, refs) {
        calls += 1;
        return fakeResolvers().resolveDelivery(_ctx, refs);
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
        async resolveDelivery() {
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
        async resolveDelivery(_ctx, refs) {
          seen.push(...refs);
          return fakeResolvers().resolveDelivery(_ctx, refs);
        },
        async resolveThemeBase() {
          return BASE;
        },
      }),
    });

    expect(themeBase).toBe(BASE);
    expect(out).toContain(`${BASE}lib/offline-v2.css`);
    expect(out).toContain(`${BASE}custom-theme.css`);
    expect(out).toContain(`${ORIGIN}/c/${CLASSROOM}/blob/sha-hero.jpeg?p=edit`);
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
    expect(out).toContain(`${ORIGIN}/c/${CLASSROOM}/blob/sha-hero.jpeg?p=edit`);
  });
});

test.describe('deckAccessFor — the tier inputs, per surface', () => {
  test('the viewer is the only editing surface, and follows the access result', () => {
    expect(deckAccessFor('viewer', OWNER, SLIDE)).toEqual({
      canEdit: true,
      preview: false,
      isPublic: false,
    });
    expect(deckAccessFor('viewer', ASSISTANT_NO_EDIT, SLIDE)).toEqual({
      canEdit: false,
      preview: false,
      isPublic: false,
    });
    expect(deckAccessFor('viewer', STUDENT, PUBLIC_SLIDE)).toEqual({
      canEdit: false,
      preview: false,
      isPublic: true,
    });
  });

  test('only the viewer honours a preview-BRANCH read', () => {
    const staffPreview = { canEdit: true, previewActive: true };
    expect(deckAccessFor('viewer', staffPreview, SLIDE).preview).toBe(true);
    // Everywhere else the flag is dropped on the floor. `/follow` has a
    // `?preview=true` of its own that means "thumbnail", and a surface that
    // let the two meet would sign a lecture hall into the 4h bucket.
    for (const surface of ['present', 'speaker', 'follow'] as const) {
      expect(deckAccessFor(surface, staffPreview, SLIDE).preview).toBeUndefined();
    }
  });

  test('no surface but the viewer claims edit access, whoever is looking', () => {
    // present/speaker stay open for hours and `edit` is an exact now+4h with
    // five minutes of grace, so a lazily-loaded background on slide 40 would
    // 403 after lunch. `/follow` is a READ surface for everyone including
    // staff — nobody edits a deck through the audience view, and `/speaker`
    // embeds it as an iframe. Content is sha-addressed, so the longer bucket
    // is the same bytes.
    for (const surface of ['present', 'speaker', 'follow'] as const) {
      for (const access of [OWNER, ASSISTANT_NO_EDIT, STUDENT]) {
        expect(deckAccessFor(surface, access, SLIDE)).toEqual({
          canEdit: false,
          isPublic: false,
        });
      }
      expect(deckAccessFor(surface, OWNER, PUBLIC_SLIDE)).toEqual({
        canEdit: false,
        isPublic: true,
      });
    }
  });

  test('the tiers those shapes actually produce', () => {
    const tierOf = (
      surface: Parameters<typeof deckAccessFor>[0],
      access: typeof OWNER,
      slide = SLIDE
    ) => deckDeliveryContext(slide, ORG, REPO, deckAccessFor(surface, access, slide))?.tier;

    // The one editing surface.
    expect(tierOf('viewer', OWNER)).toBe('edit');
    expect(tierOf('viewer', OWNER, PUBLIC_SLIDE)).toBe('edit');
    expect(tierOf('viewer', STUDENT)).toBe('week');
    expect(tierOf('viewer', STUDENT, PUBLIC_SLIDE)).toBe('month');

    // Every read surface reduces to the DECK's visibility and nothing else —
    // same answer for an owner and for a student, which is the whole point.
    for (const surface of ['present', 'speaker', 'follow'] as const) {
      for (const access of [OWNER, ASSISTANT_NO_EDIT, STUDENT]) {
        expect(tierOf(surface, access), `${surface} private`).toBe('week');
        expect(tierOf(surface, access, PUBLIC_SLIDE), `${surface} public`).toBe('month');
      }
    }
  });

  test('no read surface can reach `edit`, even handed a staff preview', () => {
    // The speaker view's current/next panes are `/follow?preview=true`
    // iframes, and a lecture that outran four hours used to 403 a lazily
    // loaded background mid-talk. This used to depend on `/follow` correctly
    // spotting its thumbnail flag; now it is structural — the flag never
    // reaches a tier decision, so there is nothing left to get wrong.
    const staffPreview = { canEdit: true, previewActive: true };
    for (const surface of ['present', 'speaker', 'follow'] as const) {
      for (const slide of [SLIDE, PUBLIC_SLIDE]) {
        const tier = deckDeliveryContext(
          slide,
          ORG,
          REPO,
          deckAccessFor(surface, staffPreview, slide)
        )?.tier;
        expect(tier, surface).not.toBe('edit');
      }
    }
  });
});

test.describe("the /follow route's own preview parameter", () => {
  const followUrl = (query: string) => new URL(`https://slides.classmoji.io/deck-1/follow${query}`);

  test('only `preview=true` is the thumbnail form', () => {
    expect(isThumbnailRequest(followUrl('?preview=true'))).toBe(true);
    expect(isThumbnailRequest(followUrl(''))).toBe(false);
    // `?preview=1` is the deck VIEWER's preview-BRANCH gate, a different
    // parameter on a different route. It is not a thumbnail.
    expect(isThumbnailRequest(followUrl('?preview=1'))).toBe(false);
    expect(isThumbnailRequest(followUrl('?preview=false'))).toBe(false);
    expect(isThumbnailRequest(followUrl('?shareCode=abc123'))).toBe(false);
  });

  test('the flag decides layout and cannot reach a signature', () => {
    // It used to feed the tier as well, to keep the speaker panes off the 4h
    // bucket. `deckAccessFor` now pins every `/follow` read to `canEdit:
    // false`, so both forms of the route mint the same tier and the parameter
    // has no way to affect one.
    for (const access of [OWNER, STUDENT]) {
      const tier = deckDeliveryContext(
        SLIDE,
        ORG,
        REPO,
        deckAccessFor('follow', access, SLIDE)
      )?.tier;
      expect(tier).toBe('week');
    }
    expect(
      deckDeliveryContext(
        PUBLIC_SLIDE,
        ORG,
        REPO,
        deckAccessFor('follow', OWNER, PUBLIC_SLIDE)
      )?.tier
    ).toBe('month');
  });
});

test.describe('gitBlobSha — naming what a save committed', () => {
  test('agrees with git hash-object', () => {
    // Pinned against `printf 'hello world\n' | git hash-object --stdin`. If
    // this drifts, a save can no longer recognise its own commit in the
    // loader's read and the viewer silently stops refreshing after a save.
    expect(gitBlobSha('hello world\n')).toBe('3b18e512dba79e4c8300dd08aeb37f8e728b8dad');
    // The empty blob, the other value git documents.
    expect(gitBlobSha('')).toBe('e69de29bb2d1d6434b8b29ae775ad8c2e48c5391');
  });

  test('hashes BYTES, not characters', () => {
    // The length in the header is the byte length — a deck full of typographic
    // quotes and em dashes would otherwise hash to something git never stored.
    expect(gitBlobSha('é')).toBe(gitBlobSha('\u00e9'));
    expect(gitBlobSha('a')).not.toBe(gitBlobSha('é'));
  });
});

test('deckDeliveryContext refuses a classroom that has not been opted in', () => {
  // The env is fully configured here (beforeEach set it) — this is the state
  // production is in on the day this ships, and the flag is what keeps every
  // deck on its legacy URLs until somebody chooses otherwise.
  const off = {
    ...SLIDE,
    classroom: { ...SLIDE.classroom, content_delivery_enabled: false },
  };
  expect(deckDeliveryContext(off, ORG, REPO, { canEdit: true })).toBe(null);

  const missing = {
    ...SLIDE,
    classroom: { id: CLASSROOM, content_key_version: 3, content_repo: REPO },
  };
  expect(deckDeliveryContext(missing, ORG, REPO, { canEdit: true })).toBe(null);
});

test.describe('responsive images', () => {
  test('a raster <img> gets a srcset and sizes; its plain src stays the fallback', async () => {
    const ref = `/content/${ORG}/${REPO}/slides/deck/a.png`;
    const { html: out } = await resolveDeckDelivery(`<img src="${ref}">`, ctx(), {
      resolvers: fakeResolvers(),
      themeName: null,
    });

    expect(out).toContain('srcset="');
    expect(out).toContain('sizes="');
    // The three rungs, each asking the pipeline for a width and a format. The
    // `&` separators are HTML-escaped in an attribute value, which is correct
    // and is why this matches on the tail rather than on a whole query string.
    for (const width of [800, 1600, 2560]) {
      expect(out).toContain(`w=${width}`);
      expect(out).toContain(`fmt=auto ${width}w`);
    }
    // And the untransformed original is still what `src` points at, which is
    // both the fallback for a browser that ignores srcset and the thing that
    // makes the src/srcset pair matchable by string equality.
    expect(out).toMatch(/src="[^"]*\/blob\/sha-a\.png\?p=edit"/);
  });

  test('never on a background attribute — Reveal paints those as CSS', async () => {
    const ref = `/content/${ORG}/${REPO}/slides/deck/bg.png`;
    const { html: out } = await resolveDeckDelivery(
      `<section data-background-image="${ref}"></section>`,
      ctx(),
      { resolvers: fakeResolvers(), themeName: null }
    );

    expect(out).toContain('data-background-image="');
    expect(out).not.toContain('srcset');
  });

  test('a gif, an svg and a foreign image get no set at all', async () => {
    const html = [
      `<img src="/content/${ORG}/${REPO}/slides/deck/loop.gif">`,
      `<img src="/content/${ORG}/${REPO}/slides/deck/logo.svg">`,
      '<img src="https://images.example.com/hero.png">',
    ].join('');

    const { html: out } = await resolveDeckDelivery(html, ctx(), {
      resolvers: fakeResolvers(),
      themeName: null,
    });

    expect(out).not.toContain('srcset');
  });

  test("does not clobber an author's own srcset", async () => {
    const html = '<img src="https://cdn.example.com/a.png" srcset="https://cdn.example.com/a2.png 2x">';
    const { html: out } = await resolveDeckDelivery(html, ctx(), {
      resolvers: fakeResolvers(),
      themeName: null,
    });

    expect(out).toBe(html);
  });
});

test('resolves a deck read in ONE pass, not one per concern', async () => {
  // Two passes would pay two asset-map reads per deck view AND read the clock
  // twice — and a bucketed expiry that turns over between them mints a
  // different `src` for the same file than the candidate list was built beside.
  let calls = 0;
  const html = `<img src="/content/${ORG}/${REPO}/a.png"><img src="/content/${ORG}/${REPO}/b.jpg">`;

  await resolveDeckDelivery(html, ctx(), {
    themeName: null,
    resolvers: fakeResolvers({
      async resolveDelivery(c, refs) {
        calls += 1;
        return fakeResolvers().resolveDelivery(c, refs);
      },
    }),
  });

  expect(calls).toBe(1);
});
