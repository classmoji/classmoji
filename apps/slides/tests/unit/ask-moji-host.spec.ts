/**
 * The Ask Moji host: the launcher and frame that put the webapp's Ask Moji
 * panel inside the deck viewer and the speaker view.
 *
 * These run in the Playwright runner WITHOUT a browser or the dev stack. Pure
 * rules run directly; where a rule lives in a loader that needs Postgres, or in
 * which routes mount the host at all, what is pinned is the source shape.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';

import {
  askMojiEmbedUrl,
  askMojiHostDecision,
  deckViewing,
  flatSlideIndex,
  isAskMojiTarget,
  originOf,
  readAskMojiMessage,
  syncMessages,
  visibleFlatIndex,
  visibleStackSizes,
} from '../../app/components/askMoji/askMojiProtocol.ts';

const source = (relative: string) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

const WEBAPP = 'https://classmoji.io';

test.describe('readAskMojiMessage', () => {
  const frameWindow = { name: 'ask-moji-frame' };
  const ctx = { webappOrigin: WEBAPP, frameWindow };
  const from = (data: unknown, overrides: { origin?: string; source?: unknown } = {}) => ({
    origin: WEBAPP,
    source: frameWindow,
    data,
    ...overrides,
  });

  test('accepts the three frame messages from our frame on the webapp origin', () => {
    expect(readAskMojiMessage(from({ type: 'askmoji:ready' }), ctx)).toEqual({
      type: 'askmoji:ready',
    });
    expect(readAskMojiMessage(from({ type: 'askmoji:request-close' }), ctx)).toEqual({
      type: 'askmoji:request-close',
    });
    expect(readAskMojiMessage(from({ type: 'askmoji:busy', busy: true }), ctx)).toEqual({
      type: 'askmoji:busy',
      busy: true,
    });
  });

  test('refuses other origins, including this app’s own (the deck preview frames)', () => {
    for (const origin of ['https://evil.example', 'https://slides.classmoji.io', 'null']) {
      expect(readAskMojiMessage(from({ type: 'askmoji:ready' }, { origin }), ctx)).toBeNull();
    }
  });

  test('refuses another window, and believes nothing before the frame exists', () => {
    const msg = { type: 'askmoji:request-close' };
    expect(readAskMojiMessage(from(msg, { source: { name: 'other' } }), ctx)).toBeNull();
    expect(readAskMojiMessage(from(msg), { webappOrigin: WEBAPP, frameWindow: null })).toBeNull();
    expect(readAskMojiMessage(from(msg), { webappOrigin: null, frameWindow })).toBeNull();
  });

  test('refuses unknown or malformed shapes', () => {
    for (const data of [
      null,
      'askmoji:ready',
      [],
      {},
      { type: 'askmoji:close' },
      { type: 'askmoji:busy' },
      { type: 'askmoji:busy', busy: 'yes' },
      { type: 'slidechanged', indexh: 1 },
    ]) {
      expect(readAskMojiMessage(from(data), ctx), JSON.stringify(data)).toBeNull();
    }
  });

  test('ready brings the frame up to date: viewing first, then open or close', () => {
    expect(syncMessages({ kind: 'deck', id: 'd1', slide: 3 }, false)).toEqual([
      { type: 'askmoji:viewing', viewing: { kind: 'deck', id: 'd1', slide: 3 } },
      { type: 'askmoji:close' },
    ]);
  });

  test('the frame URL is the webapp embed route for the deck’s classroom', () => {
    expect(askMojiEmbedUrl(WEBAPP, 'cs52', 'https://slides.classmoji.io')).toBe(
      'https://classmoji.io/ask-moji/cs52/embed?parentOrigin=https%3A%2F%2Fslides.classmoji.io'
    );
    expect(originOf('http://localhost:3070/')).toBe('http://localhost:3070');
    expect(originOf('ftp://classmoji.io')).toBeNull();
  });
});

test.describe('the slide number', () => {
  test('reading order, horizontal-major; a stack counts its children, not itself', () => {
    // #/0, #/1/0, #/1/1, #/2 → 0, 1, 2, 3
    const sizes = [1, 2, 1];
    expect(flatSlideIndex(sizes, { h: 0, v: 0 })).toBe(0);
    expect(flatSlideIndex(sizes, { h: 1, v: 0 })).toBe(1);
    expect(flatSlideIndex(sizes, { h: 1, v: 1 })).toBe(2);
    expect(flatSlideIndex(sizes, { h: 2, v: 0 })).toBe(3);
  });

  test('positions outside the deck clamp into it', () => {
    const sizes = [1, 2, 1];
    expect(flatSlideIndex(sizes, { h: 1, v: 9 })).toBe(2);
    expect(flatSlideIndex(sizes, { h: 9, v: 0 })).toBe(3);
    expect(flatSlideIndex(sizes, { h: -1, v: -1 })).toBe(0);
    expect(flatSlideIndex(sizes, { h: Number.NaN, v: 0 })).toBe(0);
    expect(flatSlideIndex([], { h: 2, v: 1 })).toBe(0);
  });

  // The editor's deck: a slide, a stack of three whose middle child is hidden,
  // a hidden slide, a slide, and a stack whose only child is hidden but which
  // keeps content of its own (one flat slide).
  const editorLayout = [
    { keep: true, children: [] },
    { keep: true, children: [true, false, true] },
    { keep: false, children: [] },
    { keep: true, children: [] },
    { keep: true, children: [false] },
  ];

  test('visible stack sizes follow the hidden-slide rule', () => {
    expect(visibleStackSizes(editorLayout)).toEqual([1, 2, 1, 1]);
  });

  test('the editor’s positions map to the viewer’s numbering', () => {
    expect(visibleFlatIndex(editorLayout, { h: 0, v: 0 })).toBe(0);
    expect(visibleFlatIndex(editorLayout, { h: 1, v: 0 })).toBe(1);
    // Hidden: the visible slide that takes its place.
    expect(visibleFlatIndex(editorLayout, { h: 1, v: 1 })).toBe(2);
    expect(visibleFlatIndex(editorLayout, { h: 1, v: 2 })).toBe(2);
    expect(visibleFlatIndex(editorLayout, { h: 2, v: 0 })).toBe(3);
    expect(visibleFlatIndex(editorLayout, { h: 3, v: 0 })).toBe(3);
    expect(visibleFlatIndex(editorLayout, { h: 4, v: 0 })).toBe(4);
  });

  test('in view mode (hidden slides already gone) it is a plain count', () => {
    const viewLayout = [
      { keep: true, children: [] },
      { keep: true, children: [true, true] },
      { keep: true, children: [] },
    ];
    expect(visibleFlatIndex(viewLayout, { h: 1, v: 1 })).toBe(2);
    expect(visibleFlatIndex(viewLayout, { h: 2, v: 0 })).toBe(3);
    expect(visibleFlatIndex([], { h: 0, v: 0 })).toBe(0);
  });

  test('the viewing names the deck and the slide', () => {
    expect(deckViewing('deck-1', 4)).toEqual({ kind: 'deck', id: 'deck-1', slide: 4 });
    expect(deckViewing('deck-1', -2)).toEqual({ kind: 'deck', id: 'deck-1', slide: 0 });
    expect(deckViewing('deck-1', 2.7)).toEqual({ kind: 'deck', id: 'deck-1', slide: 2 });
    expect(deckViewing('', 0)).toBeNull();
    expect(deckViewing(null, 0)).toBeNull();
  });
});

test.describe('who gets the launcher', () => {
  const on = {
    via: 'membership' as const,
    acceptedRole: 'STUDENT',
    botEnabled: true,
    runtime: 'trigger',
    webappUrl: 'https://classmoji.io',
  };

  test('an accepted member let in as a member does', () => {
    expect(askMojiHostDecision(on)).toEqual({ enabled: true, origin: 'https://classmoji.io' });
    // Staff on a draft are let in by role, ownership or team edit.
    for (const via of ['role', 'ownership', 'team_edit'] as const) {
      expect(askMojiHostDecision({ ...on, via, acceptedRole: 'ASSISTANT' }).enabled).toBe(true);
    }
  });

  test('never public or share-code access, even for a member', () => {
    for (const via of ['public', 'shareCode', null, undefined] as const) {
      expect(askMojiHostDecision({ ...on, via }), String(via)).toEqual({
        enabled: false,
        origin: null,
      });
    }
  });

  test('a non-member or a pending invite does not', () => {
    expect(askMojiHostDecision({ ...on, acceptedRole: null }).enabled).toBe(false);
  });

  test('not when the classroom has Ask Moji off, another runtime, or no webapp origin', () => {
    expect(askMojiHostDecision({ ...on, botEnabled: false }).enabled).toBe(false);
    expect(askMojiHostDecision({ ...on, runtime: 'ai_agent' }).enabled).toBe(false);
    expect(askMojiHostDecision({ ...on, runtime: undefined }).enabled).toBe(false);
    expect(askMojiHostDecision({ ...on, webappUrl: '' }).enabled).toBe(false);
  });
});

test.describe('isAskMojiTarget', () => {
  test('true for the launcher, the container and anything inside them', () => {
    expect(isAskMojiTarget({ closest: (s: string) => (s === '[data-askmoji]' ? {} : null) })).toBe(
      true
    );
    expect(isAskMojiTarget({ closest: () => null })).toBe(false);
    expect(isAskMojiTarget(null)).toBe(false);
    expect(isAskMojiTarget({})).toBe(false);
  });
});

test.describe('where the host is mounted', () => {
  const VIEWER = source('../../app/routes/$slideId/route.tsx');
  const SPEAKER_ROUTE = source('../../app/routes/$slideId_.speaker/route.tsx');
  const SERVER = source('../../app/utils/askMoji.server.ts');

  test('the viewer and the speaker view decide on the server from the access gate', () => {
    for (const text of [VIEWER, SPEAKER_ROUTE]) {
      expect(text).toContain('await askMojiHostData({ userId, accessGrantedVia, slide });');
      expect(text).toContain('askMojiEnabled: askMoji.askMojiEnabled,');
      expect(text).toContain('classroomSlug: askMoji.classroomSlug,');
    }
    expect(SERVER).toContain('acceptedOnly: true');
    expect(SERVER).toContain('process.env.ASK_MOJI_RUNTIME');
  });

  test('the viewer mounts it once, in the navbar, outside the keyed RevealSlides', () => {
    expect(VIEWER.match(/<AskMojiHost/g)).toHaveLength(1);
    const nav = VIEWER.indexOf('<nav className={`slides-navbar');
    const navEnd = VIEWER.indexOf('</nav>', nav);
    const host = VIEWER.indexOf('<AskMojiHost');
    expect(host).toBeGreaterThan(nav);
    expect(host).toBeLessThan(navEnd);
  });

  test('never the present (audience) view, follow, or render-view', () => {
    for (const relative of [
      '../../app/routes/$slideId_.present/route.tsx',
      '../../app/routes/$slideId_.follow/route.tsx',
      '../../app/routes/$slideId_.render-view/route.tsx',
      '../../app/components/RevealPresenter.tsx',
    ]) {
      expect(source(relative), relative).not.toMatch(/askMoji|AskMoji/);
    }
  });

  test('every deck key and click handler ignores the launcher and panel', () => {
    expect(source('../../app/components/RevealSlides.tsx')).toContain(
      'keyboardCondition: (event: KeyboardEvent) => !isAskMojiTarget(event.target),'
    );
    for (const relative of [
      '../../app/components/SpeakerView.tsx',
      '../../app/components/SlideOverview/SlideOverview.tsx',
      '../../app/components/QRCodeOverlay.tsx',
    ]) {
      expect(source(relative), relative).toContain('if (isAskMojiTarget(e.target)) return;');
    }
    const selection = source('../../app/components/properties/ElementSelectionContext.tsx');
    expect(selection).toContain('if (isAskMojiTarget(event.target)) return;');
    expect(selection.match(/isAskMojiTarget\(event\.target\)/g)).toHaveLength(2);
  });
});
