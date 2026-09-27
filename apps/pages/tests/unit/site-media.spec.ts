/**
 * Media on the class site: a `media://` reference never reaches the HTML, and
 * a media video plays in a native `<video>` whatever its variant is called.
 *
 * The resolver turns every `media://{id}` it is asked about into a signed URL
 * (or the `/missing/` placeholder). These hold the two things around it:
 *
 *  - the paths where it is NOT asked (no resolve context, a resolve that
 *    threw, no delivery origin) still produce no `media://` in the markup —
 *    not as a `src`, not as a link, not as a cover;
 *  - the renderer decides "native player" by scheme, so a signed `orig.mov`
 *    or `orig.mkv` is not mistaken for a page to frame.
 */

import { test, expect } from '@playwright/test';

import { renderSitePage } from '~/site/render.server.ts';
import {
  coverWithoutUnresolvedMediaRef,
  withoutUnresolvedMediaRefs,
} from '~/site/siteMedia.server.ts';
import {
  isMediaPlaceholderUrl,
  isMediaRef,
  isMediaUrl,
  isRetryableDeliveryUrl,
  parseMediaRef,
  playsAsNativeVideo,
} from '~/utils/mediaRefs.ts';

const CLASSROOM = '11111111-2222-4333-8444-555555555555';
const MEDIA_ID = '0b6c1d3e-8f2a-4c5b-9d7e-1a2b3c4d5e6f';
const REF = `media://${MEDIA_ID}`;
const ORIGIN = 'https://content.classmoji.io';
const signed = (variant: string) =>
  `${ORIGIN}/c/${CLASSROOM}/media/${MEDIA_ID}/${variant}?p=month&v=0&exp=1&sig=abc`;
const PLACEHOLDER = `${ORIGIN}/c/${CLASSROOM}/missing/${encodeURIComponent(REF)}`;
/** The same path shapes on a host that is not the delivery origin. */
const foreign = (url: string, host = 'https://elsewhere.test') => url.replace(ORIGIN, host);

/**
 * Run with `CONTENT_DELIVERY_ORIGIN` set to `value` (deleted for null), and put
 * back whatever was there — the renderer reads it at call time.
 */
function withDeliveryOrigin(value: string | null): () => void {
  const previous = process.env.CONTENT_DELIVERY_ORIGIN;
  if (value === null) delete process.env.CONTENT_DELIVERY_ORIGIN;
  else process.env.CONTENT_DELIVERY_ORIGIN = value;
  return () => {
    if (previous === undefined) delete process.env.CONTENT_DELIVERY_ORIGIN;
    else process.env.CONTENT_DELIVERY_ORIGIN = previous;
  };
}

const resolveLink = () => null;

const video = (url: string, caption = '') => ({ type: 'video', props: { url, caption } });

test.describe('media references and URLs, by shape', () => {
  test('a media reference is exactly media:// and a v4-shaped uuid', () => {
    expect(parseMediaRef(REF)).toBe(MEDIA_ID);
    expect(isMediaRef(REF)).toBe(true);
    for (const other of [
      `${REF}/x`,
      `media://${MEDIA_ID.toUpperCase()}`,
      'media://not-a-uuid',
      `https://x.test/${REF}`,
      '',
      null,
    ]) {
      expect(isMediaRef(other), String(other)).toBe(false);
    }
  });

  test('signed media URLs and their placeholders are media URLs; repo blobs are not', () => {
    expect(isMediaUrl(signed('orig.mov'), ORIGIN)).toBe(true);
    expect(isMediaUrl(signed('web.mp4'), ORIGIN)).toBe(true);
    expect(isMediaUrl(PLACEHOLDER, ORIGIN)).toBe(true);
    expect(isMediaPlaceholderUrl(PLACEHOLDER, ORIGIN)).toBe(true);
    expect(isMediaPlaceholderUrl(signed('web.mp4'), ORIGIN)).toBe(false);
    expect(isMediaUrl(`${ORIGIN}/c/${CLASSROOM}/blob/abc.png?sig=x`, ORIGIN)).toBe(false);
    expect(isMediaUrl('https://youtu.be/abc', ORIGIN)).toBe(false);
  });

  test('a media-shaped URL is a media URL only on the delivery origin', () => {
    // `orig.avi` carries no extension the fallback knows, so only the host
    // decides whether it is ours.
    const ours = signed('orig.avi');
    expect(isMediaUrl(ours, ORIGIN)).toBe(true);
    expect(playsAsNativeVideo(ours, ORIGIN)).toBe(true);

    // Our host, spelled differently: case and a trailing slash on the origin.
    expect(isMediaUrl(foreign(ours, 'https://CONTENT.classmoji.io'), ORIGIN)).toBe(true);
    expect(isMediaUrl(ours, `${ORIGIN}/`)).toBe(true);

    // Somebody else's host serving the same path is an ordinary link.
    for (const host of [
      'https://elsewhere.test',
      'http://elsewhere.test',
      'https://content.classmoji.io.elsewhere.test',
      'https://content.classmoji.io:8443',
    ]) {
      const url = foreign(ours, host);
      expect(isMediaUrl(url, ORIGIN), url).toBe(false);
      expect(playsAsNativeVideo(url, ORIGIN), url).toBe(false);
      expect(isMediaPlaceholderUrl(foreign(PLACEHOLDER, host), ORIGIN), host).toBe(false);
      expect(isMediaUrl(foreign(PLACEHOLDER, host), ORIGIN), host).toBe(false);
    }
    // A foreign URL that happens to end in a video extension still plays by
    // that extension, like any pasted direct link.
    expect(playsAsNativeVideo(foreign(signed('web.mp4')), ORIGIN)).toBe(true);

    // No delivery origin: this deployment mints no URLs, so none is ours. A
    // `media://` reference is still one by its scheme.
    for (const none of [null, undefined, '']) {
      expect(isMediaUrl(ours, none), String(none)).toBe(false);
      expect(isMediaPlaceholderUrl(PLACEHOLDER, none), String(none)).toBe(false);
      expect(playsAsNativeVideo(ours, none), String(none)).toBe(false);
      expect(playsAsNativeVideo(REF, none), String(none)).toBe(true);
    }
    expect(isMediaUrl(ours, 'not a url')).toBe(false);
  });

  test('native playback is decided by scheme, then by extension', () => {
    for (const url of [
      REF,
      signed('orig.mov'),
      signed('orig.mkv'),
      signed('web.mp4'),
      'https://cdn.test/lecture.mp4',
      'https://cdn.test/lecture.MOV?x=1',
      'https://cdn.test/lecture.m4v',
      'https://cdn.test/lecture.mkv',
      'https://cdn.test/lecture.webm',
    ]) {
      expect(playsAsNativeVideo(url, ORIGIN), url).toBe(true);
    }
    for (const url of [
      'https://youtu.be/abc',
      'https://vimeo.com/123',
      'https://cdn.test/page',
      '',
    ]) {
      expect(playsAsNativeVideo(url, ORIGIN), url).toBe(false);
    }
  });

  test('an expired media signature is retried like a blob; a placeholder never is', () => {
    expect(isRetryableDeliveryUrl(signed('orig.mp4'))).toBe(true);
    expect(isRetryableDeliveryUrl(`${ORIGIN}/c/${CLASSROOM}/blob/abc.png?sig=x`)).toBe(true);
    expect(isRetryableDeliveryUrl(`${ORIGIN}/c/${CLASSROOM}/theme/abc.css?sig=x`)).toBe(true);
    expect(isRetryableDeliveryUrl(PLACEHOLDER)).toBe(false);
    expect(isRetryableDeliveryUrl('https://cdn.test/x.png')).toBe(false);
    expect(isRetryableDeliveryUrl(null)).toBe(false);
  });
});

test.describe('the class site plays media videos natively', () => {
  let restore: () => void = () => {};
  test.beforeAll(() => {
    restore = withDeliveryOrigin(ORIGIN);
  });
  test.afterAll(() => restore());

  for (const variant of ['orig.mp4', 'orig.mov', 'orig.mkv', 'orig.avi', 'web.mp4']) {
    test(`a signed ${variant} renders a <video>, not a frame`, async () => {
      const { html } = await renderSitePage({ blocks: [video(signed(variant))], resolveLink });
      expect(html).toContain('<video');
      expect(html).not.toContain('<iframe');
      expect(html).toContain(`/media/${MEDIA_ID}/${variant}`);
    });
  }

  test('the placeholder for a media video it could not sign renders nothing', async () => {
    const { html } = await renderSitePage({ blocks: [video(PLACEHOLDER)], resolveLink });
    expect(html).not.toContain('<video');
    expect(html).not.toContain('<iframe');
    // No player and no link to click — the block's own `data-url` attribute
    // still carries the placeholder, as it does for any unsignable reference.
    expect(html).not.toContain('<a ');
  });

  test('a media-shaped URL on another host is framed like any https page', async () => {
    const url = foreign(signed('orig.avi'));
    const { html } = await renderSitePage({ blocks: [video(url)], resolveLink });
    expect(html).not.toContain('<video');
    expect(html).toContain('<iframe');
  });

  test('a media-shaped http:// URL on another host is only a link', async () => {
    const url = foreign(signed('web.mp4'), 'http://elsewhere.test');
    const { html } = await renderSitePage({ blocks: [video(url)], resolveLink });
    expect(html).not.toContain('<video');
    expect(html).not.toContain('<iframe');
    expect(html).toContain('<a ');
  });

  test('a placeholder-shaped URL on another host is not swallowed as ours', async () => {
    const url = foreign(PLACEHOLDER);
    const { html } = await renderSitePage({ blocks: [video(url)], resolveLink });
    expect(html).toContain('<iframe');
  });

  test('with no delivery origin configured, no URL is a media URL', async () => {
    const unset = withDeliveryOrigin(null);
    try {
      const { html } = await renderSitePage({
        blocks: [video(signed('orig.avi'))],
        resolveLink,
      });
      expect(html).not.toContain('<video');
      expect(html).toContain('<iframe');
    } finally {
      unset();
    }
  });

  test('a pasted direct .mov link plays natively too', async () => {
    const { html } = await renderSitePage({
      blocks: [video('https://cdn.test/lecture.mov')],
      resolveLink,
    });
    expect(html).toContain('<video');
    expect(html).not.toContain('<iframe');
  });
});

test.describe('an unresolved media reference never reaches the HTML', () => {
  // Every block that can hold a reference, holding a raw `media://`: what the
  // site renders when the classroom has no resolve context, the resolve threw,
  // or the deployment has no delivery origin.
  const RAW = [
    video(REF, 'Lecture 1'),
    { type: 'image', props: { url: REF, caption: 'diagram' } },
    { type: 'file', props: { url: REF, name: 'notes.pdf' } },
    {
      type: 'columnList',
      children: [
        { type: 'column', props: { width: 1 }, children: [video(REF)] },
        { type: 'column', props: { width: 1 }, children: [{ type: 'file', props: { url: REF } }] },
      ],
    },
  ];

  test('the guard empties every media reference, nested ones included', () => {
    const guarded = withoutUnresolvedMediaRefs(RAW);
    expect(JSON.stringify(guarded)).not.toContain('media://');
    // A clone: the cached document is never written to.
    expect(JSON.stringify(RAW)).toContain('media://');
  });

  test('the guard leaves resolved and ordinary references alone', () => {
    const blocks = [
      video(signed('orig.mp4')),
      { type: 'image', props: { url: 'pages/a/assets/x.png' } },
      video('https://youtu.be/abc'),
    ];
    expect(withoutUnresolvedMediaRefs(blocks)).toEqual(blocks);
  });

  test('a guarded document renders with no media:// anywhere, and no link to one', async () => {
    const { html } = await renderSitePage({
      blocks: withoutUnresolvedMediaRefs(RAW) as unknown[],
      resolveLink,
    });
    expect(html).not.toContain('media://');
    expect(html).not.toContain('media:');
    expect(html).not.toContain('<video');
    expect(html).not.toContain('<iframe');
  });

  test('without the guard the raw reference would have leaked — the guard is load-bearing', async () => {
    const { html } = await renderSitePage({ blocks: [RAW[1]], resolveLink });
    expect(html).toContain('media://');
  });

  test('a cover still on media:// is dropped; a resolved one is kept', () => {
    expect(coverWithoutUnresolvedMediaRef({ url: REF, position: 40 })).toBeNull();
    const resolved = { url: signed('orig.png'), position: 40 };
    expect(coverWithoutUnresolvedMediaRef(resolved)).toBe(resolved);
    expect(coverWithoutUnresolvedMediaRef(null)).toBeNull();
  });
});
