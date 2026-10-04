/**
 * `/:slideId/render-view` — the page the MCP's deck_render screenshots.
 *
 * Pure checks: the slide index the driver steps through, the one refusal, the
 * driver script's contract with the MCP, and that the route module exports
 * nothing but its loader (so no server code can reach the client bundle).
 */
import { readFileSync } from 'node:fs';
import { test, expect } from '@playwright/test';
import type { DeckJson } from '@classmoji/services/slides';
import {
  VIEW_API_GLOBAL,
  VIEW_META_ELEMENT_ID,
  VIEW_READY_ATTRIBUTE,
} from '@classmoji/services/render-contract';
import { deckViewSlides, viewRefusal, viewScript } from '../../app/utils/deckView.server.ts';
import * as route from '../../app/routes/$slideId_.render-view/route.tsx';

const deck = {
  version: 1,
  theme: 'white',
  codeTheme: 'github',
  slides: [
    { id: 'a', html: '<h1>A</h1>' },
    {
      id: 'stack',
      html: '',
      children: [
        { id: 'b1', html: '' },
        { id: 'b2', html: '' },
      ],
    },
    { id: 'c', html: '' },
  ],
} as unknown as DeckJson;

test.describe('render-view', () => {
  test('indexes slides as deck_outline does, with Reveal indices', () => {
    expect(deckViewSlides(deck)).toEqual([
      { id: 'a', index: '1', h: 0, v: 0 },
      { id: 'stack', index: '2', h: 1, v: 0 },
      { id: 'b1', index: '2.1', h: 1, v: 0 },
      { id: 'b2', index: '2.2', h: 1, v: 1 },
      { id: 'c', index: '3', h: 2, v: 0 },
    ]);
  });

  test('refuses with one uncached, unindexed 403', async () => {
    const response = viewRefusal();
    expect(response.status).toBe(403);
    expect(await response.text()).toBe('Forbidden');
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(response.headers.get('x-robots-tag')).toContain('noindex');
  });

  test('the driver script raises the ready flag and exposes the API the MCP calls', () => {
    const script = viewScript();
    expect(script).toContain(JSON.stringify(VIEW_READY_ATTRIBUTE));
    expect(script).toContain(JSON.stringify(VIEW_API_GLOBAL));
    expect(script).toContain(JSON.stringify(VIEW_META_ELEMENT_ID));
    // A still frame: transitions and animations jump to their end state.
    expect(script).toContain('transition-duration: 0s !important');
  });

  test('renders the deck standalone, with the draggable-block rules', () => {
    // Outside the slides app there is no global.css: without these rules an
    // .sl-block falls into normal flow and the slide stacks.
    const source = readFileSync(
      new URL('../../app/utils/deckView.server.ts', import.meta.url),
      'utf8'
    );
    expect(source).toMatch(/generateDeckHtml\(deck, \{[^}]*standalone: true/);
  });

  test('the route module exports only its loader', () => {
    expect(Object.keys(route).sort()).toEqual(['loader']);
  });
});
