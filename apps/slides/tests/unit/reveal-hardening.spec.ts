/**
 * Reveal hardening (revealHardening.ts): what Reveal may read from the query
 * string, which messages reach Reveal, the options put back after
 * `initialize`, and the editor's framing check.
 *
 * Runs in the Playwright runner WITHOUT a browser — jsdom stands in for it.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';
// @ts-expect-error -- jsdom ships no type declarations; only the constructor is used.
import { JSDOM } from 'jsdom';
import {
  APP_QUERY_PARAMS,
  REVEAL_LOCKED_OPTIONS,
  installRevealMessageGuard,
  isRevealApiMessage,
  lockRevealAfterInit,
  refuseIfFramedCrossOrigin,
  revealQueryKeys,
  stripRevealQueryConfig,
} from '../../app/utils/revealHardening.ts';

function page(url: string) {
  const dom = new JSDOM('<!doctype html><body></body>', { url });
  return dom.window as unknown as Window & typeof globalThis;
}

/** The query string after the strip, and what Reveal would read from it. */
function stripped(url: string) {
  const win = page(url);
  stripRevealQueryConfig(win);
  return {
    search: win.location.search,
    hash: win.location.hash,
    keys: revealQueryKeys(win.location.search),
  };
}

test.describe('Reveal query config', () => {
  test('reads keys the way Reveal does, anywhere in the query', () => {
    expect(revealQueryKeys('?postMessage=true&a_previewLinks=1&x=a/showNotes=1')).toEqual([
      'postMessage',
      'previewLinks',
      'x',
      'showNotes',
    ]);
    expect(revealQueryKeys('?auto_merged=2')).toEqual(['merged']);
    expect(revealQueryKeys('?_=1')).toEqual([]);
  });

  test('keeps the app’s own parameters and the hash; drops every other key Reveal would read', () => {
    expect(
      stripped(
        'https://slides.test/deck/follow?shareCode=abc&postMessage=true&previewLinks=true&preview=true#/2/1'
      )
    ).toEqual({
      search: '?shareCode=abc&preview=true',
      hash: '#/2/1',
      keys: ['shareCode', 'preview'],
    });
    expect(stripped('https://slides.test/deck?mode=edit&controls=false&embedded=true').search).toBe(
      '?mode=edit'
    );
  });

  test('a key hidden in another parameter’s name is dropped', () => {
    expect(stripped('https://slides.test/deck?foo_postMessage=true&mode=edit').search).toBe(
      '?mode=edit'
    );
  });

  test('a key hidden in an app parameter’s value stays a value', () => {
    const out = stripped('https://slides.test/deck/follow?shareCode=a/postMessage=true');
    expect(out.keys).toEqual(['shareCode']);
    const win = page(`https://slides.test/deck/follow${out.search}`);
    expect(new URL(win.location.href).searchParams.get('shareCode')).toBe('a/postMessage=true');
  });

  test('parameters Reveal reads nothing from stay', () => {
    expect(stripped('https://slides.test/deck?_=1&mode=edit').search).toBe('?_=1&mode=edit');
  });

  test('a harmless query is left exactly as written', () => {
    const win = page(
      'https://slides.test/deck?returnUrl=%2F&auto_merged=2&notice=preview-accepted'
    );
    let replaced = false;
    win.history.replaceState = () => {
      replaced = true;
    };
    stripRevealQueryConfig(win);
    expect(replaced).toBe(false);
    expect(win.location.search).toBe('?returnUrl=%2F&auto_merged=2&notice=preview-accepted');
  });

  test('none of the app’s parameters is a Reveal option', () => {
    const revealOptions = Object.keys(REVEAL_LOCKED_OPTIONS);
    for (const name of APP_QUERY_PARAMS) {
      for (const key of revealQueryKeys(`?${name}=1`)) {
        expect(revealOptions).not.toContain(key);
        expect([
          'controls',
          'help',
          'showNotes',
          'embedded',
          'plugins',
          'view',
          'hash',
        ]).not.toContain(key);
      }
    }
  });
});

test.describe('lockRevealAfterInit', () => {
  function fakeDeck(config: Record<string, unknown>) {
    const calls: Array<Record<string, unknown>> = [];
    return {
      calls,
      getConfig: () => config,
      configure(options: Record<string, unknown>) {
        calls.push(options);
        Object.assign(config, options);
      },
    };
  }

  test('puts the locked options back over a config that lost them', () => {
    const deck = fakeDeck({ postMessage: true, postMessageEvents: false, previewLinks: true });
    lockRevealAfterInit(deck);
    expect(deck.calls).toEqual([{ ...REVEAL_LOCKED_OPTIONS }]);
    expect(deck.getConfig()).toMatchObject(REVEAL_LOCKED_OPTIONS);
  });

  test('leaves a config that holds them alone', () => {
    const deck = fakeDeck({ ...REVEAL_LOCKED_OPTIONS, controls: true });
    lockRevealAfterInit(deck);
    expect(deck.calls).toEqual([]);
  });

  test('the presenter and the editor call it right after initialize', () => {
    for (const file of ['RevealPresenter.tsx', 'RevealSlides.tsx']) {
      const text = readFileSync(
        fileURLToPath(new URL(`../../app/components/${file}`, import.meta.url)),
        'utf8'
      );
      expect(text, file).toMatch(/await deck\.initialize\(\);\s*lockRevealAfterInit\(deck\);/);
    }
  });
});

test.describe('Reveal API messages', () => {
  test('any JSON object with a method key, or Reveal’s namespace, stops at the guard', () => {
    const win = page('https://slides.test/deck');
    installRevealMessageGuard(win);
    const seen: unknown[] = [];
    win.addEventListener('message', (event: MessageEvent) => seen.push(event.data));
    const send = (data: unknown) => win.dispatchEvent(new win.MessageEvent('message', { data }));

    const stopped = [
      JSON.stringify({ method: 'slide', args: [3] }),
      JSON.stringify({ method: ['slide'], args: [3] }),
      JSON.stringify({ method: 0 }),
      JSON.stringify({ method: null }),
      JSON.stringify({ method: { toString: 'x' } }),
      ` ${JSON.stringify({ namespace: 'reveal', eventName: 'slidechanged' })} `,
    ];
    for (const data of stopped) {
      expect(isRevealApiMessage(data), data).toBe(true);
      send(data);
    }
    expect(seen).toEqual([]);

    const passed = [
      { method: 'slide' }, // an object, not a JSON string: Reveal ignores it
      JSON.stringify(['method']),
      JSON.stringify({ event: 'infoDelivery' }),
      'slide:start',
      '{not json',
    ];
    for (const data of passed) send(data);
    expect(seen).toEqual(passed);
  });
});

test.describe('refuseIfFramedCrossOrigin', () => {
  type FakeWindow = { parent: FakeWindow; location: { origin: string } };

  function chain(...origins: string[]): FakeWindow {
    // origins[0] is the top; the last is the page itself.
    let parent: FakeWindow | null = null;
    let win: FakeWindow | null = null;
    for (const origin of origins) {
      const next = { location: { origin } } as FakeWindow;
      next.parent = parent ?? next;
      parent = next;
      win = next;
    }
    return win as FakeWindow;
  }

  function crossOriginParent(win: FakeWindow): FakeWindow {
    const parent = win.parent;
    Object.defineProperty(parent, 'location', {
      get() {
        throw new Error('SecurityError');
      },
    });
    return win;
  }

  const SLIDES = 'https://slides.test';

  test('not framed: false', () => {
    expect(refuseIfFramedCrossOrigin(page(`${SLIDES}/deck`))).toBe(false);
    expect(refuseIfFramedCrossOrigin(chain(SLIDES) as unknown as Window)).toBe(false);
  });

  test('framed by the same origin, all the way up: false', () => {
    expect(refuseIfFramedCrossOrigin(chain(SLIDES, SLIDES, SLIDES) as unknown as Window)).toBe(
      false
    );
  });

  test('framed by another origin: true', () => {
    expect(
      refuseIfFramedCrossOrigin(
        crossOriginParent(chain('https://evil.test', SLIDES)) as unknown as Window
      )
    ).toBe(true);
    expect(
      refuseIfFramedCrossOrigin(chain('https://other.test', SLIDES) as unknown as Window)
    ).toBe(true);
  });

  test('another origin anywhere above, even under a same-origin parent: true', () => {
    expect(
      refuseIfFramedCrossOrigin(chain('https://evil.test', SLIDES, SLIDES) as unknown as Window)
    ).toBe(true);
  });
});
