/**
 * The live deck bridge end to end, under jsdom, with two peers on one deck:
 * this editor (the bridge over a Reveal-like DOM) and a remote client (a bare
 * Y.Doc), synced through an in-memory relay. No browser, no collab server.
 *
 * Pinned: an html edit claims the slide's lock and is written only once the
 * claim is confirmed; a remote edit re-renders only slides this editor does
 * not hold; a slide someone else holds is read-only and an edit that slips in
 * is put back; structure (add / delete / move) goes straight to the doc; a
 * delete of a held slide is refused and the slide comes back; attributes and
 * theme sync both ways; notes are the slide's Y.Text.
 */
import { test, expect } from '@playwright/test';
// @ts-expect-error -- jsdom ships no type declarations; only the constructor is used.
import { JSDOM } from 'jsdom';
import * as Y from 'yjs';
import {
  acquireLock,
  deckSlides,
  deckToYDoc,
  getLock,
  insertSlide,
  readSlideConflicts,
  recordSlideConflict,
  LOCK_DISCONNECT_GRACE_MS,
  markDisconnected,
  markReconnected,
  installLockArbiter,
  isConfirmedFor,
  moveSlide,
  setDeckThemes,
  syncDeckIntoYDoc,
  yDocToDeck,
} from '@classmoji/collab';
import type { DeckJson } from '@classmoji/services/slides';

import { lockHolderOf } from '../../app/utils/collab/bridgeDom.ts';
import {
  BRIDGE_ORIGIN,
  DeckBridge,
  type BridgeSession,
  type BridgeUiState,
} from '../../app/utils/collab/DeckBridge.ts';

// ─── jsdom globals the bridge uses ───────────────────────────────────────────

const jsdom = new JSDOM('<!DOCTYPE html><html><body></body></html>', { pretendToBeVisual: true });
const g = globalThis as unknown as Record<string, unknown>;
g.window = jsdom.window;
g.document = jsdom.window.document;
g.MutationObserver = jsdom.window.MutationObserver;
g.Node = jsdom.window.Node;
g.HTMLElement = jsdom.window.HTMLElement;
g.requestAnimationFrame = (cb: () => void) => setTimeout(cb, 0);
g.CSS = { escape: (value: string) => value.replace(/["\\]/g, '\\$&') };

const DECK: DeckJson = {
  version: 1,
  theme: 'white',
  codeTheme: 'github',
  slides: [
    { id: 'aaaa0001', html: '<h1>One</h1>', notes: 'first notes' },
    { id: 'aaaa0002', html: '<h2>Two</h2>' },
    { id: 'aaaa0003', html: '<h2>Three</h2>', attrs: { 'data-background-color': '#fff' } },
    {
      id: 'stack001',
      children: [
        { id: 'aaaa0004', html: '<p>child</p>' },
        { id: 'aaaa0005', html: '<p>child 2</p>' },
      ],
    },
  ],
};

/**
 * This editor's connection. Local updates queue until `ack()` delivers them to
 * the server doc (`remote`, which runs the lock arbiter); the server's updates
 * arrive at once. `pending` counts local updates ever produced since the last ack.
 */
class FakeSession implements BridgeSession {
  readonly doc = new Y.Doc();
  readonly user = { id: 'user-me', name: 'Ada Lovelace', color: '#0090ff' };
  pending = 0;
  ready = true;
  connected = new Set<number>();
  server: Y.Doc | null = null;
  private queue: Uint8Array[] = [];
  private readyListeners = new Set<(ready: boolean) => void>();
  constructor() {
    this.doc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin === 'relay') return;
      this.pending++;
      this.queue.push(update);
    });
  }
  connectedClients() {
    return new Set([this.doc.clientID, ...this.connected]);
  }
  onReady(listener: (ready: boolean) => void) {
    this.readyListeners.add(listener);
    return () => this.readyListeners.delete(listener);
  }
  setCurrentSlide() {}
  /** Deliver everything to the server (whose answers come straight back). */
  ack() {
    const queued = this.queue;
    this.queue = [];
    this.pending = 0;
    for (const update of queued) Y.applyUpdate(this.server as Y.Doc, update, 'relay');
  }
  setReady(ready: boolean) {
    this.ready = ready;
    for (const listener of this.readyListeners) listener(ready);
  }
}

const tick = (ms = 5) => new Promise(resolve => setTimeout(resolve, ms));

const MEDIA_REF = 'media://0b6c9b7e-1c2d-4e5f-8a9b-0c1d2e3f4a5b';
const MEDIA_URL =
  'https://content.test/c/class-1/media/0b6c9b7e-1c2d-4e5f-8a9b-0c1d2e3f4a5b/v.mp4?sig=abc';

let fakeNow: number | null = null;
const clock = () => fakeNow ?? Date.now();

function setup(deck: DeckJson = DECK) {
  fakeNow = null;
  const remote = deckToYDoc(deck);
  installLockArbiter(remote);
  const session = new FakeSession();
  session.server = remote;
  Y.applyUpdate(session.doc, Y.encodeStateAsUpdate(remote), 'relay');
  remote.on('update', (update: Uint8Array, origin: unknown) => {
    if (origin !== 'relay') Y.applyUpdate(session.doc, update, 'relay');
  });
  session.connected.add(remote.clientID);

  const notices: string[] = [];
  const states: BridgeUiState[] = [];
  const themes: Array<{ theme?: string; codeTheme?: string }> = [];
  const bridge = new DeckBridge({
    session,
    mediaScope: { host: 'content.test', classroomId: 'class-1' },
    resolveMedia: async refs =>
      new Map(refs.filter(ref => ref === MEDIA_REF).map(ref => [ref, MEDIA_URL])),
    notify: message => notices.push(message),
    onState: state => states.push(state),
    clock,
  });

  // What RevealSlides does with the initial document in edit mode.
  const parsed = new jsdom.window.DOMParser().parseFromString(
    bridge.initialDocument(),
    'text/html'
  );
  const revealEl = document.createElement('div');
  revealEl.className = 'reveal';
  revealEl.setAttribute('data-theme', 'white');
  revealEl.setAttribute('data-code-theme', 'github');
  const slidesEl = document.createElement('div');
  slidesEl.className = 'slides';
  slidesEl.innerHTML = (parsed.querySelector('.slides') as Element).innerHTML;
  revealEl.appendChild(slidesEl);
  document.body.innerHTML = '';
  document.body.appendChild(revealEl);
  for (const section of Array.from(slidesEl.querySelectorAll('section'))) {
    section.setAttribute('contenteditable', 'true');
    section.classList.add('editing-mode');
  }

  // A Reveal stand-in with Reveal's index semantics: a CACHED current index
  // (stale after slides move until slide() is called), getIndices(el) computed
  // from the DOM (v undefined for a horizontal slide), and slide() that moves
  // the current slide and blurs the editor, as the real one does.
  let current = slidesEl.querySelector('section') as HTMLElement;
  const cached = { h: 0, v: 0 };
  const horizontal = () => Array.from(slidesEl.children) as HTMLElement[];
  const indicesOf = (el: HTMLElement) => {
    const vertical = el.parentElement !== slidesEl;
    const h = Math.max(horizontal().indexOf(vertical ? (el.parentElement as HTMLElement) : el), 0);
    const v = vertical
      ? Array.from((el.parentElement as HTMLElement).children).indexOf(el)
      : undefined;
    return { h, v };
  };
  const slideCalls: Array<[number, number]> = [];
  const reveal = {
    getSlidesElement: () => slidesEl,
    getRevealElement: () => revealEl,
    getCurrentSlide: () => current,
    getIndices: (el?: HTMLElement) => (el ? indicesOf(el) : { ...cached }),
    on() {},
    off() {},
    sync() {},
    layout() {},
    slide(h: number, v = 0) {
      slideCalls.push([h, v]);
      cached.h = h;
      cached.v = v;
      const top = horizontal()[h];
      const kids = top
        ? (Array.from(top.children).filter(c => c.tagName === 'SECTION') as HTMLElement[])
        : [];
      current = kids.length > 0 ? kids[v] : top;
      (document.activeElement as HTMLElement | null)?.blur?.();
    },
  } as unknown as RevealApi;
  bridge.deferOffscreen = false;
  bridge.attach(reveal, {
    setThemes: next => {
      themes.push(next);
      if (next.theme) revealEl.setAttribute('data-theme', next.theme);
      if (next.codeTheme) revealEl.setAttribute('data-code-theme', next.codeTheme);
    },
  });

  const section = (id: string) =>
    slidesEl.querySelector(`section[data-cm-id="${id}"]`) as HTMLElement;
  const remoteHtml = (id: string) =>
    (deckSlides(remote).get(id) as Y.Map<unknown> | undefined)?.get('html');
  const order = () =>
    Array.from(slidesEl.querySelectorAll('section')).map(s => s.getAttribute('data-cm-id'));
  return {
    remote,
    session,
    bridge,
    slidesEl,
    revealEl,
    section,
    remoteHtml,
    order,
    notices,
    states,
    themes,
    setCurrent: (id: string) => {
      current = section(id);
      const at = indicesOf(current);
      cached.h = at.h;
      cached.v = at.v ?? 0;
    },
    cached,
    slideCalls,
    reveal,
  };
}

test.describe('live deck bridge', () => {
  test('renders the live deck without notes and leaves it untouched on attach', () => {
    const t = setup();
    expect(t.order()).toEqual([
      'aaaa0001',
      'aaaa0002',
      'aaaa0003',
      'stack001',
      'aaaa0004',
      'aaaa0005',
    ]);
    expect(t.slidesEl.innerHTML).not.toContain('first notes');
    expect(t.session.pending).toBe(0);
    t.bridge.destroy();
  });

  test('an edit claims the lock and is written only once the server stamps the claim', () => {
    const t = setup();
    t.section('aaaa0002').innerHTML = '<h2>Two, edited</h2>';
    t.bridge.flushLocal();
    // Claimed locally, nothing written: the server has not seen the claim.
    expect(getLock(t.session.doc, 'aaaa0002')?.userId).toBe('user-me');
    expect(isConfirmedFor(getLock(t.session.doc, 'aaaa0002'), t.session.doc.clientID)).toBe(false);
    t.session.ack(); // the claim reaches the server; its stamp comes back
    expect(isConfirmedFor(getLock(t.remote, 'aaaa0002'), t.session.doc.clientID)).toBe(true);
    expect(t.remoteHtml('aaaa0002')).toBe('<h2>Two</h2>');
    t.session.ack(); // the html, written once confirmed
    expect(t.remoteHtml('aaaa0002')).toBe('<h2>Two, edited</h2>');
    expect(t.section('aaaa0002').classList.contains('cm-held')).toBe(true);
    t.section('aaaa0002').innerHTML = '<h2>Two, again</h2>';
    t.bridge.flushLocal();
    t.session.ack();
    expect(t.remoteHtml('aaaa0002')).toBe('<h2>Two, again</h2>');
    t.bridge.destroy();
  });

  test('offline: html waits; back online with the lock taken → put back', () => {
    const t = setup();
    t.section('aaaa0002').innerHTML = '<h2>one</h2>';
    t.bridge.flushLocal();
    t.session.ack();
    t.session.ack();
    expect(t.remoteHtml('aaaa0002')).toBe('<h2>one</h2>');
    t.session.setReady(false);
    t.section('aaaa0002').innerHTML = '<h2>offline edit</h2>';
    t.bridge.flushLocal();
    expect(t.session.pending).toBe(0); // nothing written while offline
    // Meanwhile the server let someone else take the slide over.
    t.remote.getMap('locks').set('aaaa0002', {
      userId: 'other',
      name: 'Grace Hopper',
      color: '#e5484d',
      clientId: t.remote.clientID,
      since: Date.now(),
      lastActive: Date.now(),
    });
    t.session.setReady(true);
    expect(t.section('aaaa0002').innerHTML).toBe('<h2>one</h2>');
    expect(t.section('aaaa0002').getAttribute('contenteditable')).toBe('false');
    t.session.ack();
    expect(t.remoteHtml('aaaa0002')).toBe('<h2>one</h2>');
    t.bridge.destroy();
  });

  test("a lost claim never lands the loser's html", () => {
    const t = setup();
    t.section('aaaa0002').innerHTML = '<h2>mine</h2>';
    t.bridge.flushLocal();
    // Before our claim is confirmed, the arbiter hands the slide to the other client.
    t.remote.transact(() => {
      deckSlides(t.remote);
      t.remote.getMap('locks').set('aaaa0002', {
        userId: 'other',
        name: 'Grace Hopper',
        color: '#e5484d',
        clientId: t.remote.clientID,
        since: Date.now(),
        lastActive: Date.now(),
      });
    });
    t.session.ack();
    t.bridge.flushLocal();
    expect(t.remoteHtml('aaaa0002')).toBe('<h2>Two</h2>');
    expect(t.section('aaaa0002').innerHTML).toBe('<h2>Two</h2>');
    expect(t.section('aaaa0002').getAttribute('contenteditable')).toBe('false');
    expect(t.notices.at(-1)).toBe('Grace Hopper is editing this slide.');
    t.bridge.destroy();
  });

  test('remote html re-renders slides this editor does not hold, never the held one', async () => {
    const t = setup();
    t.section('aaaa0002').innerHTML = '<h2>local</h2>';
    t.bridge.flushLocal();
    t.session.ack();
    t.session.ack();
    (deckSlides(t.remote).get('aaaa0003') as Y.Map<unknown>).set('html', '<h2>Remote three</h2>');
    (deckSlides(t.remote).get('aaaa0002') as Y.Map<unknown>).set('html', '<h2>clobber</h2>');
    await tick();
    expect(t.section('aaaa0003').innerHTML).toBe('<h2>Remote three</h2>');
    expect(t.section('aaaa0002').innerHTML).toBe('<h2>local</h2>');
    t.bridge.destroy();
  });

  test("someone else's slide is read-only; an edit that slips in is put back", async () => {
    const t = setup();
    acquireLock(
      t.remote,
      'aaaa0003',
      { userId: 'other', name: 'Grace Hopper', color: '#e5484d', clientId: t.remote.clientID },
      { now: Date.now() }
    );
    await tick();
    expect(t.section('aaaa0003').getAttribute('contenteditable')).toBe('false');
    expect(t.section('aaaa0003').classList.contains('cm-locked')).toBe(true);
    expect(t.section('aaaa0003').getAttribute('aria-readonly')).toBe('true');
    expect(t.section('aaaa0003').getAttribute('aria-describedby')).toBe('cm-lock-desc-aaaa0003');
    // What RevealSlides asks at init, so the slide is never editable for a frame.
    expect(t.bridge.isEditableSection(t.section('aaaa0003'))).toBe(false);
    expect(t.bridge.isEditableSection(t.section('aaaa0002'))).toBe(true);
    // The toolbar inserts a block into it anyway.
    t.section('aaaa0003').insertAdjacentHTML('beforeend', '<p>sneaky</p>');
    t.bridge.flushLocal();
    expect(t.section('aaaa0003').innerHTML).toBe('<h2>Three</h2>');
    expect(t.remoteHtml('aaaa0003')).toBe('<h2>Three</h2>');
    expect(t.notices).toContain('Grace Hopper is editing this slide.');
    t.bridge.destroy();
  });

  test('structure goes straight into the doc: add, move, new stack', () => {
    const t = setup();
    const added = document.createElement('section');
    added.innerHTML = '<h2>New Slide</h2>';
    t.section('aaaa0001').after(added);
    t.slidesEl.appendChild(t.section('aaaa0002')); // move to the end
    t.bridge.flushLocal();
    t.session.ack();
    const deck = yDocToDeck(t.remote);
    const newId = added.getAttribute('data-cm-id') as string;
    expect(newId).toMatch(/^[0-9a-f]{8}$/);
    expect(deck.slides.map(s => s.id)).toEqual([
      'aaaa0001',
      newId,
      'aaaa0003',
      'stack001',
      'aaaa0002',
    ]);
    expect(deck.slides[1].html).toBe('<h2>New Slide</h2>');
    // No lock was needed for any of it.
    expect(t.remote.getMap('locks').size).toBe(0);
    t.bridge.destroy();
  });

  test('a delete of a slide someone holds is refused and the slide comes back', async () => {
    const t = setup();
    acquireLock(
      t.remote,
      'aaaa0003',
      { userId: 'other', name: 'Grace Hopper', color: '#e5484d', clientId: t.remote.clientID },
      { now: Date.now() }
    );
    await tick();
    t.section('aaaa0003').remove();
    t.section('aaaa0001').remove(); // free: deleted
    t.bridge.flushLocal();
    t.session.ack();
    await tick();
    expect(yDocToDeck(t.remote).slides.map(s => s.id)).toEqual([
      'aaaa0002',
      'aaaa0003',
      'stack001',
    ]);
    expect(t.order()).toEqual(['aaaa0002', 'aaaa0003', 'stack001', 'aaaa0004', 'aaaa0005']);
    expect(t.notices.at(-1)).toBe('Grace Hopper is editing that slide, so it stays.');
    t.bridge.destroy();
  });

  test('remote structure is rendered: insert, move into a stack, delete', async () => {
    const t = setup();
    insertSlide(
      t.remote,
      'bbbb0001',
      { html: '<h2>From afar</h2>' },
      { parent: null, after: 'aaaa0001' }
    );
    moveSlide(t.remote, 'aaaa0003', { parent: 'stack001', after: 'aaaa0004' });
    t.remote.transact(() => deckSlides(t.remote).delete('aaaa0002'));
    await tick();
    expect(t.order()).toEqual([
      'aaaa0001',
      'bbbb0001',
      'stack001',
      'aaaa0004',
      'aaaa0003',
      'aaaa0005',
    ]);
    expect(t.section('bbbb0001').innerHTML).toBe('<h2>From afar</h2>');
    expect(t.section('bbbb0001').getAttribute('contenteditable')).toBe('true');
    // Nothing was echoed back as a local change.
    expect(t.session.pending).toBe(0);
    t.bridge.destroy();
  });

  test('attributes and visibility sync both ways without a lock', async () => {
    const t = setup();
    t.section('aaaa0002').setAttribute('data-background-color', '#123456');
    t.section('aaaa0002').setAttribute('data-hidden', 'true');
    t.bridge.flushLocal();
    t.session.ack();
    const deck = yDocToDeck(t.remote);
    expect(deck.slides[1]).toEqual({
      id: 'aaaa0002',
      html: '<h2>Two</h2>',
      hidden: true,
      attrs: { 'data-background-color': '#123456' },
    });
    const attrs = (deckSlides(t.remote).get('aaaa0003') as Y.Map<unknown>).get(
      'attrs'
    ) as Y.Map<string>;
    attrs.set('data-transition', 'zoom');
    await tick();
    expect(t.section('aaaa0003').getAttribute('data-transition')).toBe('zoom');
    // Reveal's runtime paint is not an edit.
    t.section('aaaa0003').classList.add('present');
    t.section('aaaa0003').setAttribute('style', 'display: block; top: 10px;');
    const before = t.session.pending;
    t.bridge.flushLocal();
    t.session.ack();
    expect(t.session.pending).toBe(before);
    t.bridge.destroy();
  });

  test('theme changes sync both ways with the editor merge rules', async () => {
    const t = setup();
    t.revealEl.setAttribute('data-theme', 'moon');
    t.bridge.flushLocal();
    t.session.ack();
    expect(t.remote.getMap('meta').get('theme')).toBe('moon');
    setDeckThemes(t.remote, { codeTheme: 'monokai' });
    await tick();
    expect(t.themes.at(-1)).toEqual({ theme: 'moon', codeTheme: 'monokai' });
    t.bridge.destroy();
  });

  test('notes are the slide Y.Text; take over a stale slide', async () => {
    const t = setup();
    const text = t.bridge.notesText('aaaa0001');
    expect(text?.toString()).toBe('first notes');
    t.session.doc.transact(() => text?.insert(0, 'NEW '), BRIDGE_ORIGIN);
    t.session.ack();
    expect(yDocToDeck(t.remote).slides[0].notes).toBe('NEW first notes');

    // The other client's lock; they drop (the server marks it).
    acquireLock(
      t.remote,
      'aaaa0003',
      { userId: 'other', name: 'Grace Hopper', color: '#e5484d', clientId: 999 },
      { now: Date.now() }
    );
    markDisconnected(t.remote, [999], Date.now());
    await tick();
    // Within the grace it is still theirs…
    expect(t.states.at(-1)?.locks['aaaa0003']?.canTakeOver).toBe(false);
    expect(t.bridge.takeOver('aaaa0003')).toBe(false);
    // …after it, it may be taken over.
    fakeNow = Date.now() + LOCK_DISCONNECT_GRACE_MS + 1;
    await tick(1100); // the bridge's 1 s tick re-reads idle times
    expect(t.states.at(-1)?.locks['aaaa0003']?.canTakeOver).toBe(true);
    expect(t.bridge.takeOver('aaaa0003')).toBe(true);
    t.session.ack();
    expect(getLock(t.remote, 'aaaa0003')?.userId).toBe('user-me');
    expect(t.section('aaaa0003').getAttribute('contenteditable')).toBe('true');
    t.bridge.destroy();
  });

  test("the overview's rebuild from editable clones keeps a held slide read-only", async () => {
    const t = setup();
    acquireLock(
      t.remote,
      'aaaa0003',
      { userId: 'other', name: 'Grace Hopper', color: '#e5484d', clientId: t.remote.clientID },
      { now: Date.now() }
    );
    await tick();
    // useSlideStructure.syncToDOM: every section replaced by a clone marked editable.
    const clones = Array.from(t.slidesEl.children).map(el => {
      const clone = el.cloneNode(true) as HTMLElement;
      clone.setAttribute('contenteditable', 'true');
      return clone;
    });
    t.slidesEl.innerHTML = '';
    for (const clone of clones.reverse()) t.slidesEl.appendChild(clone);
    t.bridge.flushLocal();
    expect(t.section('aaaa0003').getAttribute('contenteditable')).toBe('false');
    t.bridge.destroy();
  });

  test('navigating (Reveal lazy loading) claims nothing and writes nothing', async () => {
    const t = setup();
    insertSlide(
      t.remote,
      'lazy0001',
      {
        html: '<iframe data-src="https://e.com/x" width="400"></iframe><img alt="" data-src="/a.png">',
      },
      { parent: null, after: 'aaaa0003' }
    );
    await tick();
    const before = t.session.pending;
    for (const el of Array.from(t.section('lazy0001').querySelectorAll('[data-src]'))) {
      el.setAttribute('src', el.getAttribute('data-src') as string);
      el.setAttribute('data-lazy-loaded', '');
      el.removeAttribute('data-src');
    }
    t.bridge.flushLocal();
    expect(t.session.pending).toBe(before);
    expect(t.remote.getMap('locks').size).toBe(0);
    expect(t.notices).toEqual([]);
    t.bridge.destroy();
  });

  test('remote html for an off-screen slide waits until it is shown', async () => {
    const t = setup();
    t.bridge.deferOffscreen = true;
    (deckSlides(t.remote).get('aaaa0003') as Y.Map<unknown>).set('html', '<h2>later</h2>');
    (deckSlides(t.remote).get('aaaa0001') as Y.Map<unknown>).set('html', '<h1>now</h1>');
    await tick();
    expect(t.section('aaaa0001').innerHTML).toBe('<h1>now</h1>'); // on screen
    expect(t.section('aaaa0003').innerHTML).toBe('<h2>Three</h2>');
    // Waiting is not an edit.
    t.bridge.flushLocal();
    expect(t.session.pending).toBe(0);
    t.setCurrent('aaaa0003');
    t.bridge.renderDeferred(['aaaa0003']);
    expect(t.section('aaaa0003').innerHTML).toBe('<h2>later</h2>');
    t.bridge.destroy();
  });

  test('media refs in section attributes play, and are stored as refs', async () => {
    const t = setup();
    insertSlide(
      t.remote,
      'vid00001',
      { html: '<h2>Video bg</h2>', attrs: { 'data-background-video': MEDIA_REF } },
      { parent: null, after: 'aaaa0001' }
    );
    await tick();
    await tick();
    expect(t.section('vid00001').getAttribute('data-background-video')).toBe(MEDIA_URL);
    expect(t.session.pending).toBe(0); // resolving for display is not an edit
    t.section('vid00001').setAttribute('data-background-video-loop', '');
    t.bridge.flushLocal();
    t.session.ack();
    const attrs = (deckSlides(t.remote).get('vid00001') as Y.Map<unknown>).get(
      'attrs'
    ) as Y.Map<string>;
    expect(attrs.get('data-background-video')).toBe(MEDIA_REF);
    expect(attrs.get('data-background-video-loop')).toBe('');
    t.bridge.destroy();
  });

  test('display makes handlers and script URLs inert; the stored html is untouched', async () => {
    const t = setup();
    const stored =
      '<p onclick="x()">hi</p><a href=" JavaScript:alert(1)">l</a><img src="/a.png" onerror="y()">';
    (deckSlides(t.remote).get('aaaa0001') as Y.Map<unknown>).set('html', stored);
    const attrs = (deckSlides(t.remote).get('aaaa0001') as Y.Map<unknown>).get(
      'attrs'
    ) as Y.Map<string>;
    attrs.set('data-background-iframe', 'javascript:alert(2)');
    await tick();
    const el = t.section('aaaa0001');
    expect(el.querySelector('[onclick], [onerror]')).toBeNull();
    expect(el.querySelector('a')?.hasAttribute('href')).toBe(false);
    expect(el.querySelector('img')?.getAttribute('src')).toBe('/a.png');
    expect(el.hasAttribute('data-background-iframe')).toBe(false);
    t.bridge.flushLocal();
    expect(t.session.pending).toBe(0);
    expect(t.remoteHtml('aaaa0001')).toBe(stored);
    t.bridge.destroy();
  });

  test('editing other text on such a slide writes the handlers and links back as authored', async () => {
    const t = setup();
    const button = '<button type="button" onclick="reveal()" class="b">Show</button>';
    const link = '<a href="javascript:void(go(1))" title="t">Go</a>';
    (deckSlides(t.remote).get('aaaa0002') as Y.Map<unknown>).set(
      'html',
      `<h2>Two</h2>${button}${link}`
    );
    const attrs = (deckSlides(t.remote).get('aaaa0002') as Y.Map<unknown>).get(
      'attrs'
    ) as Y.Map<string>;
    attrs.set('data-background-iframe', 'javascript:x');
    t.setCurrent('aaaa0002');
    await tick();
    expect(t.section('aaaa0002').querySelector('[onclick]')).toBeNull();
    // Edit the heading only.
    (t.section('aaaa0002').querySelector('h2') as HTMLElement).textContent = 'Two, edited';
    t.section('aaaa0002').setAttribute('data-transition', 'zoom');
    t.bridge.flushLocal();
    t.session.ack();
    t.session.ack();
    expect(t.remoteHtml('aaaa0002')).toBe(`<h2>Two, edited</h2>${button}${link}`);
    const stored = (deckSlides(t.remote).get('aaaa0002') as Y.Map<unknown>).get(
      'attrs'
    ) as Y.Map<string>;
    expect(stored.get('data-background-iframe')).toBe('javascript:x');
    expect(stored.get('data-transition')).toBe('zoom');
    expect([...stored.keys()].some(k => k.startsWith('data-cm-inert'))).toBe(false);
    t.bridge.destroy();
  });

  test('a conflict notice reaches only the person whose version was kept', async () => {
    const t = setup();
    t.remote.transact(() => {
      recordSlideConflict(t.remote, 'aaaa0002', {
        at: 1,
        sha: 'abc1234',
        html: '<h2>GitHub</h2>',
        holderUserId: 'user-me',
      });
      recordSlideConflict(t.remote, 'aaaa0003', {
        at: 1,
        sha: 'abc1234',
        html: '<h2>x</h2>',
        holderUserId: 'someone-else',
      });
    });
    await tick();
    expect(Object.keys(t.states.at(-1)?.conflicts ?? {})).toEqual(['aaaa0002']);
    t.bridge.dismissConflict('aaaa0002');
    t.session.ack();
    expect(readSlideConflicts(t.remote).has('aaaa0002')).toBe(false);
    expect(t.states.at(-1)?.conflicts).toEqual({});
    t.bridge.destroy();
  });

  test('offline, back within the grace with the lock still ours → the offline edit is written', () => {
    const t = setup();
    t.section('aaaa0002').innerHTML = '<h2>one</h2>';
    t.bridge.flushLocal();
    t.session.ack();
    t.session.ack();
    t.session.setReady(false);
    // The server marks the lock while we are away (grace).
    markDisconnected(t.remote, [t.session.doc.clientID], Date.now());
    t.section('aaaa0002').innerHTML = '<h2>written offline</h2>';
    t.bridge.flushLocal();
    expect(t.session.pending).toBe(0);
    // Back: the server unmarks; the lock (and its stamp) are still ours.
    markReconnected(t.remote, [t.session.doc.clientID]);
    t.session.setReady(true);
    t.session.ack();
    expect(t.remoteHtml('aaaa0002')).toBe('<h2>written offline</h2>');
    t.bridge.destroy();
  });

  test('a remote insert before the current slide: Reveal follows, focus and caret stay', async () => {
    const t = setup();
    const el = t.section('aaaa0003');
    t.setCurrent('aaaa0003'); // third slide: h = 2
    expect(t.cached.h).toBe(2);
    el.setAttribute('tabindex', '-1'); // jsdom focuses only focusable elements
    el.focus();
    const text = el.querySelector('h2')?.firstChild as Text;
    window.getSelection()?.setBaseAndExtent(text, 2, text, 2);
    insertSlide(t.remote, 'newer001', { html: '<p>remote</p>' }, { parent: null, after: null });
    await tick();
    expect(t.order()[0]).toBe('newer001');
    // Reveal points at the same slide's new index (number, hash, arrows follow)…
    expect(t.cached).toEqual({ h: 3, v: 0 });
    expect(t.slideCalls.at(-1)).toEqual([3, 0]);
    // …and the person typing keeps focus and caret.
    expect(document.activeElement).toBe(el);
    const selection = window.getSelection();
    expect(selection?.anchorNode).toBe(text);
    expect(selection?.anchorOffset).toBe(2);
    t.bridge.destroy();
  });

  test('a remote insert after the current slide leaves Reveal alone', async () => {
    const t = setup();
    t.setCurrent('aaaa0002');
    insertSlide(t.remote, 'later001', { html: '<p>end</p>' }, { parent: null, after: 'aaaa0003' });
    await tick();
    expect(t.slideCalls).toEqual([]);
    expect(t.cached).toEqual({ h: 1, v: 0 });
    t.bridge.destroy();
  });

  test('my own lock from a tab that is gone: not shown, picked up by editing the slide', async () => {
    const t = setup();
    // A lock of this same user, from an old client that is not connected.
    acquireLock(
      t.remote,
      'aaaa0003',
      { userId: 'user-me', name: 'Ada Lovelace', color: '#0090ff', clientId: 4242 },
      { now: Date.now() }
    );
    await tick();
    expect(t.states.at(-1)?.locks['aaaa0003']).toBeUndefined();
    expect(t.section('aaaa0003').getAttribute('contenteditable')).toBe('true');
    t.section('aaaa0003').innerHTML = '<h2>Three, mine again</h2>';
    t.bridge.flushLocal();
    t.session.ack(); // the takeover reaches the server and is stamped
    t.session.ack(); // the html, once confirmed
    expect(getLock(t.remote, 'aaaa0003')?.clientId).toBe(t.session.doc.clientID);
    expect(t.remoteHtml('aaaa0003')).toBe('<h2>Three, mine again</h2>');
    t.bridge.destroy();
  });

  test('a holder gone without a mark (server restart) keeps the slide through the grace', async () => {
    const t = setup();
    acquireLock(
      t.remote,
      'aaaa0003',
      { userId: 'other', name: 'Grace Hopper', color: '#e5484d', clientId: 999 },
      { now: Date.now() - 10 * 60_000 } // an old lock, never marked
    );
    await tick();
    expect(t.states.at(-1)?.locks['aaaa0003']?.canTakeOver).toBe(false);
    expect(t.bridge.takeOver('aaaa0003')).toBe(false);
    fakeNow = Date.now() + LOCK_DISCONNECT_GRACE_MS + 1;
    await tick(1100);
    expect(t.states.at(-1)?.locks['aaaa0003']?.canTakeOver).toBe(true);
    t.bridge.destroy();
  });

  test('moving on to another slide releases the first quietly (no revert, no notice)', () => {
    const t = setup();
    const a = t.section('aaaa0002');
    a.innerHTML = '<h2>Two, edited</h2>';
    t.bridge.flushLocal();
    t.session.ack();
    t.session.ack();
    expect(t.remoteHtml('aaaa0002')).toBe('<h2>Two, edited</h2>');
    // Typing in another slide claims it, which releases the first.
    t.section('aaaa0003').innerHTML = '<h2>Three, edited</h2>';
    t.bridge.flushLocal();
    t.session.ack();
    t.session.ack();
    expect(t.notices).toEqual([]);
    expect(a.innerHTML).toBe('<h2>Two, edited</h2>');
    expect(getLock(t.remote, 'aaaa0002')).toBeNull();
    expect(getLock(t.remote, 'aaaa0003')?.clientId).toBe(t.session.doc.clientID);
    expect(t.remoteHtml('aaaa0003')).toBe('<h2>Three, edited</h2>');
    t.bridge.destroy();
  });

  test('remote html waits while a block editor is open on the shown slide', async () => {
    const t = setup();
    t.setCurrent('aaaa0003');
    t.section('aaaa0003').insertAdjacentHTML(
      'beforeend',
      '<div class="sl-block editing"><div class="sl-block-content">open</div></div>'
    );
    t.bridge.flushLocal(); // (the block is new local content: claim + write)
    t.session.ack();
    t.session.ack();
    // Someone else's html for it arrives (e.g. after this person's lock lapsed).
    t.bridge.detach(); // drop our lock so the remote change is renderable
    t.bridge.attach(t.reveal, { setThemes: () => {} });
    (deckSlides(t.remote).get('aaaa0003') as Y.Map<unknown>).set('html', '<h2>remote</h2>');
    await tick();
    expect(t.section('aaaa0003').querySelector('.editing')).not.toBeNull();
    // The editor closes: the waiting change lands on the next tick.
    t.section('aaaa0003').querySelector('.editing')?.classList.remove('editing');
    await tick(1100);
    expect(t.section('aaaa0003').innerHTML).toBe('<h2>remote</h2>');
    t.bridge.destroy();
  });

  test('editing state the browser puts on a section (spellcheck) is never written', async () => {
    const t = setup();
    const el = t.section('aaaa0003');
    el.setAttribute('spellcheck', 'false');
    el.querySelector('h2')!.textContent = 'Three, typed';
    t.bridge.flushLocal();
    t.session.ack();
    t.bridge.flushLocal();
    t.session.ack();
    expect(t.remoteHtml('aaaa0003')).toBe('<h2>Three, typed</h2>');
    expect(yDocToDeck(t.remote).slides[2].attrs).toEqual({ 'data-background-color': '#fff' });
    t.bridge.destroy();
  });

  // The 2026-10-04 incident on the plain collab deck: slide 2555ece5 vanished
  // in a store from the one human tab while two agents inserted, deleted and
  // updated slides. Replayed op for op (as the server writes agent ops:
  // applyDeckOps → syncDeckIntoYDoc), an idle or typing editor writes no
  // structure of its own: a structural delete only ever comes from the person.
  for (const scenario of ['typing on another slide', 'looking at the slide'] as const) {
    test(`agents' inserts, deletes and updates never make the editor delete a slide (${scenario})`, async () => {
      const ids = [
        '2b2add7c',
        '2921d2c5',
        '78e11bed',
        'c415e56f',
        'af2a451d',
        '2555ece5',
        'b04b1299',
        'f4bbbc3c',
        'e7331c5a',
        '45cb7a2c',
        '16ccc7f4',
        'c014a8ee',
        '0015d90e',
        'b3eafff0',
        '54da53d2',
        'a390c720',
        '64fc1606',
        '0c2289ad',
        '12b99831',
        '2d28a89a',
        '74d0b20a',
        'ee2b1736',
        '3c0e8e5b',
        'bed22546',
        'ebcc610a',
        'a44ec2f3',
        '474dc51f',
        '4a7fc6b7',
        'fbfa5627',
        '1d19f9cb',
        '7b9f7ae7',
        '8014c590',
        '2096c193',
        'ab542072',
      ];
      const slide = (id: string, html = `<h2>${id}</h2>`) => ({ id, html });
      const deckOf = (list: Array<{ id: string; html: string }>): DeckJson => ({
        version: 1,
        theme: 'white',
        codeTheme: 'github',
        slides: list,
      });
      let live = ids.map(id => slide(id));
      const t = setup(deckOf(live));
      const mine = scenario === 'typing on another slide' ? '8014c590' : '2555ece5';
      t.setCurrent(mine);
      const el = t.section(mine);
      if (scenario === 'typing on another slide') {
        el.setAttribute('tabindex', '-1');
        el.focus();
        const text = el.querySelector('h2')?.firstChild as Text;
        window.getSelection()?.setBaseAndExtent(text, 2, text, 2);
      }
      const agent = async (next: typeof live) => {
        live = next;
        syncDeckIntoYDoc(t.remote, deckOf(live));
        await tick();
        if (scenario === 'typing on another slide') {
          el.querySelector('h2')!.textContent += 'x';
          await tick();
          t.bridge.flushLocal();
        }
        t.session.ack();
        t.session.ack();
        await tick();
        expect(yDocToDeck(t.remote).slides.map(s => s.id)).toEqual(live.map(s => s.id));
        expect(t.order()).toEqual(live.map(s => s.id));
      };
      const at = (id: string) => live.findIndex(s => s.id === id);
      // v352: teacher 2 appends four.
      await agent([
        ...live,
        ...['56773f87', '7f9c1c42', '494b6d04', 'cdb985de'].map(id => slide(id)),
      ]);
      // v353: teacher 1 inserts two after the second slide.
      await agent([...live.slice(0, 2), slide('8a17fa27'), slide('fa1aeeb3'), ...live.slice(2)]);
      // v354: teacher 1 deletes one of them.
      await agent(live.filter(s => s.id !== 'fa1aeeb3'));
      // v355: teacher 1 appends one; v356: teacher 2 rewrites three.
      await agent([...live, slide('d3a047fa')]);
      await agent(
        live.map(s =>
          ['56773f87', '7f9c1c42', '494b6d04'].includes(s.id) ? slide(s.id, '<h2>new</h2>') : s
        )
      );
      expect(at('2555ece5')).toBeGreaterThan(-1);
      t.bridge.destroy();
    });
  }

  test('Done: flushes and releases the lock', () => {
    const t = setup();
    t.section('aaaa0002').innerHTML = '<h2>bye</h2>';
    t.bridge.flushLocal();
    t.session.ack();
    t.session.ack();
    expect(getLock(t.remote, 'aaaa0002')).not.toBeNull();
    t.bridge.detach();
    t.session.ack();
    expect(getLock(t.remote, 'aaaa0002')).toBeNull();
    expect(t.remoteHtml('aaaa0002')).toBe('<h2>bye</h2>');
    expect(t.bridge.currentDocument()).toContain('<h2>bye</h2>');
    t.bridge.destroy();
  });

  // ─── Fix round: lost updates, Done, per-key attrs, undo ───────────────────

  const GRACE = { userId: 'other', name: 'Grace Hopper', color: '#e5484d' };
  const graceHolds = (t: ReturnType<typeof setup>, id: string) =>
    acquireLock(t.remote, id, { ...GRACE, clientId: t.remote.clientID }, { now: Date.now() });
  const caretIn = (t: ReturnType<typeof setup>, id: string, offset = 1) => {
    t.setCurrent(id);
    const text = t.section(id).querySelector('h2')?.firstChild as Text;
    window.getSelection()?.setBaseAndExtent(text, offset, text, offset);
    return text;
  };
  const setRemote = (t: ReturnType<typeof setup>, id: string, html: string) =>
    (deckSlides(t.remote).get(id) as Y.Map<unknown>).set('html', html);
  const remoteAttrs = (t: ReturnType<typeof setup>, id: string) =>
    yDocToDeck(t.remote).slides.find(s => s.id === id)?.attrs ?? {};

  test("someone else's edits show at once even with my caret resting in their slide", async () => {
    const t = setup();
    graceHolds(t, 'aaaa0002');
    await tick();
    caretIn(t, 'aaaa0002');
    setRemote(t, 'aaaa0002', '<h2>Grace typed</h2>');
    await tick();
    expect(t.section('aaaa0002').innerHTML).toBe('<h2>Grace typed</h2>');
    t.bridge.destroy();
  });

  test('html that waited behind the caret is shown before the slide is claimed; typing never overwrites it', async () => {
    const t = setup();
    caretIn(t, 'aaaa0002');
    // Grace's last edit and her release arrive together: the slide is free
    // when it renders, and the caret is in it, so the html waits.
    t.remote.transact(() => {
      setRemote(t, 'aaaa0002', '<h2>Grace last</h2>');
    });
    await tick();
    expect(t.section('aaaa0002').innerHTML).toBe('<h2>Two</h2>');
    // This person types on the old version: the claim shows Grace's html first.
    t.section('aaaa0002').querySelector('h2')!.textContent = 'Two, stale typing';
    t.bridge.flushLocal();
    expect(t.section('aaaa0002').innerHTML).toBe('<h2>Grace last</h2>');
    expect(t.notices.at(-1)).toBe('This slide just changed. It now shows the latest version.');
    t.session.ack();
    t.session.ack();
    expect(t.remoteHtml('aaaa0002')).toBe('<h2>Grace last</h2>');
    // The next keystroke builds on Grace's version.
    t.section('aaaa0002').querySelector('h2')!.textContent = 'Grace last, mine';
    t.bridge.flushLocal();
    t.session.ack();
    expect(t.remoteHtml('aaaa0002')).toBe('<h2>Grace last, mine</h2>');
    t.bridge.destroy();
  });

  test('taking over renders what the last holder left first', async () => {
    const t = setup();
    acquireLock(t.remote, 'aaaa0003', { ...GRACE, clientId: 999 }, { now: Date.now() });
    markDisconnected(t.remote, [999], Date.now());
    // Off screen, so their last edit waits to be rendered.
    t.bridge.deferOffscreen = true;
    t.setCurrent('aaaa0001');
    setRemote(t, 'aaaa0003', '<h2>Grace left this</h2>');
    await tick();
    expect(t.section('aaaa0003').innerHTML).toBe('<h2>Three</h2>');
    fakeNow = Date.now() + LOCK_DISCONNECT_GRACE_MS + 1;
    expect(t.bridge.takeOver('aaaa0003')).toBe(true);
    expect(t.section('aaaa0003').innerHTML).toBe('<h2>Grace left this</h2>');
    // Typing goes on top of it.
    t.section('aaaa0003').querySelector('h2')!.textContent = 'Grace left this, mine';
    t.bridge.flushLocal();
    t.session.ack();
    t.session.ack();
    expect(t.remoteHtml('aaaa0003')).toBe('<h2>Grace left this, mine</h2>');
    t.bridge.destroy();
  });

  test('a write never lands over doc html this editor has not rendered', () => {
    const t = setup();
    t.section('aaaa0002').innerHTML = '<h2>mine</h2>';
    t.bridge.flushLocal();
    t.session.ack();
    t.session.ack();
    expect(t.remoteHtml('aaaa0002')).toBe('<h2>mine</h2>');
    // The doc moves under the held slide (e.g. the server put a version back).
    setRemote(t, 'aaaa0002', '<h2>server version</h2>');
    t.section('aaaa0002').innerHTML = '<h2>mine, more</h2>';
    t.bridge.flushLocal();
    t.session.ack();
    expect(t.remoteHtml('aaaa0002')).toBe('<h2>server version</h2>');
    expect(t.section('aaaa0002').innerHTML).toBe('<h2>server version</h2>');
    t.bridge.destroy();
  });

  test('attributes are written key by key: a remote key or visibility set meanwhile survives', async () => {
    const t = setup();
    // Local change still in the debounce…
    t.section('aaaa0003').setAttribute('data-transition', 'zoom');
    // …while someone else changes another key and hides the slide.
    const map = deckSlides(t.remote).get('aaaa0003') as Y.Map<unknown>;
    t.remote.transact(() => {
      (map.get('attrs') as Y.Map<string>).set('data-background-color', '#000');
      map.set('hidden', true);
    });
    t.bridge.flushLocal();
    t.session.ack();
    expect(remoteAttrs(t, 'aaaa0003')).toEqual({
      'data-background-color': '#000',
      'data-transition': 'zoom',
    });
    expect(yDocToDeck(t.remote).slides[2].hidden).toBe(true);
    await tick();
    expect(t.section('aaaa0003').getAttribute('data-background-color')).toBe('#000');
    expect(t.section('aaaa0003').getAttribute('data-hidden')).toBe('true');
    // A local removal removes only that key.
    t.section('aaaa0003').removeAttribute('data-transition');
    t.bridge.flushLocal();
    t.session.ack();
    expect(remoteAttrs(t, 'aaaa0003')).toEqual({ 'data-background-color': '#000' });
    t.bridge.destroy();
  });

  test('a theme switch writes only the theme this person changed', async () => {
    const t = setup();
    t.revealEl.setAttribute('data-theme', 'moon');
    setDeckThemes(t.remote, { codeTheme: 'monokai' }); // arrives before the flush
    t.bridge.flushLocal();
    t.session.ack();
    expect(t.remote.getMap('meta').get('theme')).toBe('moon');
    expect(t.remote.getMap('meta').get('codeTheme')).toBe('monokai');
    t.bridge.destroy();
  });

  test('leaving the page writes what is on screen before the lock goes', () => {
    const t = setup();
    t.section('aaaa0002').innerHTML = '<h2>first</h2>';
    t.bridge.flushLocal();
    t.session.ack();
    t.session.ack();
    t.section('aaaa0002').innerHTML = '<h2>typed just before closing</h2>';
    window.dispatchEvent(new jsdom.window.Event('pagehide'));
    t.session.ack();
    expect(t.remoteHtml('aaaa0002')).toBe('<h2>typed just before closing</h2>');
    expect(getLock(t.remote, 'aaaa0002')).toBeNull();
    t.bridge.destroy();
  });

  test('an edit waiting on its claim is still pending (Done must wait for it)', () => {
    const t = setup();
    t.session.setReady(false);
    t.section('aaaa0002').innerHTML = '<h2>offline</h2>';
    t.bridge.flushLocal();
    expect(t.bridge.hasPendingLocal()).toBe(true);
    t.session.setReady(true);
    t.session.ack();
    t.session.ack();
    expect(t.bridge.hasPendingLocal()).toBe(false);
    expect(t.remoteHtml('aaaa0002')).toBe('<h2>offline</h2>');
    t.bridge.destroy();
  });

  test('the overview rebuild is read-only for a held slide before any flush', async () => {
    const t = setup();
    graceHolds(t, 'aaaa0003');
    await tick();
    const clones = Array.from(t.slidesEl.children).map(el => {
      const clone = el.cloneNode(true) as HTMLElement;
      clone.setAttribute('contenteditable', 'true');
      return clone;
    });
    t.slidesEl.innerHTML = '';
    for (const clone of clones) t.slidesEl.appendChild(clone);
    await Promise.resolve(); // the mutation observer's microtask, no debounce
    await Promise.resolve();
    expect(t.section('aaaa0003').getAttribute('contenteditable')).toBe('false');
    t.bridge.destroy();
  });

  test('a held slide names its holder for editor tools, and the name is never stored', async () => {
    const t = setup();
    graceHolds(t, 'aaaa0003');
    await tick();
    expect(lockHolderOf(t.section('aaaa0003'))).toBe('Grace Hopper');
    expect(lockHolderOf(t.section('aaaa0002'))).toBeNull();
    t.section('aaaa0003').setAttribute('data-transition', 'fade');
    t.bridge.flushLocal();
    t.session.ack();
    expect(remoteAttrs(t, 'aaaa0003')).toEqual({
      'data-background-color': '#fff',
      'data-transition': 'fade',
    });
    t.bridge.destroy();
  });

  test('a slide just added gets its id (and notes text) on demand', () => {
    const t = setup();
    const added = document.createElement('section');
    added.innerHTML = '<h2>New</h2>';
    t.section('aaaa0001').after(added);
    const id = t.bridge.ensureSlideId(added);
    expect(id).toMatch(/^[0-9a-f]{8}$/);
    expect(t.bridge.notesText(id)).not.toBeNull();
    t.session.ack();
    expect(yDocToDeck(t.remote).slides[1].id).toBe(id);
    t.bridge.destroy();
  });

  test('undo / redo: my own html edits, one step per flush', () => {
    const t = setup();
    t.section('aaaa0002').innerHTML = '<h2>one</h2>';
    t.bridge.flushLocal();
    t.session.ack();
    t.session.ack();
    t.section('aaaa0002').innerHTML = '<h2>two</h2>';
    t.bridge.flushLocal();
    t.session.ack();
    expect(t.bridge.history('undo')).toBe(true);
    t.session.ack();
    expect(t.remoteHtml('aaaa0002')).toBe('<h2>one</h2>');
    expect(t.section('aaaa0002').innerHTML).toBe('<h2>one</h2>');
    expect(t.bridge.history('undo')).toBe(true);
    t.session.ack();
    expect(t.remoteHtml('aaaa0002')).toBe('<h2>Two</h2>');
    expect(t.bridge.history('redo')).toBe(true);
    t.session.ack();
    expect(t.remoteHtml('aaaa0002')).toBe('<h2>one</h2>');
    expect(t.section('aaaa0002').innerHTML).toBe('<h2>one</h2>');
    // Typing again is still written on top.
    t.section('aaaa0002').innerHTML = '<h2>three</h2>';
    t.bridge.flushLocal();
    t.session.ack();
    expect(t.remoteHtml('aaaa0002')).toBe('<h2>three</h2>');
    t.bridge.destroy();
  });

  test('undo never touches a slide someone else now holds, nor their edit', async () => {
    const t = setup();
    t.section('aaaa0002').innerHTML = '<h2>mine</h2>';
    t.bridge.flushLocal();
    t.session.ack();
    t.session.ack();
    t.bridge.detach(); // Done: our lock goes
    t.session.ack();
    t.bridge.attach(t.reveal, { setThemes: () => {} });
    // Re-attaching starts a new history; make a step again, then lose the slide.
    t.section('aaaa0002').innerHTML = '<h2>mine again</h2>';
    t.bridge.flushLocal();
    t.session.ack();
    t.session.ack();
    t.section('aaaa0003').querySelector('h2')!.textContent = 'elsewhere';
    t.bridge.flushLocal(); // claims slide 3, releasing slide 2
    t.session.ack();
    t.session.ack();
    graceHolds(t, 'aaaa0002');
    setRemote(t, 'aaaa0002', '<h2>Grace</h2>');
    await tick();
    // Undo slide 3's step first (ours), then slide 2's is refused.
    expect(t.bridge.history('undo')).toBe(true);
    t.session.ack();
    expect(t.remoteHtml('aaaa0003')).toBe('<h2>Three</h2>');
    expect(t.bridge.history('undo')).toBe(false);
    expect(t.notices.at(-1)).toBe('Grace Hopper is editing that slide, so that change stays.');
    t.session.ack();
    expect(t.remoteHtml('aaaa0002')).toBe('<h2>Grace</h2>');
    t.bridge.destroy();
  });

  test('undo on a free slide claims it first and runs once the claim is confirmed', async () => {
    const t = setup();
    t.section('aaaa0002').innerHTML = '<h2>mine</h2>';
    t.bridge.flushLocal();
    t.session.ack();
    t.session.ack();
    t.section('aaaa0003').querySelector('h2')!.textContent = 'elsewhere';
    t.bridge.flushLocal(); // releases slide 2
    t.session.ack();
    t.session.ack();
    // Undo slide 3 (held), then slide 2 (free → claim).
    expect(t.bridge.history('undo')).toBe(true);
    t.session.ack();
    expect(t.bridge.history('undo')).toBe(true);
    expect(t.remoteHtml('aaaa0002')).toBe('<h2>mine</h2>'); // not yet: claim pending
    t.session.ack(); // claim confirmed → the undo runs
    t.session.ack();
    expect(t.remoteHtml('aaaa0002')).toBe('<h2>Two</h2>');
    expect(t.section('aaaa0002').innerHTML).toBe('<h2>Two</h2>');
    t.bridge.destroy();
  });

  test('undo restores my attribute change but not a key someone else set since', () => {
    const t = setup();
    t.section('aaaa0002').setAttribute('data-transition', 'zoom');
    t.bridge.flushLocal();
    t.session.ack();
    const attrs = () =>
      (deckSlides(t.remote).get('aaaa0002') as Y.Map<unknown>).get('attrs') as Y.Map<string>;
    attrs().set('data-background-color', '#abc');
    expect(t.bridge.history('undo')).toBe(true);
    t.session.ack();
    expect(remoteAttrs(t, 'aaaa0002')).toEqual({ 'data-background-color': '#abc' });
    t.bridge.destroy();
  });

  test('⌘Z in a slide is the live undo (the native one is prevented)', () => {
    const t = setup();
    t.section('aaaa0002').innerHTML = '<h2>typed</h2>';
    t.bridge.flushLocal();
    t.session.ack();
    t.session.ack();
    const key = new jsdom.window.KeyboardEvent('keydown', {
      key: 'z',
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });
    t.section('aaaa0002').querySelector('h2')!.dispatchEvent(key);
    expect(key.defaultPrevented).toBe(true);
    t.session.ack();
    expect(t.remoteHtml('aaaa0002')).toBe('<h2>Two</h2>');
    // Not in a code editor inside a slide.
    t.section('aaaa0001').insertAdjacentHTML('beforeend', '<div class="cm-editor"><p>x</p></div>');
    const inCode = new jsdom.window.KeyboardEvent('keydown', {
      key: 'z',
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });
    t.section('aaaa0001').querySelector('.cm-editor p')!.dispatchEvent(inCode);
    expect(inCode.defaultPrevented).toBe(false);
    t.bridge.destroy();
  });

  test("notes undo: only my typing, someone else's stays", () => {
    const t = setup();
    const text = t.bridge.notesText('aaaa0001') as Y.Text;
    t.session.doc.transact(() => text.insert(text.length, ' mine'), BRIDGE_ORIGIN);
    t.session.ack();
    const remoteText = (deckSlides(t.remote).get('aaaa0001') as Y.Map<unknown>).get(
      'notes'
    ) as Y.Text;
    remoteText.insert(0, 'THEIRS ');
    expect(text.toString()).toBe('THEIRS first notes mine');
    expect(t.bridge.notesHistory('aaaa0001', 'undo')).toBe(true);
    expect(text.toString()).toBe('THEIRS first notes');
    expect(t.bridge.notesHistory('aaaa0001', 'redo')).toBe(true);
    expect(text.toString()).toBe('THEIRS first notes mine');
    t.bridge.destroy();
  });
});
