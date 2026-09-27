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
    expect(isMediaUrl(signed('orig.mov'))).toBe(true);
    expect(isMediaUrl(signed('web.mp4'))).toBe(true);
    expect(isMediaUrl(PLACEHOLDER)).toBe(true);
    expect(isMediaUrl(`${ORIGIN}/c/${CLASSROOM}/blob/abc.png?sig=x`)).toBe(false);
    expect(isMediaUrl('https://youtu.be/abc')).toBe(false);
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
      expect(playsAsNativeVideo(url), url).toBe(true);
    }
    for (const url of [
      'https://youtu.be/abc',
      'https://vimeo.com/123',
      'https://cdn.test/page',
      '',
    ]) {
      expect(playsAsNativeVideo(url), url).toBe(false);
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
  for (const variant of ['orig.mp4', 'orig.mov', 'orig.mkv', 'web.mp4']) {
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
