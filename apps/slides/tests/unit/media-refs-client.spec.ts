/**
 * The viewer's client-side fallback read never puts `media://` into the DOM.
 *
 * When a deck surface has no server-rendered content to hand the component, it
 * fetches the stored index.html itself (`contentUrl`). That document is
 * unresolved: its `media://` references have no URL and no browser loads the
 * scheme. The components blank them with the same pure pass the server's
 * failed reads use (`stripMediaRefs`, pinned in `deck-delivery.spec.ts`). The
 * editor keeps its references — its document goes back through a save.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';
import { canonicalMediaUrls, deliveryHostOf } from '../../app/utils/mediaRefs.ts';

const source = (relative: string) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

const SLIDES = source('../../app/components/RevealSlides.tsx');
const PRESENTER = source('../../app/components/RevealPresenter.tsx');
const MEDIA_REFS = source('../../app/utils/mediaRefs.ts');

/** The code between the fallback fetch and the parse of what it returned. */
const fallbackOf = (text: string) =>
  text.slice(text.indexOf('await fetch(contentUrl!)'), text.indexOf('} catch (err: unknown)'));

test.describe('the client-side contentUrl fallback', () => {
  test('the deck viewer blanks media refs outside the editor', () => {
    const fallback = fallbackOf(SLIDES);
    expect(fallback).toContain('parseContent(isEditing ? html : stripMediaRefs(html))');
  });

  test('the presenter and the /follow audience view blank them', () => {
    expect(fallbackOf(PRESENTER)).toContain('parseContent(stripMediaRefs(html))');
  });

  test('the helper is browser-safe: it imports nothing', () => {
    expect(MEDIA_REFS).not.toMatch(/^import /m);
  });
});

test.describe('the editor diff compares media by reference', () => {
  const HOST = 'content-staging.classmoji.io';
  const CLASSROOM = '11111111-2222-4333-8444-555555555555';
  const MEDIA_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const signed = (query: string, host = HOST, classroom = CLASSROOM) =>
    `https://${host}/c/${classroom}/media/${MEDIA_ID}/orig.mp4?${query}`;
  const scope = { host: HOST, classroomId: CLASSROOM };

  test('two signatures of the same object are the same reference', () => {
    const atRead = `<video src="${signed('e=1&amp;s=aaa')}"></video>`;
    const atSave = `<video src="${signed('e=2&amp;s=bbb')}"></video>`;
    expect(atRead).not.toBe(atSave);
    expect(canonicalMediaUrls(atRead, scope)).toBe(canonicalMediaUrls(atSave, scope));
    expect(canonicalMediaUrls(atRead, scope)).toBe(`<video src="media://${MEDIA_ID}"></video>`);
  });

  test('in any attribute, and in a background video', () => {
    const html = `<section data-background-video="${signed('e=1')}"><video><source src="${signed('e=1')}"></video></section>`;
    const out = canonicalMediaUrls(html, scope);
    expect(out.split(`media://${MEDIA_ID}`).length - 1).toBe(2);
    expect(out).not.toContain(HOST);
  });

  test('an inline-style url keeps its HTML-escaped closing quote', () => {
    for (const quote of ['&quot;', '&#34;', '&#39;']) {
      const html = `<div style="background: url(${quote}${signed('e=1&amp;s=x')}${quote})"></div>`;
      expect(canonicalMediaUrls(html, scope)).toBe(
        `<div style="background: url(${quote}media://${MEDIA_ID}${quote})"></div>`
      );
    }
  });

  test('another host, another classroom, or no host at all is left alone', () => {
    const foreign = `<video src="${signed('e=1', 'elsewhere.example')}"></video>`;
    const otherClass = `<video src="${signed('e=1', HOST, '99999999-2222-4333-8444-555555555555')}"></video>`;
    expect(canonicalMediaUrls(foreign, scope)).toBe(foreign);
    expect(canonicalMediaUrls(otherClass, scope)).toBe(otherClass);
    const ours = `<video src="${signed('e=1')}"></video>`;
    expect(canonicalMediaUrls(ours, { host: null, classroomId: CLASSROOM })).toBe(ours);
  });

  test('the host comes from the delivery origin', () => {
    expect(deliveryHostOf('https://Content.Classmoji.io')).toBe('content.classmoji.io');
    expect(deliveryHostOf('http://localhost:8787/')).toBe('localhost:8787');
    expect(deliveryHostOf(undefined)).toBeNull();
    expect(deliveryHostOf('not a url')).toBeNull();
  });
});

test.describe('the deck editor’s save round trip', () => {
  const VIEWER = source('../../app/routes/$slideId/route.tsx');

  test('both save shapes hand back the document with its media signed, sha from the raw one', () => {
    expect(
      VIEWER.match(/savedContent: await resolveDeckMedia\((result|saved)\.html, saveDeliveryCtx\)/g)
    ).toHaveLength(2);
    expect(VIEWER).not.toMatch(/savedContent: (result|saved)\.html,/);
    expect(VIEWER).toContain('html_sha: gitBlobSha(result.html)');
    expect(VIEWER).toContain('html_sha: gitBlobSha(saved.html)');
    // Signed at the edit tier, like the editor's own read.
    const ctx = VIEWER.slice(VIEWER.indexOf('const saveDeliveryCtx = deckDeliveryContext('));
    expect(ctx.slice(0, 200)).toContain("deckAccessFor('viewer', { canEdit: true }, slide)");
  });

  test('both sides of every diff compare media by reference', () => {
    const capture = VIEWER.slice(VIEWER.indexOf('const captureBaseline = useCallback('));
    expect(capture.slice(0, 600)).toContain(
      'extractDeckSnapshot(canonicalMediaUrls(content, mediaScope)'
    );
    const build = VIEWER.slice(VIEWER.indexOf('const buildSavePayload = useCallback('));
    expect(build.slice(0, 1500)).toContain(
      'const currSnapshot = extractDeckSnapshot(canonicalMediaUrls(content, mediaScope)'
    );
    // The scope is the delivery host (editors only) and this deck's classroom.
    expect(VIEWER).toContain(
      'mediaDeliveryHost: canEdit ? deliveryHostOf(process.env.CONTENT_DELIVERY_ORIGIN) : null'
    );
    expect(VIEWER).toContain('({ host: mediaDeliveryHost, classroomId: slide.classroom_id })');
  });
});
