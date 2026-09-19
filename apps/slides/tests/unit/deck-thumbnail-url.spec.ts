/**
 * Unit tests for the deck THUMBNAIL side of `deckDelivery.server` — how a
 * stored `thumbnail.webp` becomes a URL the index can put in an `<img>`, and
 * how a deck's own images become URLs a screenshot service can fetch.
 *
 * These run in the Playwright runner WITHOUT a browser or the dev stack. The
 * asset map lives in Postgres, so the one delivery call is injected; what is
 * pinned here is the DECISION the module owns — which of the three answers a
 * deck gets, and that it costs one call per classroom rather than one per deck.
 *
 * The two halves are deliberately different, and the tests say why:
 *
 *   - the INDEX is a signed-in page, so a classroom the delivery layer is off
 *     for takes the app's own `/content/…` proxy, whose gate that session
 *     already satisfies;
 *   - the RENDER (`$slideId_.thumbnail-source`) is opened by a headless browser
 *     holding a render token and no session at all, so the same classroom's
 *     references have to leave as public CDN URLs or the screenshot comes back
 *     with holes in it.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';
import {
  publicContentUrl,
  publicDeckThemeUrls,
  resolveDeckAssetsPublic,
  resolveDeckThumbnailUrls,
  type ThumbnailResolver,
  type ThumbnailSlide,
} from '../../app/utils/deckDelivery.server.ts';
import {
  ENQUEUE_WINDOW_MS,
  enqueueDeckThumbnail,
  isWithinEnqueueWindow,
  resetEnqueueWindows,
} from '../../app/utils/deckThumbnailEnqueue.server.ts';

const ORG = 'cs98-org';
const REPO = 'cs98-content';
const CLASSROOM = '11111111-2222-3333-4444-555555555555';
const OTHER_CLASSROOM = '99999999-8888-7777-6666-555555555555';
const ORIGIN = 'https://content-staging.classmoji.io';

/**
 * `deckDeliveryContext` refuses to exist when the delivery layer is off, so a
 * test that wants signing has to switch it on — and put the process back
 * exactly as it found it. The runner is `workers: 1`, so a leak here would
 * silently change the layer for every later spec.
 */
const ENV_KEYS = ['CONTENT_SIGNING_SECRET', 'CONTENT_DELIVERY_ORIGIN'] as const;
let savedEnv: Record<string, string | undefined> = {};

test.beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
  process.env.CONTENT_SIGNING_SECRET = 'test-master-secret';
  process.env.CONTENT_DELIVERY_ORIGIN = ORIGIN;
  resetEnqueueWindows();
});

test.afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  resetEnqueueWindows();
});

const CLASSROOM_ON = {
  id: CLASSROOM,
  content_key_version: 3,
  content_repo: REPO,
  content_delivery_enabled: true,
  git_organization: { login: ORG },
};

function slide(over: Partial<ThumbnailSlide> = {}): ThumbnailSlide {
  return {
    id: 'deck-1',
    is_public: false,
    thumbnail_path: 'slides/week-1/thumbnail.webp',
    classroom: CLASSROOM_ON,
    ...over,
  };
}

/** Stands in for `contentDelivery.resolveMany`, and records what it was asked. */
function fakeResolver(): ThumbnailResolver & {
  calls: Array<{ classroomId: string; tier: string; refs: string[] }>;
} {
  const calls: Array<{ classroomId: string; tier: string; refs: string[] }> = [];
  const resolve = (async (ctx, refs) => {
    calls.push({ classroomId: ctx.classroom.id, tier: ctx.tier, refs });
    return new Map(
      refs.map(ref => [ref, `${ORIGIN}/c/${ctx.classroom.id}/blob/${ref}?p=${ctx.tier}`])
    );
  }) as ThumbnailResolver & { calls: typeof calls };
  resolve.calls = calls;
  return resolve;
}

test.describe('a deck thumbnail URL', () => {
  test('is a signed delivery URL when the classroom gate is ON', async () => {
    const resolve = fakeResolver();
    const urls = await resolveDeckThumbnailUrls([slide()], { resolve });

    expect(urls.get('deck-1')).toBe(
      `${ORIGIN}/c/${CLASSROOM}/blob/slides/week-1/thumbnail.webp?p=week`
    );
    expect(resolve.calls).toHaveLength(1);
  });

  test('takes the DECK’s visibility for its tier, never `edit`', async () => {
    // `edit` mints `no-store` on an exact four-hour expiry, which is precisely
    // wrong for an image whose entire job is to be cached hard. A public deck
    // gets `month`, everything else `week` — and the viewer, who may well be an
    // owner with edit rights on all of it, does not enter into it.
    const resolve = fakeResolver();
    await resolveDeckThumbnailUrls(
      [
        slide({ id: 'public-deck', is_public: true }),
        slide({ id: 'private-deck', is_public: false }),
      ],
      { resolve }
    );

    expect(resolve.calls.map(call => call.tier).sort()).toEqual(['month', 'week']);
  });

  test('is the legacy proxy URL when the classroom gate is OFF', async () => {
    // Nothing to sign, and nothing broken: the index is a signed-in page, so
    // `/content/{org}/{repo}/…` is a URL this viewer can already fetch — and its
    // binary branch is CDN-first for exactly these classrooms.
    const resolve = fakeResolver();
    const urls = await resolveDeckThumbnailUrls(
      [slide({ classroom: { ...CLASSROOM_ON, content_delivery_enabled: false } })],
      { resolve }
    );

    expect(urls.get('deck-1')).toBe(`/content/${ORG}/${REPO}/slides/week-1/thumbnail.webp`);
    // Never reached the delivery layer at all.
    expect(resolve.calls).toHaveLength(0);
  });

  test('is the legacy proxy URL when the deployment cannot sign at all', async () => {
    delete process.env.CONTENT_SIGNING_SECRET;
    const resolve = fakeResolver();
    const urls = await resolveDeckThumbnailUrls([slide()], { resolve });

    expect(urls.get('deck-1')).toBe(`/content/${ORG}/${REPO}/slides/week-1/thumbnail.webp`);
    expect(resolve.calls).toHaveLength(0);
  });

  test('is null for a deck that has never been rendered', async () => {
    // The card draws a placeholder. Never a broken-image icon, and never a URL
    // for a file that is not in the repo — a failed render keeps whatever was
    // there and commits nothing, so "no path" means "no picture yet".
    const resolve = fakeResolver();
    const urls = await resolveDeckThumbnailUrls([slide({ thumbnail_path: null })], { resolve });

    expect(urls.get('deck-1')).toBeNull();
    expect(resolve.calls).toHaveLength(0);
  });

  test('is null for a deck whose classroom has no content repo', async () => {
    const resolve = fakeResolver();
    const urls = await resolveDeckThumbnailUrls(
      [slide({ classroom: { ...CLASSROOM_ON, content_repo: '' } })],
      { resolve }
    );

    expect(urls.get('deck-1')).toBeNull();
  });

  test('costs ONE delivery call per classroom and tier, not one per deck', async () => {
    // The whole point of the change: twenty decks used to be twenty live
    // iframes, each running its own delivery pass inside its own loader.
    const resolve = fakeResolver();
    const decks = [
      slide({ id: 'a' }),
      slide({ id: 'b' }),
      slide({ id: 'c' }),
      slide({
        id: 'd',
        classroom: { ...CLASSROOM_ON, id: OTHER_CLASSROOM },
      }),
    ];

    const urls = await resolveDeckThumbnailUrls(decks, { resolve });

    expect(resolve.calls).toHaveLength(2);
    expect(resolve.calls.find(call => call.classroomId === CLASSROOM)?.refs).toHaveLength(3);
    expect(urls.get('a')).toContain(CLASSROOM);
    expect(urls.get('d')).toContain(OTHER_CLASSROOM);
  });

  test('falls back to the proxy when the layer answers a /missing/ placeholder', async () => {
    // `/missing/` is the delivery layer's deliberate 404 for a reference the
    // asset map has never heard of — for a thumbnail that means the map has not
    // caught up with the commit, not that there is no file. Handing it to an
    // <img> is a broken-image icon on the card; the proxy can still serve the
    // bytes that ARE in the repo.
    const urls = await resolveDeckThumbnailUrls([slide()], {
      resolve: async (ctx, refs) =>
        new Map(
          refs.map(ref => [
            ref,
            `${ORIGIN}/c/${ctx.classroom.id}/missing/${encodeURIComponent(ref)}`,
          ])
        ),
    });

    expect(urls.get('deck-1')).toBe(`/content/${ORG}/${REPO}/slides/week-1/thumbnail.webp`);
  });

  test('falls back to the proxy for anything a browser could not fetch', async () => {
    // A bare repo path, an empty string, a relative fragment: each is a
    // broken-image icon in an <img src>, and this page draws twenty cards.
    for (const answer of ['', 'slides/week-1/thumbnail.webp', './thumbnail.webp']) {
      const urls = await resolveDeckThumbnailUrls([slide()], {
        resolve: async (_ctx, refs) => new Map(refs.map(ref => [ref, answer])),
      });
      expect(urls.get('deck-1')).toBe(`/content/${ORG}/${REPO}/slides/week-1/thumbnail.webp`);
    }
  });

  test('another classroom’s /missing/ shape is refused just the same', async () => {
    // The SHAPE is what makes it unfetchable, not whose it is.
    const urls = await resolveDeckThumbnailUrls([slide()], {
      resolve: async (_ctx, refs) =>
        new Map(refs.map(ref => [ref, `${ORIGIN}/c/${OTHER_CLASSROOM}/missing/${ref}`])),
    });

    expect(urls.get('deck-1')).toBe(`/content/${ORG}/${REPO}/slides/week-1/thumbnail.webp`);
  });

  test('keeps an ordinary absolute URL, which is the whole point', async () => {
    const urls = await resolveDeckThumbnailUrls([slide()], { resolve: fakeResolver() });
    expect(urls.get('deck-1')).toContain(`${ORIGIN}/c/${CLASSROOM}/blob/`);
  });

  test('degrades to the proxy URL when the delivery call throws', async () => {
    // The file is committed either way, and the proxy can still serve it — a
    // resolver hiccup must cost a slower image, not a missing one.
    const urls = await resolveDeckThumbnailUrls([slide()], {
      resolve: async () => {
        throw new Error('map unavailable');
      },
    });

    expect(urls.get('deck-1')).toBe(`/content/${ORG}/${REPO}/slides/week-1/thumbnail.webp`);
  });
});

test.describe('the render input for a classroom with the gate OFF', () => {
  test('rewrites this repo’s proxy references to the public CDN', () => {
    expect(publicContentUrl(`/content/${ORG}/${REPO}/slides/week-1/img/a.png`, ORG, REPO)).toBe(
      `https://${ORG}.github.io/${REPO}/slides/week-1/img/a.png`
    );
  });

  test('leaves everything that is not this repo exactly as it found it', () => {
    // The screenshot service must not be pointed anywhere new: an external
    // image, a data URI and another classroom's content all stay put.
    for (const ref of [
      'https://example.com/logo.png',
      'data:image/png;base64,AAAA',
      `/content/${ORG}/other-repo/x.png`,
      `/content/other-org/${REPO}/x.png`,
      'img/relative.png',
    ]) {
      expect(publicContentUrl(ref, ORG, REPO)).toBe(ref);
    }
    expect(publicContentUrl(null, ORG, REPO)).toBeNull();
  });

  test('rewrites a rendered document’s images', async () => {
    const html = [
      `<img src="/content/${ORG}/${REPO}/slides/week-1/img/a.png">`,
      '<img src="https://example.com/b.png">',
    ].join('');

    const out = await resolveDeckAssetsPublic(html, ORG, REPO);

    expect(out).toContain(`https://${ORG}.github.io/${REPO}/slides/week-1/img/a.png`);
    expect(out).toContain('https://example.com/b.png');
    expect(out).not.toContain(`/content/${ORG}/${REPO}/`);
  });

  test('moves the shared theme’s BASE and keeps the filenames it resolved', () => {
    // `getThemeUrls` decided which lib CSS exists and whether there is a
    // custom-theme.css against the authenticated API; re-deriving those here
    // would 404 a deck on offline-v1 and invent a custom theme for one with none.
    const moved = publicDeckThemeUrls(
      {
        libCssUrl: `/content/${ORG}/${REPO}/.slidesthemes/dartmouth/lib/offline-v1.css`,
        customThemeUrl: null,
        bodyClasses: 'theme-dartmouth',
      },
      ORG,
      REPO
    );

    expect(moved?.libCssUrl).toBe(
      `https://${ORG}.github.io/${REPO}/.slidesthemes/dartmouth/lib/offline-v1.css`
    );
    expect(moved?.customThemeUrl).toBeNull();
    expect(moved?.bodyClasses).toBe('theme-dartmouth');
  });
});

test.describe('the on-view enqueue', () => {
  test('is closed for a deck rendered inside the window', () => {
    const now = Date.now();
    expect(isWithinEnqueueWindow('deck-1', new Date(now - 60_000), now)).toBe(true);
    expect(isWithinEnqueueWindow('deck-1', new Date(now - ENQUEUE_WINDOW_MS - 1), now)).toBe(false);
    expect(isWithinEnqueueWindow('deck-1', null, now)).toBe(false);
  });

  test('asks at most once per deck per window', async () => {
    // The services-side enqueue never rejects (a Trigger.dev outage must not
    // surface anywhere), so the first ask reports `enqueued` whether or not a
    // run was actually created. What is pinned here is this module's own RATE
    // LIMIT, which has to hold either way: the second ask never reaches it.
    const deck = { id: 'deck-1', classroom_id: CLASSROOM, thumbnail_rendered_at: null };

    expect(await enqueueDeckThumbnail(deck)).toBe('enqueued');
    expect(await enqueueDeckThumbnail(deck)).toBe('rate-limited');
  });

  test('never asks for a deck the database says was just rendered', async () => {
    // This is the half that survives a deploy: a fresh process has an empty map,
    // and without the stored timestamp every index load after every deploy would
    // re-ask for exactly the decks whose renders keep failing.
    expect(
      await enqueueDeckThumbnail({
        id: 'deck-2',
        classroom_id: CLASSROOM,
        thumbnail_rendered_at: new Date(),
      })
    ).toBe('rate-limited');
  });
});

/**
 * The `intent: 'thumbnail'` action spends a render — a booted browser and a
 * commit into a classroom's content repo. It needs a session and a slide gate,
 * and every refusal has to look like every other refusal.
 *
 * The action needs Postgres, so these are read off the source. What is pinned is
 * the ORDER and the SHAPE: session before anything else, and one outcome string
 * for "no", so the endpoint is not an oracle for which slide ids exist.
 */
test.describe('the on-view enqueue endpoint', () => {
  const INDEX_SOURCE = readFileSync(
    fileURLToPath(new URL('../../app/routes/_index/route.tsx', import.meta.url)),
    'utf8'
  );

  const branch = INDEX_SOURCE.slice(
    INDEX_SOURCE.indexOf("if (intent === 'thumbnail')"),
    INDEX_SOURCE.indexOf("if (intent === 'rename')")
  );

  test('requires a session before it does anything else', () => {
    expect(branch).toContain(
      "if (!authData) return { intent: 'thumbnail', outcome: 'rate-limited' }"
    );
    // Before the slide lookup, and before the access check that would otherwise
    // be the first thing an anonymous caller reached.
    expect(branch.indexOf('!authData')).toBeLessThan(branch.indexOf('assertSlideAccess'));
    expect(branch.indexOf('!authData')).toBeLessThan(branch.indexOf('findUnique'));
  });

  test('answers anonymous, denied and rate-limited with the same outcome', () => {
    // Three different reasons, one visible answer. A distinguishable 401 or 403
    // would tell an unauthenticated caller which slide ids exist.
    const outcomes = [...branch.matchAll(/outcome: '([a-z-]+)'/g)].map(match => match[1]);
    expect(new Set(outcomes)).toEqual(new Set(['invalid', 'rate-limited']));
  });
});
