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
  fileNameFromUrl,
  isHttpsUrl,
  isOwnFrameHost,
  safeLinkHref,
  toEmbedUrl,
  type FrameDecision,
  type FrameHosts,
} from '~/components/editor/blocks/safeFrame.ts';
import { ownFrameHosts } from '~/utils/frameHosts.server.ts';
import { SafeFrame, splitHostForCard } from '~/components/editor/blocks/frameElement.ts';
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

/** The production layout's environment: the apps are subdomains of the sites' base domain. */
const PROD_ENV = {
  WEBAPP_URL: 'https://app.classmoji.io',
  PAGES_URL: 'https://pages.classmoji.io',
  SLIDES_URL: 'https://slides.classmoji.io',
  CONTENT_DELIVERY_ORIGIN: 'https://content.classmoji.io',
  SITE_BASE_DOMAIN: 'classmoji.io',
};
/** The staging layout: the web app IS the base domain; the other apps sit under it. */
const STAGING_ENV = {
  WEBAPP_URL: 'https://staging.classmoji.io',
  PAGES_URL: 'https://pages.staging.classmoji.io',
  SLIDES_URL: 'https://slides.staging.classmoji.io',
  CONTENT_DELIVERY_ORIGIN: 'https://content.staging.classmoji.io',
  SITE_BASE_DOMAIN: 'staging.classmoji.io',
};
/** Our hosts as the server names them in production (`ownFrameHosts`). */
const HOSTS: FrameHosts = {
  hosts: ['app.classmoji.io', 'content.classmoji.io', 'pages.classmoji.io'],
  siteDomain: 'classmoji.io',
  framed: ['slides.classmoji.io'],
  delivery: 'content.classmoji.io',
};
/** A reference the server's display map resolved. */
const OWN = { hosts: HOSTS, serverResolved: true };

test.describe('the frame attributes', () => {
  test('the sandbox is exactly the decided one (dialogs allowed: code demos use alert/prompt)', () => {
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

test.describe("PDFs: framed unsandboxed only when they are the class's own file", () => {
  test('an https URL whose path ends .pdf, any case: a card, never a frame', () => {
    for (const url of [
      'https://example.com/syllabus.pdf',
      'https://example.com/syllabus.PDF',
      'https://example.com/syllabus.pdf?download=0#page=2',
    ]) {
      expect(decideFrame(url, url, null, { hosts: HOSTS }), url).toEqual({
        kind: 'file',
        href: url,
        name: url.includes('PDF') ? 'syllabus.PDF' : 'syllabus.pdf',
        host: 'example.com',
      });
      // With no hosts known, the same card: nothing is ever framed unsandboxed.
      expect(decideFrame(url, url).kind, url).toBe('file');
    }
  });

  test("the class's own PDF (a repo reference the server resolved, on the delivery host): no sandbox", () => {
    expect(decideFrame('pages/lab/handout.pdf', SIGNED_BLOB, null, OWN)).toEqual({
      kind: 'frame',
      src: SIGNED_BLOB,
      sandboxed: false,
    });
    // The signed URL need not say .pdf: the stored reference does.
    const opaque = `${DELIVERY}/c/${CLASSROOM}/blob/abc123?sig=x`;
    expect(decideFrame('pages/lab/Handout.PDF', opaque, null, OWN)).toEqual({
      kind: 'frame',
      src: opaque,
      sandboxed: false,
    });
  });

  test('the same URL the server did not resolve (pasted by an author) is our host: a link', () => {
    expect(decideFrame(SIGNED_BLOB, SIGNED_BLOB, null, { hosts: HOSTS })).toEqual({
      kind: 'link',
      text: SIGNED_BLOB,
      href: SIGNED_BLOB,
    });
    expect(
      decideFrame(SIGNED_BLOB, SIGNED_BLOB, null, { hosts: HOSTS, serverResolved: false }).kind
    ).toBe('link');
  });

  test('resolved, but not to the delivery host the server named: never unsandboxed', () => {
    const elsewhere = 'https://elsewhere.test/c/x/blob/abc/handout.pdf?sig=x';
    expect(decideFrame('pages/lab/handout.pdf', elsewhere, null, OWN)).toEqual({
      kind: 'file',
      href: elsewhere,
      name: 'handout.pdf',
      host: 'elsewhere.test',
    });
    // No delivery host named: our host is a link; with no hosts known at all, the card.
    expect(
      decideFrame('pages/lab/handout.pdf', SIGNED_BLOB, null, {
        hosts: { ...HOSTS, delivery: null },
        serverResolved: true,
      }).kind
    ).toBe('link');
    expect(
      decideFrame('pages/lab/handout.pdf', SIGNED_BLOB, null, { serverResolved: true }).kind
    ).toBe('file');
  });

  test('a placeholder for a file the class does not have is not shown', () => {
    const missing = `${DELIVERY}/c/${CLASSROOM}/missing/pages%2Flab%2Fgone.pdf`;
    expect(decideFrame('pages/lab/gone.pdf', missing, null, OWN)).toEqual({ kind: 'none' });
  });

  test("the class's own file that is not a PDF keeps the sandbox", () => {
    const html = SIGNED_BLOB.replace('handout.pdf', 'demo');
    expect(decideFrame('pages/lab/demo.html', html, null, OWN)).toEqual({
      kind: 'frame',
      src: html,
      sandboxed: true,
    });
  });

  test('decided on the path, not anywhere in the URL', () => {
    for (const url of [
      'https://example.com/viewer?file=a.pdf',
      'https://example.com/a.pdf/view',
      'https://example.pdf/page',
    ]) {
      expect(decideFrame(url, url, null, { hosts: HOSTS }), url).toEqual({
        kind: 'frame',
        src: url,
        sandboxed: true,
      });
    }
  });

  test('an http PDF is still only a link', () => {
    const url = 'http://example.com/a.pdf';
    expect(decideFrame(url, url)).toEqual({ kind: 'link', text: url, href: url });
  });
});

test.describe('our own hosts are never framed; the slides app and the base domain are', () => {
  const kind = (url: string, hosts: FrameHosts) => decideFrame(url, url, null, { hosts }).kind;

  test('the server reads the production layout from the environment', () => {
    expect(ownFrameHosts(PROD_ENV)).toEqual(HOSTS);
    expect(ownFrameHosts({ ...PROD_ENV, PAGES_URL: 'https://Pages.classmoji.io/' })).toEqual(HOSTS);
  });

  test('production: the web app, pages, delivery and every class site are links', () => {
    for (const url of [
      'https://app.classmoji.io/student/cs52/assignments',
      'https://pages.classmoji.io/cs52/page-1',
      'https://PAGES.classmoji.io./cs52/page-1',
      'https://content.classmoji.io/c/x/blob/abc/notes.html',
      'https://cs52.classmoji.io/week-1',
      'https://a.b.classmoji.io/x',
      // Other first-party hosts under the base domain are refused too.
      'https://admin.classmoji.io/',
      'https://mcp.classmoji.io/mcp',
    ]) {
      expect(decideFrame(url, url, null, { hosts: HOSTS }), url).toEqual({
        kind: 'link',
        text: url,
        href: url,
      });
    }
  });

  test('production: a slides deck and the base domain (marketing, docs) are framed, sandboxed', () => {
    for (const url of [
      'https://slides.classmoji.io/cs52/deck-1',
      'https://classmoji.io/docs/instructors',
    ]) {
      expect(decideFrame(url, url, null, { hosts: HOSTS }), url).toEqual({
        kind: 'frame',
        src: url,
        sandboxed: true,
      });
    }
  });

  test('staging: the web app is the base domain (a link); pages, delivery, sites are links; slides frames', () => {
    const staging = ownFrameHosts(STAGING_ENV);
    expect(staging).toEqual({
      hosts: ['content.staging.classmoji.io', 'pages.staging.classmoji.io', 'staging.classmoji.io'],
      siteDomain: 'staging.classmoji.io',
      framed: ['slides.staging.classmoji.io'],
      delivery: 'content.staging.classmoji.io',
    });
    for (const url of [
      'https://staging.classmoji.io/student/cs52',
      'https://pages.staging.classmoji.io/cs52/p',
      'https://content.staging.classmoji.io/c/x/blob/a/b.html',
      'https://cs52.staging.classmoji.io/week-1',
    ]) {
      expect(kind(url, staging), url).toBe('link');
    }
    expect(kind('https://slides.staging.classmoji.io/cs52/deck', staging)).toBe('frame');
    // Production's hosts are not staging's own.
    expect(kind('https://classmoji.io/', staging)).toBe('frame');
  });

  test('a slides host that is also a refused app host stays refused', () => {
    const same = ownFrameHosts({ ...PROD_ENV, SLIDES_URL: 'https://pages.classmoji.io' });
    expect(same.framed).toEqual([]);
    expect(kind('https://pages.classmoji.io/x', same)).toBe('link');
  });

  test('a PDF on one of our refused hosts is a link, not a card; on the slides host a card', () => {
    const url = 'https://cs52.classmoji.io/files/a.pdf';
    expect(decideFrame(url, url, null, { hosts: HOSTS })).toEqual({
      kind: 'link',
      text: url,
      href: url,
    });
    expect(kind('https://slides.classmoji.io/files/a.pdf', HOSTS)).toBe('file');
  });

  test('look-alike hosts are not ours', () => {
    for (const url of [
      'https://classmoji.io.evil.test/x',
      'https://evilclassmoji.io/x',
      'https://pages.classmoji.io.example/x',
    ]) {
      expect(isOwnFrameHost(new URL(url).hostname, HOSTS), url).toBe(false);
      expect(kind(url, HOSTS), url).toBe('frame');
    }
  });

  test('a provider embed still frames, sandboxed, with our hosts known', () => {
    expect(
      decideFrame(`https://youtu.be/${YT_ID}`, `https://youtu.be/${YT_ID}`, null, OWN)
    ).toEqual({ kind: 'frame', src: `https://www.youtube.com/embed/${YT_ID}`, sandboxed: true });
  });

  test('unset and malformed values name no host', () => {
    expect(ownFrameHosts({ WEBAPP_URL: 'not a url' })).toEqual({
      hosts: [],
      siteDomain: null,
      framed: [],
      delivery: null,
    });
  });
});

test.describe('the PDF card names the file safely', () => {
  const name = (path: string) => fileNameFromUrl(new URL(`https://example.com${path}`));

  test('the last path segment, percent-decoded', () => {
    expect(name('/docs/Week%201%20Notes.pdf')).toBe('Week 1 Notes.pdf');
    expect(name('/a/b/syllabus.pdf')).toBe('syllabus.pdf');
  });

  test('malformed encoding is shown as it is', () => {
    expect(name('/bad%E0%A4%A.pdf')).toBe('bad%E0%A4%A.pdf');
  });

  test('no control or bidirectional characters, however they were encoded', () => {
    expect(name('/%E2%80%AEfdp.exe.pdf')).toBe('fdp.exe.pdf');
    expect(name('/a%00b%0A.pdf')).toBe('ab.pdf');
  });

  test('no zero-width or format characters', () => {
    for (const code of [
      '200B',
      '200C',
      '200D',
      '200E',
      '200F',
      '2028',
      '202F',
      '2060',
      '2064',
      'FEFF',
    ]) {
      const encoded = encodeURIComponent(String.fromCharCode(parseInt(code, 16)));
      expect(name(`/se${encoded}cret.pdf`), code).toBe('secret.pdf');
    }
  });

  test('a decoded slash adds no path to the name: only the last segment shows', () => {
    expect(name('/docs/evil.example%2Fsyllabus.pdf')).toBe('syllabus.pdf');
    expect(name('/x/a%5Cb%5Creal.pdf')).toBe('real.pdf');
    expect(name('/x/trailing%2F')).toBe('trailing');
    expect(name('/x/%2F%2F')).toBe('Document.pdf');
  });

  test('a long name is cut; an empty one has a default', () => {
    const long = name(`/${'a'.repeat(300)}.pdf`);
    expect(long.length).toBe(120);
    expect(long.endsWith('…')).toBe(true);
    expect(fileNameFromUrl(new URL('https://example.com/'))).toBe('Document.pdf');
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

  test("the class's own PDF: an iframe with no sandbox attribute at all", () => {
    const frame = parse(
      render(decideFrame('pages/lab/handout.pdf', SIGNED_BLOB, null, OWN))
    ).querySelector('iframe');
    expect(frame?.getAttribute('src')).toBe(SIGNED_BLOB);
    expect(frame?.hasAttribute('sandbox')).toBe(false);
    expect(frame?.getAttribute('referrerpolicy')).toBe('strict-origin-when-cross-origin');
    expect(frame?.getAttribute('loading')).toBe('lazy');
  });

  test('any other PDF: a card whose "Open" link opens it in a new tab, no iframe', () => {
    const url = 'https://example.com/docs/Week%201.pdf';
    for (const editable of [false, true]) {
      const doc = parse(render(decideFrame(url, url, null, { hosts: HOSTS }), editable, url));
      expect(doc.querySelector('iframe')).toBeNull();
      // One link, and it is the Open control: the card itself is not a link.
      const links = doc.querySelectorAll('a');
      expect(links).toHaveLength(1);
      const open = doc.querySelector('.bn-frame-file > a.bn-frame-file-open');
      expect(open?.getAttribute('href')).toBe(url);
      expect(open?.getAttribute('target')).toBe('_blank');
      expect(open?.getAttribute('rel')).toBe('noopener noreferrer');
      expect(open?.getAttribute('aria-label')).toBe('Open Week 1.pdf (example.com) in a new tab');
      expect(doc.querySelector('.bn-frame-file')?.tagName).toBe('DIV');
      expect(doc.querySelector('.bn-frame-file-name')?.textContent).toBe('Week 1.pdf');
      expect(doc.querySelector('.bn-frame-file-host')?.textContent).toBe('example.com');
      // The reader stretches the link over the card; the editor does not, so a
      // click that selects the block opens nothing.
      expect(doc.querySelector('.bn-frame-file')?.classList.contains('bn-frame-file-reader')).toBe(
        !editable
      );
    }
  });

  test('a long host keeps its end: the head is cut first, the last two labels never', () => {
    const host = `docs.google.com.${'a'.repeat(44)}.attacker.example`;
    expect(splitHostForCard(host)).toEqual({
      head: `docs.google.com.${'a'.repeat(44)}.`,
      tail: 'attacker.example',
    });
    expect(splitHostForCard('example.com')).toEqual({ head: '', tail: 'example.com' });
    expect(splitHostForCard('a.b.example.com:8443')).toEqual({
      head: 'a.b.',
      tail: 'example.com:8443',
    });
    const url = `https://${host}/x.pdf`;
    const doc = parse(render(decideFrame(url, url)));
    expect(doc.querySelector('.bn-frame-file-host-tail')?.textContent).toBe('attacker.example');
    expect(doc.querySelector('.bn-frame-file-host')?.getAttribute('title')).toBe(host);
  });

  test('a file name is text, never markup', () => {
    const url = 'https://example.com/%3Cimg%20src%3Dx%20onerror%3Dalert(1)%3E.pdf';
    const doc = parse(render(decideFrame(url, url)));
    expect(doc.querySelector('img')).toBeNull();
    expect(doc.querySelector('.bn-frame-file-name')?.textContent).toBe(
      '<img src=x onerror=alert(1)>.pdf'
    );
  });

  test('our own host: a new-tab link, no iframe', () => {
    const url = 'https://cs52.classmoji.io/week-1';
    const doc = parse(render(decideFrame(url, url, null, { hosts: HOSTS })));
    expect(doc.querySelector('iframe')).toBeNull();
    expect(doc.querySelector('a')?.getAttribute('href')).toBe(url);
    expect(doc.querySelector('a')?.getAttribute('target')).toBe('_blank');
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
