/**
 * The frame rule: which repo file (if any) a deck frame's source names, and
 * the editor's `/<slideId>/frame/…` form of it.
 */

import { describe, it, expect } from 'vitest';

import { extractOwnRepoPath } from '../../classmoji/contentRefs.ts';
import {
  appFrameHosts,
  classifyFrameRef,
  fromEditorFrameUrl,
  isEditorFrameUrl,
  isRepoDocumentPath,
  parseEditorFrameUrl,
  relativeToDeck,
  resolveDeckRelative,
  toEditorFrameUrl,
  type FrameRefOptions,
} from '../frameRefs.ts';

const ORG = 'cs52-org';
const REPO = 'cs52-content';
const DECK = 'slides/week-1';
const SLIDE_ID = '9b2f1c4e-0000-4000-8000-000000000001';
const OTHER_SLIDE_ID = 'aaaaaaaa-0000-4000-8000-000000000002';
const CLASSROOM = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const CONTENT = 'https://content.classmoji.io';

const opts: FrameRefOptions = {
  deckFolder: DECK,
  ownRepoPath: value => extractOwnRepoPath(value, ORG, REPO),
  ourHosts: ['slides.classmoji.io', 'localhost:6500', '.classmoji.io'],
  contentOrigin: CONTENT,
  slideId: SLIDE_ID,
  filesRef: url => {
    const match = new RegExp(
      `^${CONTENT}/c/${CLASSROOM}/files/[^/]+/[^/]+/([^?#]+)([?#].*)?$`
    ).exec(url);
    return match ? { repoPath: decodeURIComponent(match[1]), query: match[2] ?? '' } : null;
  },
};

const classify = (value: string) => classifyFrameRef(value, opts);
const ours = (repoPath: string, query = '') => ({ kind: 'ours', repoPath, query });

describe('resolveDeckRelative', () => {
  it('resolves against the deck folder with URL semantics', () => {
    expect(resolveDeckRelative('blocks/ab12cd34.html', DECK)).toEqual({
      repoPath: 'slides/week-1/blocks/ab12cd34.html',
      query: '',
    });
    expect(resolveDeckRelative('./games/a/index.html?y=1#top', DECK)).toEqual({
      repoPath: 'slides/week-1/games/a/index.html',
      query: '?y=1#top',
    });
    expect(resolveDeckRelative('../../games/sketchkit/draw.html?deck=x&f=y', DECK)).toEqual({
      repoPath: 'games/sketchkit/draw.html',
      query: '?deck=x&f=y',
    });
  });

  it('decodes each segment once', () => {
    expect(resolveDeckRelative('games/my%20game/index.html', DECK)?.repoPath).toBe(
      'slides/week-1/games/my game/index.html'
    );
    // A double-encoded `..` stays a literal name, never a step up.
    expect(resolveDeckRelative('%252e%252e/x.html', DECK)?.repoPath).toBe(
      'slides/week-1/%2e%2e/x.html'
    );
  });

  it('names a folder by its index page', () => {
    expect(resolveDeckRelative('games/snake/', DECK)?.repoPath).toBe(
      'slides/week-1/games/snake/index.html'
    );
  });

  it('refuses what climbs out of the repo, and what is not relative', () => {
    expect(resolveDeckRelative('../../../x.html', DECK)).toBeNull();
    expect(resolveDeckRelative('%2e%2e/%2e%2e/%2e%2e/x.html', DECK)).toBeNull();
    expect(resolveDeckRelative('/content/a/b/c.html', DECK)).toBeNull();
    expect(resolveDeckRelative('//evil.example/x.html', DECK)).toBeNull();
    expect(resolveDeckRelative('https://example.com/x.html', DECK)).toBeNull();
    expect(resolveDeckRelative('a%2Fb.html', DECK)).toBeNull();
    expect(resolveDeckRelative('', DECK)).toBeNull();
    expect(resolveDeckRelative('x.html', '')).toBeNull();
  });
});

describe('classifyFrameRef', () => {
  it('ours: relative to the deck, this repo through the proxy, raw or Pages', () => {
    expect(classify('games/snake/index.html')).toEqual(
      ours('slides/week-1/games/snake/index.html')
    );
    expect(classify(`/content/${ORG}/${REPO}/games/snake/index.html?level=2`)).toEqual(
      ours('games/snake/index.html', '?level=2')
    );
    expect(classify(`https://slides.classmoji.io/content/${ORG}/${REPO}/games/a/i.html`)).toEqual(
      ours('games/a/i.html')
    );
    expect(classify(`https://${ORG}.github.io/${REPO}/games/a/i.html#h`)).toEqual(
      ours('games/a/i.html', '#h')
    );
    expect(
      classify(`https://raw.githubusercontent.com/${ORG}/${REPO}/main/games/a/i.html`)
    ).toEqual(ours('games/a/i.html'));
  });

  it('ours: a folder names its index page, in every spelling', () => {
    expect(classify('games/snake/')).toEqual(ours('slides/week-1/games/snake/index.html'));
    expect(classify(`/content/${ORG}/${REPO}/games/snake/?l=1`)).toEqual(
      ours('games/snake/index.html', '?l=1')
    );
    expect(classify(`https://${ORG}.github.io/${REPO}/games/snake/`)).toEqual(
      ours('games/snake/index.html')
    );
    expect(classify(`/${SLIDE_ID}/frame/games/snake/`)).toEqual(ours('games/snake/index.html'));
    // The folder of a deck names the deck's own document, which is never framed.
    expect(classify(`/content/${ORG}/${REPO}/slides/week-2/`)).toEqual({ kind: 'inert' });
  });

  it("ours: this classroom's files URL and any deck's editor URL", () => {
    expect(
      classify(`${CONTENT}/c/${CLASSROOM}/files/GRANT/week.1.2.sig/games/a/i.html?x=1`)
    ).toEqual(ours('games/a/i.html', '?x=1'));
    expect(classify(`/${SLIDE_ID}/frame/games/a/i.html?x=1&cm-rev=abc`)).toEqual(
      ours('games/a/i.html', '?x=1')
    );
    expect(classify(`https://slides.classmoji.io/${SLIDE_ID}/frame/games/a/i.html`)).toEqual(
      ours('games/a/i.html')
    );
    // Another deck's editor URL (a paste) names the same path in this repo.
    expect(classify(`/${OTHER_SLIDE_ID}/frame/slides/other/blocks/x.html?cm-rev=1`)).toEqual(
      ours('slides/other/blocks/x.html')
    );
  });

  it('external: other hosts, as written; nothing-loading values too', () => {
    expect(classify('https://www.youtube.com/embed/abc')).toEqual({ kind: 'external' });
    expect(classify('http://example.com/x')).toEqual({ kind: 'external' });
    expect(classify('//player.vimeo.com/video/1')).toEqual({ kind: 'external' });
    expect(classify('https://raw.githubusercontent.com/other/repo/main/x.html')).toEqual({
      kind: 'external',
    });
    expect(classify('')).toEqual({ kind: 'external' });
    expect(classify('about:blank')).toEqual({ kind: 'external' });
    // The content origin's other shapes are served with a strict policy of their own.
    expect(classify(`${CONTENT}/preview-frame`)).toEqual({ kind: 'external' });
  });

  it('inert: script and data URLs', () => {
    for (const value of [
      'javascript:alert(1)',
      ' JaVaScRiPt:alert(1)',
      'vbscript:x',
      'data:text/html,<script>1</script>',
      'blob:https://slides.classmoji.io/1',
      'about:srcdoc',
      'file:///etc/passwd',
      'java\u0000script:x',
    ]) {
      expect(classify(value), value).toEqual({ kind: 'inert' });
    }
  });

  it("inert: the app's own pages, under any host of the cookie domain", () => {
    for (const value of [
      'https://slides.classmoji.io/abc',
      'https://classmoji.io/settings',
      'https://app.classmoji.io/admin/x',
      'https://collab.classmoji.io/',
      'http://localhost:6500/x',
      '/some-route',
      `/${SLIDE_ID}`,
      // The editor route's shape needs a slide id.
      '/not-a-slide/frame/games/a/i.html',
    ]) {
      expect(classify(value), value).toEqual({ kind: 'inert' });
    }
  });

  it("inert: another classroom's content", () => {
    expect(classify('/content/other-org/other-repo/games/a.html')).toEqual({ kind: 'inert' });
    expect(classify(`https://slides.classmoji.io/content/${ORG}/other-repo/games/a.html`)).toEqual({
      kind: 'inert',
    });
    expect(
      classify(`${CONTENT}/c/aaaaaaaa-0000-4000-8000-000000000009/files/G/week.1.2.sig/a/b.html`)
    ).toEqual({ kind: 'inert' });
  });

  it('inert: outside the repo, and stored documents', () => {
    expect(classify('../../../x.html')).toEqual({ kind: 'inert' });
    expect(classify('index.html')).toEqual({ kind: 'inert' });
    expect(classify('deck.json')).toEqual({ kind: 'inert' });
    expect(classify('?x=1')).toEqual({ kind: 'inert' });
    expect(classify('../other/index.html')).toEqual({ kind: 'inert' });
    expect(classify('../../pages/lab/content.json')).toEqual({ kind: 'inert' });
    expect(classify(`/content/${ORG}/${REPO}/slides/week-2/deck.json`)).toEqual({ kind: 'inert' });
  });

  it('the content origin is never an app host, whatever the cookie domain', () => {
    expect(classifyFrameRef(`${CONTENT}/anything`, { ...opts, filesRef: undefined })).toEqual({
      kind: 'external',
    });
  });

  it('is case-insensitive about hosts', () => {
    expect(classify('https://SLIDES.Classmoji.IO/x')).toEqual({ kind: 'inert' });
  });
});

describe('isRepoDocumentPath', () => {
  it('deck and page documents only', () => {
    expect(isRepoDocumentPath('slides/x/index.html')).toBe(true);
    expect(isRepoDocumentPath('slides/x/DECK.JSON')).toBe(true);
    expect(isRepoDocumentPath('pages/y/content.json')).toBe(true);
    expect(isRepoDocumentPath('pages/y/index.html')).toBe(true);
    expect(isRepoDocumentPath('slides/x/blocks/index.html')).toBe(false);
    expect(isRepoDocumentPath('games/index.html')).toBe(false);
  });
});

describe('editor frame URLs', () => {
  it('round-trips a target in the deck', () => {
    const url = toEditorFrameUrl('slides/week-1/blocks/ab12cd34.html', '', {
      slideId: SLIDE_ID,
      rev: 'f'.repeat(40),
    });
    expect(url).toBe(
      `/${SLIDE_ID}/frame/slides/week-1/blocks/ab12cd34.html?cm-rev=${'f'.repeat(40)}`
    );
    expect(isEditorFrameUrl(url)).toBe(true);
    expect(fromEditorFrameUrl(url, { slideId: SLIDE_ID, deckFolder: DECK })).toBe(
      'blocks/ab12cd34.html'
    );
  });

  it('keeps the query and hash, and puts cm-rev before the hash', () => {
    const url = toEditorFrameUrl('games/sketchkit/draw.html', '?deck=x&f=y#p', {
      slideId: SLIDE_ID,
      rev: 'r1',
    });
    expect(url).toBe(`/${SLIDE_ID}/frame/games/sketchkit/draw.html?deck=x&f=y&cm-rev=r1#p`);
    expect(fromEditorFrameUrl(url, { slideId: SLIDE_ID, deckFolder: DECK })).toBe(
      '../../games/sketchkit/draw.html?deck=x&f=y#p'
    );
  });

  it('encodes and decodes path segments', () => {
    const url = toEditorFrameUrl('slides/week-1/games/my game/i.html', '', { slideId: SLIDE_ID });
    expect(url).toBe(`/${SLIDE_ID}/frame/slides/week-1/games/my%20game/i.html`);
    expect(parseEditorFrameUrl(url, { slideId: SLIDE_ID })).toEqual({
      repoPath: 'slides/week-1/games/my game/i.html',
      query: '',
    });
    expect(fromEditorFrameUrl(url, { slideId: SLIDE_ID, deckFolder: DECK })).toBe(
      'games/my%20game/i.html'
    );
  });

  it('the stored form resolves back to the same target', () => {
    for (const repoPath of [
      'slides/week-1/blocks/a.html',
      'slides/week-1/games/a/b/c.html',
      'games/sketchkit/draw.html',
      'slides/other/games/x.html',
    ]) {
      const stored = fromEditorFrameUrl(
        toEditorFrameUrl(repoPath, '?q=1', { slideId: SLIDE_ID, rev: 'r' }),
        { slideId: SLIDE_ID, deckFolder: DECK }
      ) as string;
      expect(resolveDeckRelative(stored, DECK)).toEqual({ repoPath, query: '?q=1' });
    }
  });

  it('accepts an absolute form and any deck, refuses traversal', () => {
    expect(
      parseEditorFrameUrl(`https://slides.classmoji.io/${SLIDE_ID}/frame/a/b.html?cm-rev=1`, {
        ourHosts: opts.ourHosts,
      })
    ).toEqual({ repoPath: 'a/b.html', query: '' });
    expect(parseEditorFrameUrl(`/${OTHER_SLIDE_ID}/frame/a/b.html`, { slideId: SLIDE_ID })).toEqual(
      { repoPath: 'a/b.html', query: '' }
    );
    expect(parseEditorFrameUrl(`/${SLIDE_ID}/frame/games/snake/`)).toEqual({
      repoPath: 'games/snake/index.html',
      query: '',
    });
    expect(parseEditorFrameUrl(`/${SLIDE_ID}/frame/a/../b.html`, { slideId: SLIDE_ID })).toBeNull();
    expect(
      parseEditorFrameUrl(`/${SLIDE_ID}/frame/a/%2e%2e/b.html`, { slideId: SLIDE_ID })
    ).toBeNull();
    expect(parseEditorFrameUrl(`/${SLIDE_ID}/frame/a%2Fb.html`, { slideId: SLIDE_ID })).toBeNull();
    expect(isEditorFrameUrl('https://example.com/x.html')).toBe(false);
  });

  it('an absolute editor URL counts only on one of our hosts', () => {
    const path = `/${SLIDE_ID}/frame/a.html`;
    const hosts = { ourHosts: opts.ourHosts };
    // Root-relative: always the app that serves the deck.
    expect(parseEditorFrameUrl(path)).toEqual({ repoPath: 'a.html', query: '' });
    for (const url of [
      `https://example.com${path}`,
      `https://slides.classmoji.io.evil.test${path}`,
    ]) {
      expect(isEditorFrameUrl(url, hosts), url).toBe(false);
      expect(parseEditorFrameUrl(url, hosts), url).toBeNull();
      expect(fromEditorFrameUrl(url, { deckFolder: DECK, ...hosts }), url).toBeNull();
      expect(classify(url), url).toEqual({ kind: 'external' });
    }
    for (const url of [
      `https://slides.classmoji.io${path}`,
      `https://SLIDES.classmoji.io${path}`,
      `http://localhost:6500${path}`,
      `https://pages.classmoji.io${path}`,
    ]) {
      expect(parseEditorFrameUrl(url, hosts), url).toEqual({ repoPath: 'a.html', query: '' });
    }
    // Without our hosts, no absolute URL is one.
    expect(parseEditorFrameUrl(`https://slides.classmoji.io${path}`)).toBeNull();
    expect(isEditorFrameUrl(`https://slides.classmoji.io${path}`)).toBe(false);
  });

  it('appFrameHosts: the configured app origins, plus the cookie domain when given', () => {
    const env = {
      SLIDES_URL: 'https://Slides.classmoji.io',
      WEBAPP_URL: 'http://localhost:3000/x',
      PAGES_URL: 'not a url',
      MCP_PUBLIC_URL: '',
    };
    expect(appFrameHosts(env)).toEqual(['slides.classmoji.io', 'localhost:3000']);
    expect(appFrameHosts(env, '.classmoji.io')).toEqual([
      'slides.classmoji.io',
      'localhost:3000',
      '.classmoji.io',
    ]);
  });

  it('needs a slide id first: other pages with a /frame/ path are not editor URLs', () => {
    for (const url of [
      'https://example.com/foo/frame/x.html',
      '/admin/frame/x.html',
      `/${SLIDE_ID}x/frame/x.html`,
    ]) {
      expect(isEditorFrameUrl(url), url).toBe(false);
      expect(parseEditorFrameUrl(url), url).toBeNull();
    }
  });

  it("another deck's editor URL is stored relative to this deck", () => {
    const pasted = toEditorFrameUrl('slides/other/blocks/x.html', '', {
      slideId: OTHER_SLIDE_ID,
      rev: 'r',
    });
    expect(fromEditorFrameUrl(pasted, { deckFolder: DECK })).toBe('../other/blocks/x.html');
    expect(
      fromEditorFrameUrl(`https://slides.classmoji.io/${OTHER_SLIDE_ID}/frame/games/a/i.html?y=1`, {
        deckFolder: DECK,
        ourHosts: opts.ourHosts,
      })
    ).toBe('../../games/a/i.html?y=1');
  });

  it('relativeToDeck walks up only as far as it must', () => {
    expect(relativeToDeck('slides/week-1/a.html', DECK)).toBe('a.html');
    expect(relativeToDeck('slides/week-2/a.html', DECK)).toBe('../week-2/a.html');
    expect(relativeToDeck('a.html', DECK)).toBe('../../a.html');
  });
});
