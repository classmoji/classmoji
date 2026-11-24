/**
 * Media references and URLs by shape (`utils/mediaRefs.ts`, what the reader's
 * blocks decide with), and the class site's cover: a `media://` cover nobody
 * signed never reaches the site's markup.
 *
 * The reader payload empties the document's own unresolved references
 * (reader-payload.spec.ts); the class site's static renderer, which had its
 * own guard and its own native-video rule, is gone.
 */

import { test, expect } from '@playwright/test';

import { coverWithoutUnresolvedMediaRef } from '~/site/siteMedia.server.ts';
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
/** The same path shapes on a host that is not the delivery origin. */
const foreign = (url: string, host = 'https://elsewhere.test') => url.replace(ORIGIN, host);

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
    expect(isMediaUrl(signed('web-0123456789ab.mp4'), ORIGIN)).toBe(true);
    expect(isMediaUrl(PLACEHOLDER, ORIGIN)).toBe(true);
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
      expect(isMediaUrl(foreign(PLACEHOLDER, host), ORIGIN), host).toBe(false);
    }
    // A foreign URL that happens to end in a video extension still plays by
    // that extension, like any pasted direct link.
    expect(playsAsNativeVideo(foreign(signed('web-0123456789ab.mp4')), ORIGIN)).toBe(true);

    // No delivery origin: this deployment mints no URLs, so none is ours. A
    // `media://` reference is still one by its scheme.
    for (const none of [null, undefined, '']) {
      expect(isMediaUrl(ours, none), String(none)).toBe(false);
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
      signed('web-0123456789ab.mp4'),
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

test.describe('an unresolved media cover never reaches the site', () => {
  // The document's own references are emptied by the reader payload
  // (reader-payload.spec.ts); the cover is drawn by the site's chrome.
  test('a cover still on media:// is dropped; a resolved one is kept', () => {
    expect(coverWithoutUnresolvedMediaRef({ url: REF, position: 40 })).toBeNull();
    const resolved = { url: signed('orig.png'), position: 40 };
    expect(coverWithoutUnresolvedMediaRef(resolved)).toBe(resolved);
    expect(coverWithoutUnresolvedMediaRef(null)).toBeNull();
  });
});
