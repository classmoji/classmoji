/**
 * The frame half of the deck read pass (`deckDelivery.server`): which reads
 * sign frames, how they compose with the image pass and the markup cleanup,
 * and what happens when signing cannot.
 *
 * Runs in the Playwright runner without a browser or the dev stack; the
 * asset-map calls are injected (`opts.resolvers`), as in deck-delivery.spec.
 */

import { test, expect } from '@playwright/test';
import {
  appFrameHosts,
  deckDeliveryContext,
  resolveDeckAssetsPublic,
  resolveDeckDelivery,
  type DeckDeliveryResolvers,
} from '../../app/utils/deckDelivery.server.ts';

const ORG = 'cs98-org';
const REPO = 'cs98-content';
const CLASSROOM = '11111111-2222-3333-4444-555555555555';
const ORIGIN = 'https://content-staging.classmoji.io';
const SLIDE_ID = '9b2f1c4e-0000-4000-8000-000000000001';
const DECK = 'slides/week-1';
const BOX =
  'allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals ' +
  'allow-pointer-lock allow-downloads';

const DELIVERABLE_ORG = {
  login: ORG,
  provider: 'GITHUB',
  github_installation_id: '42',
  gitlab_connection_id: null,
};

const SLIDE = {
  id: SLIDE_ID,
  content_path: `/${DECK}/`,
  is_public: false,
  classroom: {
    id: CLASSROOM,
    content_key_version: 3,
    content_repo: REPO,
    content_delivery_enabled: true,
    git_organization: DELIVERABLE_ORG,
  },
};

/** Gated on, but no App installation: nothing in its map to sign frames from. */
const UNSERVABLE_SLIDE = {
  ...SLIDE,
  classroom: {
    ...SLIDE.classroom,
    git_organization: { ...DELIVERABLE_ORG, github_installation_id: null },
  },
};

const ENV_KEYS = [
  'CONTENT_SIGNING_SECRET',
  'CONTENT_DELIVERY_ORIGIN',
  'SLIDES_URL',
  'WEBAPP_URL',
  'COOKIE_DOMAIN',
  'SITE_BASE_DOMAIN',
] as const;
let savedEnv: Record<string, string | undefined> = {};

test.beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
  process.env.CONTENT_SIGNING_SECRET = 'test-master-secret';
  process.env.CONTENT_DELIVERY_ORIGIN = ORIGIN;
  process.env.SLIDES_URL = 'https://slides.classmoji.io';
  process.env.WEBAPP_URL = 'https://classmoji.io';
  process.env.COOKIE_DOMAIN = 'classmoji.io';
  delete process.env.SITE_BASE_DOMAIN;
});

test.afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

const FILES = `${ORIGIN}/c/${CLASSROOM}/files/GRANT/week.3.1.sig/`;

/** Records what each resolver was asked; signs images and frames recognisably. */
function fakeResolvers(overrides: Partial<DeckDeliveryResolvers> = {}) {
  const asked = {
    delivery: [] as string[],
    frames: [] as string[],
    frameSignerFor: [] as unknown[],
  };
  const resolvers: DeckDeliveryResolvers = {
    async resolveDelivery(_ctx, refs) {
      asked.delivery.push(...refs);
      const own = `/content/${ORG}/${REPO}/`;
      const urls = new Map(
        refs.map(ref => [
          ref,
          ref.startsWith(own)
            ? `${ORIGIN}/c/${CLASSROOM}/blob/x?ref=${ref.slice(own.length)}`
            : ref,
        ])
      );
      return { urls, srcSets: new Map() };
    },
    async resolveThemeBase() {
      return null;
    },
    frameSigner(_ctx, frames) {
      asked.frameSignerFor.push(frames);
      return {
        async sign(repoPath, query) {
          asked.frames.push(`${repoPath}${query}`);
          return repoPath.includes('missing') ? null : `${FILES}${repoPath}${query}`;
        },
      };
    },
    ...overrides,
  };
  return { resolvers, asked };
}

const doc = (slides: string) =>
  `<!DOCTYPE html><html><head><title>d</title></head><body><div class="reveal"><div class="slides">${slides}</div></div></body></html>`;

const HTML_BLOCK =
  '<div class="sl-block" data-block-type="html"><div class="sl-block-content">' +
  `<iframe sandbox="${BOX}" allow="fullscreen" data-cm-src="blocks/ab12cd34.html" data-cm-rev="r1"></iframe>` +
  '</div></div>';

test.describe('the frame context', () => {
  test('a deck read of a classroom the layer serves carries its folder, id and visibility', () => {
    const ctx = deckDeliveryContext(SLIDE, ORG, REPO, { canEdit: true, isPublic: true });
    expect(ctx?.tier).toBe('edit');
    // Frames ignore the edit tier: the visibility is what they are signed by.
    expect(ctx?.frames).toEqual({ deckFolder: DECK, slideId: SLIDE_ID, isPublic: true });
  });

  test('no frame pass where the layer cannot serve the classroom, or without a deck', () => {
    expect(deckDeliveryContext(UNSERVABLE_SLIDE, ORG, REPO, { canEdit: false })?.frames).toBeNull();
    const { content_path: _ignored, ...noFolder } = SLIDE;
    expect(deckDeliveryContext(noFolder, ORG, REPO, { canEdit: false })?.frames).toBeNull();
  });

  test("the app's hosts: configured origins plus the cookie domain", () => {
    expect(appFrameHosts()).toEqual(
      expect.arrayContaining(['slides.classmoji.io', 'classmoji.io', '.classmoji.io'])
    );
  });
});

test.describe('signing frames on a read', () => {
  test('html blocks, repo frames and backgrounds go to the frame signer, images to the blob resolver', async () => {
    const { resolvers, asked } = fakeResolvers();
    const ctx = deckDeliveryContext(SLIDE, ORG, REPO, { canEdit: false });
    const { html } = await resolveDeckDelivery(
      doc(
        `<section data-background-iframe="games/bg/index.html">${HTML_BLOCK}` +
          `<iframe src="/content/${ORG}/${REPO}/games/snake/index.html?l=2"></iframe>` +
          `<img src="/content/${ORG}/${REPO}/${DECK}/assets/a.png"></section>`
      ),
      ctx,
      { resolvers, themeName: null }
    );
    expect(html).toContain(`data-src="${FILES}${DECK}/blocks/ab12cd34.html"`);
    expect(html).toContain(`src="${FILES}games/snake/index.html?l=2"`);
    expect(html).toContain(`data-background-iframe="${FILES}${DECK}/games/bg/index.html"`);
    expect(html).toContain(`src="${ORIGIN}/c/${CLASSROOM}/blob/x?ref=${DECK}/assets/a.png"`);
    // The image pass never saw the frame.
    expect(asked.delivery).not.toContain(`/content/${ORG}/${REPO}/games/snake/index.html?l=2`);
    expect(asked.frames.sort()).toEqual(
      [
        `${DECK}/blocks/ab12cd34.html`,
        `${DECK}/games/bg/index.html`,
        'games/snake/index.html?l=2',
      ].sort()
    );
    expect(asked.frameSignerFor).toEqual([
      { deckFolder: DECK, slideId: SLIDE_ID, isPublic: false },
    ]);
  });

  test('external frames are left as written; app pages and script URLs go inert', async () => {
    const { resolvers } = fakeResolvers();
    const ctx = deckDeliveryContext(SLIDE, ORG, REPO, { canEdit: false });
    const { html } = await resolveDeckDelivery(
      doc(
        '<section><iframe src="https://www.youtube.com/embed/x" sandbox="allow-scripts allow-same-origin"></iframe>' +
          '<iframe src="https://slides.classmoji.io/other-deck"></iframe>' +
          '<iframe src="https://classmoji.io/settings"></iframe>' +
          '<iframe data-cm-src="blocks/missing.html"></iframe></section>'
      ),
      ctx,
      { resolvers, themeName: null }
    );
    expect(html).toContain(
      '<iframe src="https://www.youtube.com/embed/x" sandbox="allow-scripts allow-same-origin"></iframe>'
    );
    expect(html).toContain('data-cm-inert-src="https://slides.classmoji.io/other-deck"');
    expect(html).toContain('data-cm-inert-src="https://classmoji.io/settings"');
    expect(html).toContain('data-cm-inert-data-cm-src="blocks/missing.html"');
    expect(html?.match(/data-cm-missing="1"/g)).toHaveLength(3);
  });

  test('a classroom the layer cannot serve keeps its frames exactly as before', async () => {
    const { resolvers, asked } = fakeResolvers();
    const ctx = deckDeliveryContext(UNSERVABLE_SLIDE, ORG, REPO, { canEdit: false });
    const frame = `/content/${ORG}/${REPO}/games/snake/index.html`;
    await resolveDeckDelivery(doc(`<section><iframe src="${frame}"></iframe></section>`), ctx, {
      resolvers,
      themeName: null,
    });
    expect(asked.delivery).toContain(frame);
    expect(asked.frames).toEqual([]);
  });

  test('when the image pass fails, stored images stay and no frame of ours loads', async () => {
    const { resolvers, asked } = fakeResolvers({
      async resolveDelivery() {
        throw new Error('map down');
      },
    });
    const ctx = deckDeliveryContext(SLIDE, ORG, REPO, { canEdit: false });
    const { html } = await resolveDeckDelivery(
      doc(
        `<section><img src="/content/${ORG}/${REPO}/a.png">` +
          `<iframe src="/content/${ORG}/${REPO}/games/snake/index.html"></iframe>` +
          '<iframe src="https://www.youtube.com/embed/x"></iframe></section>'
      ),
      ctx,
      { resolvers, themeName: null }
    );
    expect(html).toContain(`<img src="/content/${ORG}/${REPO}/a.png">`);
    expect(html).toContain(`data-cm-inert-src="/content/${ORG}/${REPO}/games/snake/index.html"`);
    expect(html).toContain('<iframe src="https://www.youtube.com/embed/x"></iframe>');
    expect(asked.frames).toEqual([]);
  });
});

test.describe('slide markup is cleaned on every read', () => {
  const DIRTY = doc(
    '<section><img src="a.png" onerror="alert(1)"><script>alert(2)</script>' +
      '<a href="javascript:alert(3)">x</a></section>'
  );
  const expectClean = (html: string | null) => {
    expect(html).not.toContain('onerror');
    expect(html).not.toContain('alert(2)');
    expect(html).not.toContain('javascript:');
  };

  test('with a delivery context', async () => {
    const { resolvers } = fakeResolvers();
    const ctx = deckDeliveryContext(SLIDE, ORG, REPO, { canEdit: false });
    expectClean((await resolveDeckDelivery(DIRTY, ctx, { resolvers, themeName: null })).html);
  });

  test('without one', async () => {
    expectClean((await resolveDeckDelivery(DIRTY, null)).html);
    expectClean((await resolveDeckDelivery(DIRTY, null, { classroomId: CLASSROOM })).html);
  });

  test('on the public (render) read', async () => {
    expectClean(await resolveDeckAssetsPublic(DIRTY, ORG, REPO, CLASSROOM));
  });

  test("the generator's own scripts in the head are left alone", async () => {
    const html = doc('<section><p>x</p></section>').replace(
      '</head>',
      '<script src="/reveal.js"></script></head>'
    );
    const out = (await resolveDeckDelivery(html, null)).html;
    expect(out).toContain('<script src="/reveal.js"></script>');
  });
});
