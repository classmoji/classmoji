/**
 * Page blocks rendered read-only by the client viewer: what may be framed, and
 * which editing controls a reader never gets.
 *
 * The decisions live in two JSX-free modules — `safeFrame.ts` (the embed block
 * and the video block's iframe branch, editor and reader alike) and
 * `readOnlyGates.ts` (callout, terminal, embed/video/pageLink empty states,
 * empty or unshowable media) — because Playwright's test transform rewrites JSX
 * in app files, so the block renders themselves cannot be mounted here. The
 * blocks call exactly these functions.
 */

import { test, expect } from '@playwright/test';
// @ts-expect-error -- jsdom ships no type declarations; only the constructor is used.
import { JSDOM } from 'jsdom';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  FRAME_ALLOW,
  FRAME_REFERRER_POLICY,
  FRAME_SANDBOX,
  decideFrame,
  isHttpsUrl,
  safeLinkHref,
  toEmbedUrl,
  type FrameDecision,
} from '~/components/editor/blocks/safeFrame.ts';
import { SafeFrame } from '~/components/editor/blocks/frameElement.ts';
import {
  CALLOUT_EMOJIS,
  fieldBlockView,
  nextCalloutEmoji,
  pageLinkMayFetch,
  readerCanShowMedia,
  terminalView,
} from '~/components/editor/blocks/readOnlyGates.ts';
import { hasMediaPlaceholderShape, hasMediaScheme, hasMediaUrlShape } from '~/utils/mediaRefs.ts';

const CLASSROOM = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const MEDIA_ID = '11111111-1111-4111-8111-111111111111';
const MEDIA_REF = `media://${MEDIA_ID}`;
const DELIVERY = 'https://content.classmoji.io';
const SIGNED_MEDIA = `${DELIVERY}/c/${CLASSROOM}/media/${MEDIA_ID}/web-0123456789ab?sig=x`;
const SIGNED_BLOB = `${DELIVERY}/c/${CLASSROOM}/blob/abc123/handout.pdf?sig=x`;
const PLACEHOLDER = `${DELIVERY}/c/${CLASSROOM}/missing/media%3A%2F%2F${MEDIA_ID}`;
const YT_ID = 'dQw4w9WgXcQ';

test.describe('the frame attributes', () => {
  test('the sandbox is exactly the decided one', () => {
    expect(FRAME_SANDBOX).toBe(
      'allow-scripts allow-same-origin allow-presentation allow-forms allow-popups ' +
        'allow-popups-to-escape-sandbox allow-modals allow-downloads'
    );
  });

  test('no token lets the frame navigate the whole tab', () => {
    for (const token of FRAME_SANDBOX.split(/\s+/)) {
      expect(token.startsWith('allow-top-navigation'), token).toBe(false);
    }
    expect(FRAME_SANDBOX).not.toContain('top-navigation');
  });

  test('the referrer is the origin only, and never absent (YouTube refuses no-referrer)', () => {
    expect(FRAME_REFERRER_POLICY).toBe('strict-origin-when-cross-origin');
  });

  test("the app's feature list is kept", () => {
    expect(FRAME_ALLOW).toBe(
      'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture'
    );
  });
});

test.describe('what is framed', () => {
  test('an https page is framed as is, sandboxed', () => {
    expect(
      decideFrame('https://codesandbox.io/embed/abc', 'https://codesandbox.io/embed/abc')
    ).toEqual({ kind: 'frame', src: 'https://codesandbox.io/embed/abc', sandboxed: true });
  });

  test('a protocol-relative URL is read as https', () => {
    expect(decideFrame('//codesandbox.io/embed/abc', '//codesandbox.io/embed/abc')).toEqual({
      kind: 'frame',
      src: 'https://codesandbox.io/embed/abc',
      sandboxed: true,
    });
    expect(decideFrame(`//youtu.be/${YT_ID}`, `//youtu.be/${YT_ID}`)).toEqual({
      kind: 'frame',
      src: `https://www.youtube.com/embed/${YT_ID}`,
      sandboxed: true,
    });
    // Not a valid URL even with the scheme: text, no href.
    expect(decideFrame('//', '//')).toEqual({ kind: 'link', text: '//', href: null });
  });

  test('http is a link, never a frame', () => {
    const url = 'http://example.com/page';
    expect(decideFrame(url, url)).toEqual({ kind: 'link', text: url, href: url });
  });

  test('javascript: is text with no href at all', () => {
    for (const url of ['javascript:alert(1)', 'JavaScript:alert(1)', ' javascript:alert(1)']) {
      expect(decideFrame(url, url), url).toEqual({ kind: 'link', text: url, href: null });
    }
  });

  test('data:, malformed and relative URLs are text with no href', () => {
    for (const url of [
      'data:text/html,<b>x</b>',
      'not a url',
      'https//missing-colon',
      'pages/a.pdf',
    ]) {
      expect(decideFrame(url, url), url).toEqual({ kind: 'link', text: url, href: null });
    }
  });

  test('an empty URL decides nothing', () => {
    expect(decideFrame('', '')).toEqual({ kind: 'none' });
  });

  test("the page's own origin is never framed: a link instead", () => {
    const own = 'https://pages.classmoji.io/demo/other-page';
    expect(decideFrame(own, own, 'https://pages.classmoji.io')).toEqual({
      kind: 'link',
      text: own,
      href: own,
    });
    // Another origin, or no browser to ask: framed.
    expect(decideFrame(own, own, 'https://classmoji.io').kind).toBe('frame');
    expect(decideFrame(own, own, null).kind).toBe('frame');
    // A PDF on the own origin is not framed either.
    const ownPdf = 'https://pages.classmoji.io/a.pdf';
    expect(decideFrame(ownPdf, ownPdf, 'https://pages.classmoji.io').kind).toBe('link');
  });

  test('our media is never framed: a media reference, resolved or not', () => {
    expect(decideFrame(MEDIA_REF, MEDIA_REF)).toEqual({ kind: 'none' });
    expect(decideFrame(MEDIA_REF, SIGNED_MEDIA)).toEqual({ kind: 'none' });
    expect(decideFrame('media://not-a-uuid', 'media://not-a-uuid')).toEqual({ kind: 'none' });
  });

  test('our media is never framed: a signed media URL or its placeholder', () => {
    expect(decideFrame(SIGNED_MEDIA, SIGNED_MEDIA)).toEqual({ kind: 'none' });
    expect(decideFrame(MEDIA_REF, PLACEHOLDER)).toEqual({ kind: 'none' });
    expect(decideFrame(PLACEHOLDER, PLACEHOLDER)).toEqual({ kind: 'none' });
  });

  test('the media check is by path shape: the browser is never told the delivery origin', () => {
    // Refusing a foreign host serving the same path is the safe direction.
    const foreign = SIGNED_MEDIA.replace(DELIVERY, 'https://elsewhere.test');
    expect(decideFrame(foreign, foreign)).toEqual({ kind: 'none' });
    expect(hasMediaUrlShape(foreign)).toBe(true);
    expect(hasMediaUrlShape(SIGNED_BLOB)).toBe(false);
    expect(hasMediaPlaceholderShape(PLACEHOLDER)).toBe(true);
    expect(hasMediaPlaceholderShape(SIGNED_MEDIA)).toBe(false);
    expect(hasMediaScheme('MEDIA://x')).toBe(true);
    expect(hasMediaScheme('https://x/media://y')).toBe(false);
  });
});

test.describe('PDFs are framed without a sandbox (Chrome blocks its PDF viewer in any sandbox)', () => {
  test('an https URL whose path ends .pdf, any case', () => {
    for (const url of [
      'https://example.com/syllabus.pdf',
      'https://example.com/syllabus.PDF',
      'https://example.com/syllabus.pdf?download=0#page=2',
    ]) {
      expect(decideFrame(url, url), url).toEqual({ kind: 'frame', src: url, sandboxed: false });
    }
  });

  test('a repo reference ending .pdf that resolved to https, whatever the signed URL ends in', () => {
    expect(decideFrame('pages/lab/handout.pdf', SIGNED_BLOB)).toEqual({
      kind: 'frame',
      src: SIGNED_BLOB,
      sandboxed: false,
    });
    const opaque = `${DELIVERY}/c/${CLASSROOM}/blob/abc123?sig=x`;
    expect(decideFrame('pages/lab/Handout.PDF', opaque)).toEqual({
      kind: 'frame',
      src: opaque,
      sandboxed: false,
    });
  });

  test('decided on the path, not anywhere in the URL', () => {
    for (const url of [
      'https://example.com/viewer?file=a.pdf',
      'https://example.com/a.pdf/view',
      'https://example.pdf/page',
    ]) {
      expect(decideFrame(url, url), url).toEqual({ kind: 'frame', src: url, sandboxed: true });
    }
    // A repo reference that is not a PDF keeps the sandbox.
    expect(decideFrame('pages/lab/demo.html', SIGNED_BLOB.replace('handout.pdf', 'demo'))).toEqual({
      kind: 'frame',
      src: SIGNED_BLOB.replace('handout.pdf', 'demo'),
      sandboxed: true,
    });
  });

  test('an http PDF is still only a link', () => {
    const url = 'http://example.com/a.pdf';
    expect(decideFrame(url, url)).toEqual({ kind: 'link', text: url, href: url });
  });
});

test.describe('provider URLs', () => {
  const PLAYER = `https://www.youtube.com/embed/${YT_ID}`;

  test('YouTube page URLs become the player URL, on every YouTube host and path', () => {
    for (const url of [
      `https://www.youtube.com/watch?v=${YT_ID}`,
      `https://youtube.com/watch?v=${YT_ID}`,
      `https://m.youtube.com/watch?v=${YT_ID}`,
      `https://www.youtube.com/watch?feature=share&v=${YT_ID}`,
      `https://youtu.be/${YT_ID}`,
      `http://youtu.be/${YT_ID}`,
      `https://www.youtube.com/shorts/${YT_ID}`,
      `https://www.youtube.com/live/${YT_ID}`,
      `https://www.youtube.com/embed/${YT_ID}`,
      `http://youtube.com/embed/${YT_ID}`,
    ]) {
      expect(toEmbedUrl(url), url).toBe(PLAYER);
      expect(decideFrame(url, url), url).toEqual({ kind: 'frame', src: PLAYER, sandboxed: true });
    }
  });

  test('youtube-nocookie stays on its host', () => {
    expect(toEmbedUrl(`https://www.youtube-nocookie.com/embed/${YT_ID}`)).toBe(
      `https://www.youtube-nocookie.com/embed/${YT_ID}`
    );
    expect(toEmbedUrl(`https://youtube-nocookie.com/embed/${YT_ID}?t=5`)).toBe(
      `https://www.youtube-nocookie.com/embed/${YT_ID}?start=5`
    );
  });

  test('t= and start= become start= in seconds; list= is kept', () => {
    expect(toEmbedUrl(`https://youtu.be/${YT_ID}?t=90`)).toBe(`${PLAYER}?start=90`);
    expect(toEmbedUrl(`https://www.youtube.com/watch?v=${YT_ID}&t=30s`)).toBe(`${PLAYER}?start=30`);
    expect(toEmbedUrl(`https://www.youtube.com/watch?v=${YT_ID}&t=1m30s`)).toBe(
      `${PLAYER}?start=90`
    );
    expect(toEmbedUrl(`https://www.youtube.com/watch?v=${YT_ID}&start=12`)).toBe(
      `${PLAYER}?start=12`
    );
    expect(toEmbedUrl(`https://www.youtube.com/watch?v=${YT_ID}&t=soon`)).toBe(PLAYER);
    expect(toEmbedUrl(`https://www.youtube.com/watch?v=${YT_ID}&list=PL123&index=2`)).toBe(
      `${PLAYER}?list=PL123`
    );
    expect(toEmbedUrl('https://www.youtube.com/embed/videoseries?list=PL123')).toBe(
      'https://www.youtube.com/embed/videoseries?list=PL123'
    );
  });

  test('a player URL keeps its own options', () => {
    expect(toEmbedUrl(`${PLAYER}?start=30&rel=0`)).toBe(`${PLAYER}?rel=0&start=30`);
  });

  test('decided on the hostname, never on a substring of the URL', () => {
    for (const url of [
      'https://evil.example/?u=youtube.com/watch?v=x',
      `https://evil.example/youtu.be/${YT_ID}`,
      `https://notyoutube.com/watch?v=${YT_ID}`,
      `https://youtube.com.evil.example/watch?v=${YT_ID}`,
      'https://evil.example/vimeo.com/76979871',
    ]) {
      expect(toEmbedUrl(url), url).toBe(url);
    }
  });

  test('a YouTube URL with no video id is left alone', () => {
    for (const url of [
      'https://www.youtube.com/',
      'https://www.youtube.com/watch',
      'https://youtu.be/',
    ]) {
      expect(toEmbedUrl(url), url).toBe(url);
    }
  });

  test('Vimeo page URLs become the player URL, with the unlisted hash as h=', () => {
    expect(toEmbedUrl('https://vimeo.com/76979871')).toBe(
      'https://player.vimeo.com/video/76979871'
    );
    expect(toEmbedUrl('https://www.vimeo.com/76979871')).toBe(
      'https://player.vimeo.com/video/76979871'
    );
    expect(toEmbedUrl('https://vimeo.com/76979871/abc123def')).toBe(
      'https://player.vimeo.com/video/76979871?h=abc123def'
    );
    expect(decideFrame('https://vimeo.com/76979871', 'https://vimeo.com/76979871')).toEqual({
      kind: 'frame',
      src: 'https://player.vimeo.com/video/76979871',
      sandboxed: true,
    });
  });

  test('player.vimeo.com URLs and other Vimeo pages are left as they are', () => {
    for (const url of [
      'https://player.vimeo.com/video/76979871?h=abc',
      'https://vimeo.com/channels/staffpicks',
    ]) {
      expect(toEmbedUrl(url), url).toBe(url);
    }
  });

  test('a provider URL is converted from what was stored, not from a resolution', () => {
    expect(decideFrame(`https://youtu.be/${YT_ID}`, 'https://unrelated.test/x')).toEqual({
      kind: 'frame',
      src: PLAYER,
      sandboxed: true,
    });
  });

  test('anything else is untouched', () => {
    expect(toEmbedUrl('https://docs.google.com/document/d/x/preview')).toBe(
      'https://docs.google.com/document/d/x/preview'
    );
    expect(toEmbedUrl('not a url')).toBe('not a url');
    expect(toEmbedUrl('')).toBe('');
  });
});

test.describe('what SafeFrame renders', () => {
  const render = (decision: FrameDecision, editable = false, storedUrl = 'x') =>
    renderToStaticMarkup(
      createElement(SafeFrame, { decision, title: 'Embedded content', editable, storedUrl })
    );
  const parse = (html: string) => new JSDOM(`<body>${html}</body>`).window.document;

  test('a normal https URL: an iframe with the exact sandbox and the frame attributes', () => {
    const url = 'https://codesandbox.io/embed/abc';
    const frame = parse(render(decideFrame(url, url))).querySelector('iframe');
    expect(frame?.getAttribute('src')).toBe(url);
    expect(frame?.getAttribute('sandbox')).toBe(FRAME_SANDBOX);
    expect(frame?.getAttribute('allow')).toBe(FRAME_ALLOW);
    expect(frame?.getAttribute('referrerpolicy')).toBe('strict-origin-when-cross-origin');
    expect(frame?.getAttribute('loading')).toBe('lazy');
    expect(frame?.hasAttribute('allowfullscreen')).toBe(true);
  });

  test('a PDF: an iframe with no sandbox attribute at all', () => {
    const url = 'https://example.com/syllabus.pdf';
    const frame = parse(render(decideFrame(url, url))).querySelector('iframe');
    expect(frame?.getAttribute('src')).toBe(url);
    expect(frame?.hasAttribute('sandbox')).toBe(false);
    expect(frame?.getAttribute('referrerpolicy')).toBe('strict-origin-when-cross-origin');
    expect(frame?.getAttribute('loading')).toBe('lazy');
  });

  test('http: a new-tab link, no iframe', () => {
    const url = 'http://example.com/page';
    const doc = parse(render(decideFrame(url, url)));
    expect(doc.querySelector('iframe')).toBeNull();
    const link = doc.querySelector('a');
    expect(link?.getAttribute('href')).toBe(url);
    expect(link?.getAttribute('target')).toBe('_blank');
    expect(link?.getAttribute('rel')).toBe('noopener noreferrer');
    expect(link?.textContent).toBe(url);
  });

  test('javascript: text only, no link and no iframe', () => {
    const url = 'javascript:alert(1)';
    const doc = parse(render(decideFrame(url, url)));
    expect(doc.querySelector('iframe')).toBeNull();
    expect(doc.querySelector('a')).toBeNull();
    expect(doc.body.textContent).toBe(url);
  });

  test('nothing to frame: nothing for a reader, the stored text for an author', () => {
    expect(render(decideFrame('', ''))).toBe('');
    expect(render(decideFrame(MEDIA_REF, MEDIA_REF))).toBe('');
    const authored = parse(render(decideFrame(MEDIA_REF, MEDIA_REF), true, MEDIA_REF));
    expect(authored.querySelector('iframe')).toBeNull();
    expect(authored.body.textContent).toBe(MEDIA_REF);
  });
});

test.describe('link fallbacks', () => {
  test('only absolute http(s) URLs get an href', () => {
    expect(safeLinkHref('https://a.test/x')).toBe('https://a.test/x');
    expect(safeLinkHref('http://a.test/x')).toBe('http://a.test/x');
    expect(safeLinkHref('javascript:alert(1)')).toBeNull();
    expect(safeLinkHref('data:text/html,x')).toBeNull();
    expect(safeLinkHref('/relative')).toBeNull();
    expect(safeLinkHref('')).toBeNull();
    expect(safeLinkHref(undefined)).toBeNull();
  });

  test('https is exact', () => {
    expect(isHttpsUrl('https://a.test')).toBe(true);
    expect(isHttpsUrl('http://a.test')).toBe(false);
    expect(isHttpsUrl('wss://a.test')).toBe(false);
    expect(isHttpsUrl('')).toBe(false);
  });
});

test.describe('read-only gates', () => {
  test('the callout emoji cycles for an author', () => {
    expect(nextCalloutEmoji('💡')).toBe('⚡');
    expect(nextCalloutEmoji(CALLOUT_EMOJIS[CALLOUT_EMOJIS.length - 1])).toBe('💡');
    // An emoji outside the cycle starts it.
    expect(nextCalloutEmoji('🐙')).toBe('💡');
  });

  test('embed, video and page link: a reader of an empty block gets nothing', () => {
    expect(fieldBlockView(false, false)).toBe('nothing');
    expect(fieldBlockView(true, false)).toBe('empty-state');
    expect(fieldBlockView(false, true)).toBe('content');
    expect(fieldBlockView(true, true)).toBe('content');
  });

  test('terminal: a reader gets the code or nothing, never an editing box', () => {
    expect(terminalView(false, 'ls -la')).toBe('code');
    expect(terminalView(false, '')).toBe('nothing');
    expect(terminalView(true, '')).toBe('edit');
    expect(terminalView(true, 'ls -la')).toBe('edit');
  });

  test('page link: only an author with the picker open asks for the page list', () => {
    const base = { editable: true, open: true, loaded: false, loading: false };
    expect(pageLinkMayFetch(base)).toBe(true);
    expect(pageLinkMayFetch({ ...base, editable: false })).toBe(false);
    expect(pageLinkMayFetch({ ...base, open: false })).toBe(false);
    expect(pageLinkMayFetch({ ...base, loaded: true })).toBe(false);
    expect(pageLinkMayFetch({ ...base, loading: true })).toBe(false);
  });

  test('media a reader cannot be shown: no URL, an unresolved reference, a placeholder', () => {
    expect(readerCanShowMedia('', '')).toBe(false);
    expect(readerCanShowMedia(undefined, undefined)).toBe(false);
    expect(readerCanShowMedia(MEDIA_REF, MEDIA_REF)).toBe(false);
    expect(readerCanShowMedia('media://audio-1', 'media://audio-1')).toBe(false);
    expect(readerCanShowMedia(MEDIA_REF, PLACEHOLDER)).toBe(false);
  });

  test('media a reader is shown: a resolved reference, a repo file, an external URL', () => {
    expect(readerCanShowMedia(MEDIA_REF, SIGNED_MEDIA)).toBe(true);
    expect(readerCanShowMedia('pages/lab/a.png', SIGNED_BLOB)).toBe(true);
    // No display URL for it (the delivery layer off): the reference is the URL.
    expect(readerCanShowMedia('pages/lab/a.png', 'pages/lab/a.png')).toBe(true);
    expect(readerCanShowMedia('https://example.com/a.png', 'https://example.com/a.png')).toBe(true);
    // A block given no resolution yet is judged by what it stored.
    expect(readerCanShowMedia('https://example.com/a.png', '')).toBe(true);
  });
});
