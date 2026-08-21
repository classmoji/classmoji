import { describe, expect, it } from 'vitest';
import {
  INITIAL_PEEK_STATE,
  buildEmbedUrl,
  inAppPageUrl,
  originOf,
  peekReducer,
  readPagesMessage,
  resolveOpenTarget,
  sitePageUrl,
} from '../pageLinks';

/**
 * Unit tests for the in-app page reader's pure logic.
 *
 * Three things are worth pinning down here, and none of them need a browser:
 *  - the ↗ target, because "site link vs in-app link" is a visibility decision
 *    and getting it wrong points students at a 404 (or worse, advertises that a
 *    members-only page exists on the public web);
 *  - the message guard, which is the trust boundary between the webapp and an
 *    iframe full of user-authored content;
 *  - the drawer reducer, whose only real subtlety is that a late nav ping must
 *    not resurrect a closed drawer.
 */

const PAGES_URL = 'http://localhost:7140';
const PAGES_ORIGIN = 'http://localhost:7140';

describe('originOf', () => {
  it('extracts the origin and drops path/query', () => {
    expect(originOf('http://localhost:7140/cs52/abc?embed=true')).toBe('http://localhost:7140');
    expect(originOf('https://pages.classmoji.io')).toBe('https://pages.classmoji.io');
  });

  it('returns null for unusable configuration rather than throwing', () => {
    expect(originOf('')).toBeNull();
    expect(originOf(undefined)).toBeNull();
    expect(originOf('not a url')).toBeNull();
  });
});

describe('sitePageUrl', () => {
  it('builds a site URL from an origin and a slug', () => {
    expect(sitePageUrl('https://cs52.classmoji.io', 'syllabus')).toBe(
      'https://cs52.classmoji.io/syllabus'
    );
  });

  it('is empty when there is no site or no slug — the two "no public URL" cases', () => {
    expect(sitePageUrl(null, 'syllabus')).toBe('');
    expect(sitePageUrl('https://cs52.classmoji.io', null)).toBe('');
    expect(sitePageUrl('https://cs52.classmoji.io', undefined)).toBe('');
  });

  it('encodes the slug segment', () => {
    expect(sitePageUrl('https://cs52.classmoji.io', 'a b/c')).toBe(
      'https://cs52.classmoji.io/a%20b%2Fc'
    );
  });
});

describe('resolveOpenTarget', () => {
  const siteOrigin = 'https://cs52.classmoji.io';
  const siteSlugByPageId = { public1: 'syllabus' };
  const fallbackUrl = '/student/cs52/pages/members1';

  it('prefers the class site for a page that is actually served there', () => {
    expect(
      resolveOpenTarget({ siteOrigin, siteSlugByPageId, pageId: 'public1', fallbackUrl })
    ).toEqual({ url: 'https://cs52.classmoji.io/syllabus', isSite: true });
  });

  it('falls back in-app for a members-only page (absent from the site map)', () => {
    expect(
      resolveOpenTarget({ siteOrigin, siteSlugByPageId, pageId: 'members1', fallbackUrl })
    ).toEqual({ url: fallbackUrl, isSite: false });
  });

  it('falls back in-app when the class has no live site at all', () => {
    expect(
      resolveOpenTarget({
        siteOrigin: null,
        siteSlugByPageId: {},
        pageId: 'public1',
        fallbackUrl,
      })
    ).toEqual({ url: fallbackUrl, isSite: false });
  });

  it('falls back when no page is known yet', () => {
    expect(resolveOpenTarget({ siteOrigin, siteSlugByPageId, pageId: null, fallbackUrl })).toEqual({
      url: fallbackUrl,
      isSite: false,
    });
  });
});

describe('inAppPageUrl', () => {
  it('builds the reader URL for each role prefix', () => {
    expect(inAppPageUrl('/student', 'cs52', 'p1')).toBe('/student/cs52/pages/p1');
    expect(inAppPageUrl('assistant', 'cs52', 'p1')).toBe('/assistant/cs52/pages/p1');
  });
});

describe('buildEmbedUrl', () => {
  it('embeds with the parent origin so the frame can verify its embedder', () => {
    expect(
      buildEmbedUrl({
        pagesUrl: PAGES_URL,
        classSlug: 'cs52',
        pageRef: 'p1',
        parentOrigin: 'http://localhost:3040',
      })
    ).toBe('http://localhost:7140/cs52/p1?embed=true&parentOrigin=http%3A%2F%2Flocalhost%3A3040');
  });

  it('omits parentOrigin when unknown and tolerates a trailing slash', () => {
    expect(
      buildEmbedUrl({ pagesUrl: 'http://localhost:7140/', classSlug: 'cs52', pageRef: 'p1' })
    ).toBe('http://localhost:7140/cs52/p1?embed=true');
  });
});

describe('readPagesMessage', () => {
  const frameWindow = { name: 'frame' };
  const nav = {
    type: 'classmoji:page-nav',
    classroomSlug: 'cs52',
    pageId: 'p2',
    pageSlug: 'lab-1',
    title: 'Lab 1',
  };
  const ctx = { pagesOrigin: PAGES_ORIGIN, frameWindow, classSlug: 'cs52' };

  it('accepts a well-formed nav ping from the pages origin and our own frame', () => {
    expect(readPagesMessage({ origin: PAGES_ORIGIN, data: nav, source: frameWindow }, ctx)).toEqual(
      nav
    );
  });

  it('accepts the escape ping', () => {
    expect(
      readPagesMessage(
        { origin: PAGES_ORIGIN, data: { type: 'classmoji:page-esc' }, source: frameWindow },
        ctx
      )
    ).toEqual({ type: 'classmoji:page-esc' });
  });

  it('rejects any other origin — the whole point of the guard', () => {
    expect(
      readPagesMessage({ origin: 'https://evil.example', data: nav, source: frameWindow }, ctx)
    ).toBeNull();
  });

  it('rejects a same-origin message from a different window (nested/sibling frame)', () => {
    expect(
      readPagesMessage({ origin: PAGES_ORIGIN, data: nav, source: { name: 'other' } }, ctx)
    ).toBeNull();
  });

  it('rejects a ping for a different classroom', () => {
    expect(
      readPagesMessage(
        { origin: PAGES_ORIGIN, data: { ...nav, classroomSlug: 'other' }, source: frameWindow },
        ctx
      )
    ).toBeNull();
  });

  it('rejects malformed payloads and unknown types', () => {
    for (const data of [null, 'nav', { type: 'classmoji:page-nav' }, { type: 'other' }, {}]) {
      expect(readPagesMessage({ origin: PAGES_ORIGIN, data, source: frameWindow }, ctx)).toBeNull();
    }
  });

  it('is inert when the pages origin is unknown', () => {
    expect(
      readPagesMessage(
        { origin: PAGES_ORIGIN, data: nav, source: frameWindow },
        { ...ctx, pagesOrigin: null }
      )
    ).toBeNull();
  });

  it('normalises a missing slug/title rather than trusting the shape', () => {
    expect(
      readPagesMessage(
        {
          origin: PAGES_ORIGIN,
          data: { type: 'classmoji:page-nav', classroomSlug: 'cs52', pageId: 'p2' },
          source: frameWindow,
        },
        ctx
      )
    ).toEqual({
      type: 'classmoji:page-nav',
      classroomSlug: 'cs52',
      pageId: 'p2',
      pageSlug: null,
      title: '',
    });
  });
});

describe('peekReducer', () => {
  it('opens on a page and tracks it as both anchor and current', () => {
    const state = peekReducer(INITIAL_PEEK_STATE, {
      type: 'open',
      pageId: 'p1',
      title: 'Lab 1',
    });
    expect(state).toEqual({ open: true, pageId: 'p1', currentPageId: 'p1', title: 'Lab 1' });
  });

  it('follows in-frame navigation without moving the iframe anchor', () => {
    const opened = peekReducer(INITIAL_PEEK_STATE, {
      type: 'open',
      pageId: 'p1',
      title: 'Lab 1',
    });
    const navigated = peekReducer(opened, { type: 'nav', pageId: 'p2', title: 'Resources' });
    expect(navigated).toEqual({
      open: true,
      pageId: 'p1',
      currentPageId: 'p2',
      title: 'Resources',
    });
  });

  it('keeps the previous title when a nav ping carries none', () => {
    const opened = peekReducer(INITIAL_PEEK_STATE, {
      type: 'open',
      pageId: 'p1',
      title: 'Lab 1',
    });
    expect(peekReducer(opened, { type: 'nav', pageId: 'p2', title: '' }).title).toBe('Lab 1');
  });

  it('closes to a clean slate so a reopen never flashes the last page', () => {
    const opened = peekReducer(INITIAL_PEEK_STATE, {
      type: 'open',
      pageId: 'p1',
      title: 'Lab 1',
    });
    expect(peekReducer(opened, { type: 'close' })).toEqual(INITIAL_PEEK_STATE);
  });

  it('ignores a nav ping that arrives after close — a late unmount must not reopen', () => {
    expect(
      peekReducer(INITIAL_PEEK_STATE, { type: 'nav', pageId: 'p2', title: 'Resources' })
    ).toEqual(INITIAL_PEEK_STATE);
  });
});
