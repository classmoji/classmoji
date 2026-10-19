/**
 * The Ask Moji host: the launcher and frame that put the webapp's Ask Moji
 * panel inside this app.
 *
 * Pure rules run here directly (no browser, no dev stack). Where a rule lives
 * in a loader that needs Postgres, what is pinned is the source shape, the
 * classroom-role.spec approach.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';

import {
  askMojiEmbedUrl,
  askMojiHostDecision,
  isAskMojiTarget,
  originOf,
  pageTitle,
  pageViewing,
  readAskMojiMessage,
  syncMessages,
  viewingMessage,
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
    expect(readAskMojiMessage(from({ type: 'askmoji:busy', busy: false }), ctx)).toEqual({
      type: 'askmoji:busy',
      busy: false,
    });
  });

  test('drops extra keys rather than passing them through', () => {
    expect(readAskMojiMessage(from({ type: 'askmoji:ready', extra: 'x' }), ctx)).toEqual({
      type: 'askmoji:ready',
    });
  });

  test('refuses any other origin, including the pages origin itself', () => {
    for (const origin of ['https://evil.example', 'https://pages.classmoji.io', 'null', '']) {
      expect(readAskMojiMessage(from({ type: 'askmoji:ready' }, { origin }), ctx)).toBeNull();
    }
  });

  test('refuses another window on the webapp origin', () => {
    expect(
      readAskMojiMessage(
        from({ type: 'askmoji:request-close' }, { source: { name: 'other' } }),
        ctx
      )
    ).toBeNull();
    expect(
      readAskMojiMessage(from({ type: 'askmoji:request-close' }, { source: null }), ctx)
    ).toBeNull();
  });

  test('believes nothing before the frame exists or without a configured origin', () => {
    const msg = from({ type: 'askmoji:ready' });
    expect(readAskMojiMessage(msg, { webappOrigin: WEBAPP, frameWindow: null })).toBeNull();
    expect(readAskMojiMessage(msg, { webappOrigin: null, frameWindow })).toBeNull();
  });

  test('refuses unknown or malformed shapes', () => {
    for (const data of [
      null,
      undefined,
      'askmoji:ready',
      42,
      [],
      ['askmoji:ready'],
      {},
      { type: 'askmoji:open' },
      { type: 'askmoji:viewing', viewing: { kind: 'page', id: 'p' } },
      { type: 'askmoji:busy' },
      { type: 'askmoji:busy', busy: 'true' },
      { type: 'askmoji:busy', busy: 1 },
      { type: 'classmoji:page-nav', pageId: 'p' },
    ]) {
      expect(readAskMojiMessage(from(data), ctx), JSON.stringify(data)).toBeNull();
    }
  });
});

test.describe('what the frame is told', () => {
  test('a page route views that page; the page list views nothing', () => {
    expect(pageViewing('page-1')).toEqual({ kind: 'page', id: 'page-1' });
    expect(pageViewing(undefined)).toBeNull();
    expect(pageViewing(null)).toBeNull();
    expect(pageViewing('')).toBeNull();
  });

  test('the chip title is the page’s own, from the loader’s page list', () => {
    const pages = [
      { id: 'p1', title: '  Week 1: Loops ' },
      { id: 'p2', title: '' },
      { id: 'p3', title: 'x'.repeat(250) },
    ];
    expect(pageTitle('p1', pages)).toBe('Week 1: Loops');
    expect(pageTitle('p2', pages)).toBeUndefined();
    expect(pageTitle('p3', pages)).toHaveLength(200);
    expect(pageTitle('missing', pages)).toBeUndefined();
    expect(pageTitle(undefined, pages)).toBeUndefined();
  });

  test('the viewing message carries the title only with a viewing', () => {
    expect(viewingMessage({ kind: 'page', id: 'p1' }, 'Week 1')).toEqual({
      type: 'askmoji:viewing',
      viewing: { kind: 'page', id: 'p1' },
      title: 'Week 1',
    });
    expect(viewingMessage({ kind: 'page', id: 'p1' }, '  ')).toEqual({
      type: 'askmoji:viewing',
      viewing: { kind: 'page', id: 'p1' },
    });
    expect(viewingMessage(null, 'Stale')).toEqual({ type: 'askmoji:viewing', viewing: null });
    expect(viewingMessage({ kind: 'page', id: 'p1' }, 'y'.repeat(300))).toMatchObject({
      title: 'y'.repeat(200),
    });
  });

  test('ready brings the frame up to date: viewing first, then open or close', () => {
    expect(syncMessages({ kind: 'page', id: 'p1' }, true)).toEqual([
      { type: 'askmoji:viewing', viewing: { kind: 'page', id: 'p1' } },
      { type: 'askmoji:open' },
    ]);
    expect(syncMessages(null, false)).toEqual([
      { type: 'askmoji:viewing', viewing: null },
      { type: 'askmoji:close' },
    ]);
    expect(syncMessages({ kind: 'page', id: 'p1' }, false, 'Week 1')).toEqual([
      { type: 'askmoji:viewing', viewing: { kind: 'page', id: 'p1' }, title: 'Week 1' },
      { type: 'askmoji:close' },
    ]);
  });

  test('the frame URL is the webapp embed route for this classroom', () => {
    expect(askMojiEmbedUrl(WEBAPP, 'cs52')).toBe('https://classmoji.io/ask-moji/cs52/embed');
    expect(askMojiEmbedUrl(WEBAPP, 'a b/c', 'https://pages.classmoji.io')).toBe(
      'https://classmoji.io/ask-moji/a%20b%2Fc/embed?parentOrigin=https%3A%2F%2Fpages.classmoji.io'
    );
  });

  test('origins come from http(s) URLs only', () => {
    expect(originOf('https://classmoji.io/some/path')).toBe('https://classmoji.io');
    expect(originOf('http://localhost:3070')).toBe('http://localhost:3070');
    expect(originOf('')).toBeNull();
    expect(originOf(undefined)).toBeNull();
    expect(originOf('not a url')).toBeNull();
    expect(originOf('javascript:alert(1)')).toBeNull();
  });
});

test.describe('who gets the launcher', () => {
  const on = {
    acceptedRole: 'STUDENT',
    botEnabled: true,
    triggerRuntime: true,
    webappUrl: 'https://classmoji.io/',
    embedded: false,
  };

  test('an accepted member of an Ask Moji classroom does', () => {
    expect(askMojiHostDecision(on)).toEqual({ enabled: true, origin: 'https://classmoji.io' });
    for (const role of ['OWNER', 'TEACHER', 'ASSISTANT']) {
      expect(askMojiHostDecision({ ...on, acceptedRole: role }).enabled).toBe(true);
    }
  });

  test('a non-member, an anonymous reader or a pending invite does not', () => {
    // `acceptedRole` is the accepted-only lookup: a pending invite reads as null.
    expect(askMojiHostDecision({ ...on, acceptedRole: null })).toEqual({
      enabled: false,
      origin: null,
    });
    expect(askMojiHostDecision({ ...on, acceptedRole: undefined }).enabled).toBe(false);
  });

  test('not inside the webapp reader frame', () => {
    expect(askMojiHostDecision({ ...on, embedded: true })).toEqual({
      enabled: false,
      origin: null,
    });
  });

  test('not when the classroom has Ask Moji off, or another runtime is selected', () => {
    expect(askMojiHostDecision({ ...on, botEnabled: false }).enabled).toBe(false);
    expect(askMojiHostDecision({ ...on, botEnabled: null }).enabled).toBe(false);
    expect(askMojiHostDecision({ ...on, triggerRuntime: false }).enabled).toBe(false);
  });

  test('not without a usable webapp origin', () => {
    for (const webappUrl of [undefined, null, '', 'nope']) {
      expect(askMojiHostDecision({ ...on, webappUrl }).enabled, String(webappUrl)).toBe(false);
    }
  });
});

test.describe('isAskMojiTarget', () => {
  test('true for the launcher, the container and anything inside them', () => {
    const inside = { closest: (sel: string) => (sel === '[data-askmoji]' ? {} : null) };
    const outside = { closest: () => null };
    expect(isAskMojiTarget(inside)).toBe(true);
    expect(isAskMojiTarget(outside)).toBe(false);
    expect(isAskMojiTarget(null)).toBe(false);
    // `window` and `document` have no closest(); an event can target either.
    expect(isAskMojiTarget({})).toBe(false);
  });
});

test.describe('where the host is mounted', () => {
  const LAYOUT = source('../../app/routes/$classroomSlug/route.tsx');
  const SERVER = source('../../app/utils/askMoji.server.ts');

  test('the classroom layout, outside its embedded branch', () => {
    const embeddedBranch = LAYOUT.indexOf('if (isEmbedded || framed) {');
    const embeddedReturnEnd = LAYOUT.indexOf('return (\n    <PagesLayout', embeddedBranch);
    const host = LAYOUT.indexOf('<AskMojiHost');
    expect(embeddedBranch).toBeGreaterThan(0);
    expect(embeddedReturnEnd).toBeGreaterThan(embeddedBranch);
    // Exactly one mount, after the embedded branch has returned.
    expect(LAYOUT.match(/<AskMojiHost/g)).toHaveLength(1);
    expect(host).toBeGreaterThan(embeddedReturnEnd);
    expect(LAYOUT).toContain('{askMojiEnabled && askMojiOrigin && (');
    // The chip title comes from the loader's page list.
    expect(LAYOUT).toContain('title={pageTitle(currentPageId, pages)}');
  });

  test('the loader decides from the session and the classroom row, embedded included', () => {
    expect(LAYOUT).toContain('userId: authData?.userId,');
    expect(LAYOUT).toContain('embedded: isEmbedded,');
    expect(SERVER).toContain('acceptedOnly: true,');
    // The shared parse, never a local `=== 'trigger'` of the variable.
    expect(SERVER).toContain('triggerRuntime: isAskMojiTriggerRuntime(),');
    expect(SERVER).not.toContain('process.env.ASK_MOJI_RUNTIME');
  });

  test("the final say is the webapp's availability rule, asked for accepted members only", () => {
    // Pro, the runtime switch, Trigger, a key and the classroom switch: the
    // same rule the webapp's panel uses, not a copy of it.
    const membership = SERVER.indexOf('await findClassroomRole({');
    const memberGate = SERVER.indexOf('if (!decision.enabled) return DISABLED;', membership);
    const availability = SERVER.indexOf('await ClassmojiService.askMojiSession.askMojiAvailable({');
    expect(membership).toBeGreaterThan(0);
    expect(memberGate).toBeGreaterThan(membership);
    expect(availability).toBeGreaterThan(memberGate);
    expect(SERVER.match(/askMojiAvailable\(/g)).toHaveLength(1);
    expect(SERVER).toContain('classroomId: classroom.id,');
    expect(SERVER).toContain('return availability.available');
    // The cheap checks return before any query.
    const cheap = SERVER.indexOf('return DISABLED;');
    expect(cheap).toBeGreaterThan(SERVER.indexOf('!userId ||'));
    expect(cheap).toBeLessThan(membership);
    expect(SERVER).toContain('classroom.settings?.syllabus_bot_enabled === false ||');
  });

  test('never on the class site, the page render or the forms', () => {
    const root = fileURLToPath(new URL('../../app/', import.meta.url));
    const files = (readdirSync(root, { recursive: true }) as string[]).filter(file =>
      /^(site|forms|render)[/\\].*\.(ts|tsx)$/.test(file)
    );
    expect(files.length).toBeGreaterThan(10);
    for (const file of files) {
      expect(readFileSync(join(root, file), 'utf8'), file).not.toMatch(/askMoji|AskMoji/);
    }
    expect(source('../../app/root.tsx')).not.toMatch(/askMoji|AskMoji/);
  });
});
