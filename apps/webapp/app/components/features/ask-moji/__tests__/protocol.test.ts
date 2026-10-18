import { describe, expect, it } from 'vitest';
import {
  allowedParentOrigins,
  checkedParentOrigin,
  frameAncestors,
  parseHostMessage,
  readHostMessage,
} from '../protocol';

const PAGES = 'https://pages.classmoji.io';
const SLIDES = 'https://slides.classmoji.io';
const allowed = allowedParentOrigins({ pagesUrl: `${PAGES}/`, slidesUrl: `${SLIDES}/x` });

describe('parent origin', () => {
  it('allows exactly the pages and slides origins', () => {
    expect(allowed).toEqual([PAGES, SLIDES]);
    expect(checkedParentOrigin(PAGES, allowed)).toBe(PAGES);
    expect(checkedParentOrigin(SLIDES, allowed)).toBe(SLIDES);
  });

  it('refuses anything else, including near misses', () => {
    for (const claim of [
      'https://evil.example',
      'https://classmoji.io',
      `${PAGES}/`,
      `${PAGES}/path`,
      'http://pages.classmoji.io',
      'https://pages.classmoji.io.evil.example',
      'javascript:alert(1)',
      '',
      null,
      undefined,
    ]) {
      expect(checkedParentOrigin(claim, allowed), String(claim)).toBeNull();
    }
  });

  it('frame-ancestors lists only those origins, or none', () => {
    expect(frameAncestors(allowed)).toBe(`frame-ancestors ${PAGES} ${SLIDES}`);
    expect(frameAncestors([])).toBe("frame-ancestors 'none'");
    expect(allowedParentOrigins({ pagesUrl: 'not a url', slidesUrl: null })).toEqual([]);
  });
});

describe('host messages', () => {
  const parentWindow = { name: 'parent' };
  const ok = (data: unknown) =>
    readHostMessage(
      { origin: PAGES, data, source: parentWindow },
      { parentOrigin: PAGES, parentWindow }
    );

  it('believes open, close and viewing from the parent origin and window', () => {
    expect(ok({ type: 'askmoji:open' })).toEqual({ type: 'askmoji:open' });
    expect(ok({ type: 'askmoji:close' })).toEqual({ type: 'askmoji:close' });
    expect(ok({ type: 'askmoji:viewing', viewing: { kind: 'page', id: 'p1' } })).toEqual({
      type: 'askmoji:viewing',
      viewing: { kind: 'page', id: 'p1' },
    });
    expect(ok({ type: 'askmoji:viewing', viewing: { kind: 'deck', id: 'd', slide: 4 } })).toEqual({
      type: 'askmoji:viewing',
      viewing: { kind: 'deck', id: 'd', slide: 4 },
    });
    expect(ok({ type: 'askmoji:viewing', viewing: null })).toEqual({
      type: 'askmoji:viewing',
      viewing: null,
    });
  });

  it('ignores another origin, another window, and no verified parent origin', () => {
    const data = { type: 'askmoji:open' };
    expect(
      readHostMessage(
        { origin: 'https://evil.example', data, source: parentWindow },
        { parentOrigin: PAGES, parentWindow }
      )
    ).toBeNull();
    expect(
      readHostMessage(
        { origin: PAGES, data, source: { other: true } },
        { parentOrigin: PAGES, parentWindow }
      )
    ).toBeNull();
    expect(
      readHostMessage(
        { origin: PAGES, data, source: parentWindow },
        { parentOrigin: null, parentWindow }
      )
    ).toBeNull();
  });

  it('takes a host title for the chip: a string of at most 200 characters, else none', () => {
    expect(
      ok({ type: 'askmoji:viewing', viewing: { kind: 'page', id: 'p1' }, title: ' Week 1 ' })
    ).toEqual({ type: 'askmoji:viewing', viewing: { kind: 'page', id: 'p1' }, title: 'Week 1' });
    expect(
      ok({ type: 'askmoji:viewing', viewing: { kind: 'page', id: 'p1' }, title: 'x'.repeat(200) })
    ).toMatchObject({ title: 'x'.repeat(200) });
    // A bad title is dropped; the viewing still counts.
    for (const title of ['x'.repeat(201), 42, { text: 'x' }, '   ', null]) {
      expect(ok({ type: 'askmoji:viewing', viewing: { kind: 'page', id: 'p1' }, title })).toEqual({
        type: 'askmoji:viewing',
        viewing: { kind: 'page', id: 'p1' },
      });
    }
    // No viewing, no title.
    expect(ok({ type: 'askmoji:viewing', viewing: null, title: 'Stale' })).toEqual({
      type: 'askmoji:viewing',
      viewing: null,
    });
  });

  it('refuses malformed messages and viewings', () => {
    for (const data of [
      null,
      'askmoji:open',
      [],
      { type: 'askmoji:ready' },
      { type: 'askmoji:request-close' },
      { type: 'askmoji:viewing' },
      { type: 'askmoji:viewing', viewing: { kind: 'grades', id: 'x' } },
      { type: 'askmoji:viewing', viewing: { kind: 'page', id: 42 } },
      { type: 'askmoji:viewing', viewing: { kind: 'page', id: 'x'.repeat(129) } },
      { type: 'askmoji:viewing', viewing: { kind: 'deck', id: 'd', slide: 1.5 } },
      { type: 'askmoji:viewing', viewing: { kind: 'deck', id: 'd', slide: -1 } },
      { type: 'askmoji:viewing', viewing: { kind: 'deck', id: 'd', slide: 100_000 } },
    ]) {
      expect(parseHostMessage(data), JSON.stringify(data)).toBeNull();
    }
  });
});
