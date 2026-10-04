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
  LOCK_DISCONNECT_GRACE_MS,
  markDisconnected,
  installLockArbiter,
  isConfirmedFor,
  moveSlide,
  setDeckThemes,
  yDocToDeck,
} from '@classmoji/collab';
import type { DeckJson } from '@classmoji/services/slides';

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

function setup() {
  fakeNow = null;
  const remote = deckToYDoc(DECK);
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

  let current = slidesEl.querySelector('section') as HTMLElement;
  const reveal = {
    getSlidesElement: () => slidesEl,
    getRevealElement: () => revealEl,
    getCurrentSlide: () => current,
    getIndices: () => ({ h: 0, v: 0 }),
    on() {},
    off() {},
    sync() {},
    layout() {},
    slide() {},
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
    setCurrent: (id: string) => (current = section(id)),
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

  test('display drops event handlers and script URLs; the stored html is untouched', async () => {
    const t = setup();
    const stored =
      '<p onclick="x()">hi</p><a href=" JavaScript:alert(1)">l</a><img src="/a.png" onerror="y()">';
    (deckSlides(t.remote).get('aaaa0001') as Y.Map<unknown>).set('html', stored);
    const attrs = (deckSlides(t.remote).get('aaaa0001') as Y.Map<unknown>).get(
      'attrs'
    ) as Y.Map<string>;
    attrs.set('onmouseover', 'z()');
    attrs.set('data-background-iframe', 'javascript:alert(2)');
    await tick();
    const el = t.section('aaaa0001');
    expect(el.innerHTML).not.toMatch(/onclick|onerror|javascript/i);
    expect(el.querySelector('img')?.getAttribute('src')).toBe('/a.png');
    expect(el.hasAttribute('onmouseover')).toBe(false);
    expect(el.hasAttribute('data-background-iframe')).toBe(false);
    t.bridge.flushLocal();
    expect(t.session.pending).toBe(0);
    expect(t.remoteHtml('aaaa0001')).toBe(stored);
    t.bridge.destroy();
  });

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
});
