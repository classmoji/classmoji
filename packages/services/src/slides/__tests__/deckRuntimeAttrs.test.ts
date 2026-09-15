/**
 * The shared runtime-attr normalizer (issue #361) and its use in the deck op
 * engine. reveal.js layout() writes `style.top` on every section when
 * `center: true`, so a merely-VIEWED deck read back from the DOM used to
 * persist a viewport-dependent pixel value into deck.json — and an agent
 * round-tripping `deck_get` → `deck_apply` used to write it straight back.
 */

import { describe, expect, it } from 'vitest';
import {
  stripDeckRuntimeAttrs,
  stripRuntimeSectionAttrs,
  stripRuntimeStyleProps,
  RUNTIME_SECTION_ATTRS,
  RUNTIME_SECTION_CLASSES,
} from '../deckRuntimeAttrs.ts';
import { applyDeckOps } from '../deckOps.ts';
import type { DeckJson } from '../deckTypes.ts';

describe('stripRuntimeStyleProps', () => {
  it('drops the computed display/top declarations and keeps the author-set ones', () => {
    expect(stripRuntimeStyleProps('display: block; top: 350px; margin: 0;')).toBe('margin: 0;');
  });

  it('returns null when nothing author-set survives (caller drops the attribute)', () => {
    expect(stripRuntimeStyleProps('top: 0px;')).toBeNull();
    expect(stripRuntimeStyleProps('top:12.5px')).toBeNull();
    expect(stripRuntimeStyleProps('  ')).toBeNull();
  });

  it('keeps the parsers’ exact "p1; p2;" join format', () => {
    expect(stripRuntimeStyleProps('color:red;top:1px;background:blue')).toBe(
      'color:red; background:blue;'
    );
  });

  it('leaves author-meaningful properties that merely start similarly', () => {
    expect(stripRuntimeStyleProps('top-margin: 1px; margin-top: 2px;')).toBe(
      'top-margin: 1px; margin-top: 2px;'
    );
    expect(stripRuntimeStyleProps('margin-left: 3px; left: 40px;')).toBe('margin-left: 3px;');
  });

  it("drops the print view's computed left", () => {
    // printview.js:109-110 writes left + top while laying out print pages.
    expect(stripRuntimeStyleProps('left: 40px; top: 12px;')).toBeNull();
  });

  it('never splits inside url(data:…;base64,…) or a quoted value', () => {
    const dataUri = 'background: url(data:image/png;base64,iVBORw0KGgo=); top: 3px;';
    expect(stripRuntimeStyleProps(dataUri)).toBe(
      'background: url(data:image/png;base64,iVBORw0KGgo=);'
    );

    const quoted = 'background-image: url("a;b.png"); top: 3px;';
    expect(stripRuntimeStyleProps(quoted)).toBe('background-image: url("a;b.png");');
  });

  it('round-trips a declaration list byte-identically minus the stripped props', () => {
    const authored = 'background: url(data:image/svg+xml;utf8,<svg/>); color: rgb(1, 2, 3);';
    expect(stripRuntimeStyleProps(`display: block; ${authored} top: 9px;`)).toBe(authored);
  });
});

describe('stripRuntimeSectionAttrs', () => {
  it('removes every runtime attribute Reveal writes on a section', () => {
    const attrs = Object.fromEntries([...RUNTIME_SECTION_ATTRS].map(name => [name, '1']));
    expect(stripRuntimeSectionAttrs(attrs)).toEqual({});
  });

  it('keeps the author-set neighbours of those attributes', () => {
    expect(
      stripRuntimeSectionAttrs({
        'data-index-v': '2',
        'data-start-indexv': '1',
        'data-fragment': '0',
        'data-fragment-index': '3',
        'data-background-color': '#123456',
      })
    ).toEqual({
      'data-start-indexv': '1',
      'data-fragment-index': '3',
      'data-background-color': '#123456',
    });
  });

  it('filters runtime classes, drops hidden/aria-hidden, and leaves author classes', () => {
    const cls = [...RUNTIME_SECTION_CLASSES, 'mine'].join(' ');
    expect(stripRuntimeSectionAttrs({ class: cls, hidden: '', 'aria-hidden': 'true' })).toEqual({
      class: 'mine',
    });
    expect(stripRuntimeSectionAttrs({ class: [...RUNTIME_SECTION_CLASSES].join(' ') })).toEqual({});
  });

  it('does not mutate its input and leaves data-cm-id / data-hidden to the caller', () => {
    const input = { 'data-cm-id': 'abc12345', 'data-hidden': 'true', style: 'top: 1px;' };
    expect(stripRuntimeSectionAttrs(input)).toEqual({
      'data-cm-id': 'abc12345',
      'data-hidden': 'true',
    });
    expect(input.style).toBe('top: 1px;');
  });
});

describe('applyDeckOps — runtime attrs never persist', () => {
  const deck = (): DeckJson => ({
    version: 1,
    theme: 'white',
    codeTheme: 'github',
    slides: [{ id: 'a', html: '<p>a</p>' }],
  });

  it('strips the computed top from an update op, keeping the author-set rest', () => {
    const { deck: out } = applyDeckOps(deck(), [
      {
        op: 'update',
        id: 'a',
        attrs: { style: 'top: 350px; background-color: red;', 'data-index-h': '0' },
      },
    ]);
    expect(out.slides[0].attrs).toEqual({ style: 'background-color: red;' });
  });

  it('drops attrs entirely when a round-tripped record held nothing but runtime paint', () => {
    const { deck: out } = applyDeckOps(deck(), [
      { op: 'update', id: 'a', attrs: { style: 'top: 350px;', 'data-previous-indexv': '0' } },
    ]);
    expect(out.slides[0].attrs).toBeUndefined();
  });

  it('keeps a data-URI background intact while stripping the paint around it', () => {
    // deck_apply is a NEW surface for the style splitter — a naive split on
    // every ';' would inject a space into the base64 payload.
    const style = 'background: url(data:image/png;base64,iVBORw0KGgo=);';
    const { deck: out } = applyDeckOps(deck(), [
      { op: 'update', id: 'a', attrs: { style: `top: 350px; ${style}` } },
    ]);
    expect(out.slides[0].attrs).toEqual({ style });
  });

  it('strips them on inserted slides and stack containers too', () => {
    const { deck: out } = applyDeckOps(deck(), [
      {
        op: 'insert',
        position: { at: 'end' },
        slides: [
          { html: '<p>b</p>', attrs: { style: 'top: 4px; color: red;' } },
          {
            attrs: { style: 'top: 0px;', class: 'stack' },
            children: [{ html: '<p>c</p>', attrs: { style: 'top: 9px;' } }],
          },
        ],
      },
    ]);
    expect(out.slides[1].attrs).toEqual({ style: 'color: red;' });
    expect(out.slides[2].attrs).toBeUndefined();
    expect(out.slides[2].children![0].attrs).toBeUndefined();
  });
});

describe('stripDeckRuntimeAttrs', () => {
  const stale: DeckJson = {
    version: 1,
    theme: 'white',
    codeTheme: 'github',
    slides: [
      { id: 'a', html: '<p>a</p>', attrs: { style: 'top: 350px; margin: 0;' } },
      {
        id: 'b',
        attrs: { class: 'stack has-dark-background', style: 'top: 0px;' },
        children: [{ id: 'c', html: '<p>c</p>', attrs: { 'data-index-v': '1' } }],
      },
    ],
  };

  it('cleans every slide, stack containers and their children included', () => {
    expect(stripDeckRuntimeAttrs(stale).slides).toEqual([
      { id: 'a', html: '<p>a</p>', attrs: { style: 'margin: 0;' } },
      { id: 'b', children: [{ id: 'c', html: '<p>c</p>' }] },
    ]);
  });

  it('carries deck-level meta through untouched and never mutates the input', () => {
    const before = JSON.stringify(stale);
    const out = stripDeckRuntimeAttrs(stale);
    expect(out.theme).toBe('white');
    expect(out.codeTheme).toBe('github');
    expect(out.version).toBe(1);
    expect(JSON.stringify(stale)).toBe(before);
  });
});
