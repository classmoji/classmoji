import { describe, expect, it } from 'vitest';
import type { DeckJson } from '@classmoji/services/slides';
import {
  parseViewQuery,
  viewTarget,
  viewTokenCookie,
  viewTokenFromCookies,
} from '@classmoji/services/render-contract';
import { viewSigningSecret, DEV_VIEW_SIGNING_SECRET } from '@classmoji/services/render-token';
import { allowRequest, RenderError, renderBackend, within } from '../browser.ts';
import { LruCache } from '../cache.ts';
import { deckIdSet, deckSlideOrder, overflowReport } from '../deckAgent.ts';
import { metaFromHtml, sheetHtml } from '../deckRender.ts';
import { changedSlideIds, deckRenderTool } from '../../tools/render.ts';
import { deckApplyTool } from '../../tools/deck.ts';
import { pageContentApplyTool } from '../../tools/pageContent.ts';
import {
  blockIdSet,
  changedBlockIds,
  chooseChunks,
  chunksOf,
  pageRenderTool,
} from '../../tools/pageRender.ts';

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
        { id: 'b1', html: '<p>b1</p>' },
        { id: 'b2', html: '<p>b2</p>' },
      ],
    },
    { id: 'c', html: '<p>c</p>' },
  ],
} as unknown as DeckJson;

describe('deck order', () => {
  it('lists leaves in deck order with outline indices, containers left out', () => {
    expect(deckSlideOrder(deck)).toEqual([
      { id: 'a', index: '1' },
      { id: 'b1', index: '2.1' },
      { id: 'b2', index: '2.2' },
      { id: 'c', index: '3' },
    ]);
    expect([...deckIdSet(deck)]).toEqual(['a', 'stack', 'b1', 'b2', 'c']);
  });
});

describe('overflowReport', () => {
  it('keeps only overflowing sides and slides, and counts the rest as fitting', () => {
    const measures = new Map([
      ['a', { id: 'a', index: '1', overflow_px: { top: 0, right: 0, bottom: 0, left: 0 } }],
      [
        'c',
        {
          id: 'c',
          index: '3',
          overflow_px: { top: 0, right: 12, bottom: 55, left: 0 },
          element: 'p "long"',
          clipped: [{ element: 'pre', hidden_px: { x: 40, y: 0 } }],
        },
      ],
    ]);
    expect(overflowReport(['a', 'c', 'missing'], measures)).toEqual({
      overflow: [
        { slide_id: 'c', index: '3', overflow_px: { right: 12, bottom: 55 }, element: 'p "long"' },
      ],
      clipped: [{ slide_id: 'c', index: '3', element: 'pre', hidden_px: { x: 40, y: 0 } }],
      fits: 1,
    });
  });
});

describe('changedSlideIds', () => {
  it('collects updated, moved and inserted slides; a new stack shows its children', () => {
    expect(
      changedSlideIds([
        { op: 'update', id: 'a' },
        { op: 'move', id: 'c' },
        { op: 'delete', id: 'gone' },
        { op: 'insert', ids: ['n1', 'st'], children: { st: ['k1', 'k2'] } },
        { op: 'reorder', count: 3 },
        { op: 'update', id: 'a' },
      ])
    ).toEqual(['a', 'c', 'n1', 'k1', 'k2']);
    expect(changedSlideIds(undefined)).toEqual([]);
  });

  it('block ops report the slide holding the block', () => {
    expect(
      changedSlideIds([
        { op: 'block_add', slide: 's1', block_id: 'b1', type: 'html' },
        { op: 'block_update', slide: 's2', block_id: 'b2' },
        { op: 'block_delete', slide: 's1', block_id: 'b1' },
      ])
    ).toEqual(['s1', 's2']);
  });
});

describe('LruCache', () => {
  it('evicts the least recently used entry', () => {
    const cache = new LruCache<number>(2);
    cache.set('a', 1);
    cache.set('b', 2);
    expect(cache.get('a')).toBe(1);
    cache.set('c', 3);
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toBe(1);
    expect(cache.size).toBe(2);
  });
});

describe('render browser gating', () => {
  it('never launches a local browser in production', () => {
    expect(renderBackend({ NODE_ENV: 'production' })).toBeNull();
    expect(renderBackend({ NODE_ENV: 'development' })).toBe('local');
    expect(
      renderBackend({
        NODE_ENV: 'production',
        CLOUDFLARE_ACCOUNT_ID: 'acct',
        CLOUDFLARE_BROWSER_RENDERING_TOKEN: 'tok',
      })
    ).toBe('browser-run');
  });
});

describe('allowRequest (local network guard)', () => {
  const origin = new Set(['100.94.162.93:6510']);
  const publicHost = async () => true;
  const privateHost = async () => false;

  it('lets the render origin through even on a private address', async () => {
    expect(
      await allowRequest('http://100.94.162.93:6510/x', 'document', origin, new Map(), privateHost)
    ).toBe(true);
  });

  it('refuses other private hosts, odd schemes, media and sockets', async () => {
    expect(
      await allowRequest('http://169.254.169.254/latest', 'xhr', origin, new Map(), privateHost)
    ).toBe(false);
    expect(await allowRequest('http://100.94.162.93:7110/', 'image', origin, new Map())).toBe(
      false
    );
    expect(await allowRequest('file:///etc/passwd', 'image', origin, new Map())).toBe(false);
    expect(
      await allowRequest('https://cdn.example.com/v.mp4', 'media', origin, new Map(), publicHost)
    ).toBe(false);
    expect(
      await allowRequest('wss://x.example.com/', 'websocket', origin, new Map(), publicHost)
    ).toBe(false);
  });

  it('allows public hosts and data URLs, resolving each host once', async () => {
    let lookups = 0;
    const counted = async () => {
      lookups += 1;
      return true;
    };
    const verdicts = new Map();
    expect(
      await allowRequest('https://cdn.jsdelivr.net/a.css', 'stylesheet', origin, verdicts, counted)
    ).toBe(true);
    expect(
      await allowRequest('https://cdn.jsdelivr.net/b.js', 'script', origin, verdicts, counted)
    ).toBe(true);
    expect(lookups).toBe(1);
    expect(await allowRequest('data:image/png;base64,AA==', 'image', origin, new Map())).toBe(true);
  });
});

describe('render contract', () => {
  it('only sends the cookie Secure over https', () => {
    expect(viewTokenCookie('http://100.94.162.93:6510', 't').secure).toBe(false);
    expect(viewTokenCookie('https://slides.classmoji.io', 't')).toMatchObject({
      name: 'cm_view',
      domain: 'slides.classmoji.io',
      secure: true,
      httpOnly: true,
    });
    expect(viewTokenFromCookies('a=b; cm_view=123.abc; c=d')).toBe('123.abc');
  });

  it('parses only well-formed targets', () => {
    expect(viewTarget('main', 'live:1.2')).toBe('main:live:1.2');
    expect(viewTarget('preview', null)).toBe('preview:head');
    expect(parseViewQuery(new URL('http://x/?at=main&pin=live:1.2'))).toEqual({
      at: 'main',
      pin: 'live:1.2',
    });
    expect(parseViewQuery(new URL('http://x/?at=other&pin=x'))).toBeNull();
    expect(parseViewQuery(new URL('http://x/?at=main&pin=a|b'))).toBeNull();
  });

  it('uses the dev signing secret only in development and test', () => {
    expect(viewSigningSecret({ NODE_ENV: 'development' })).toBe(DEV_VIEW_SIGNING_SECRET);
    expect(viewSigningSecret({ NODE_ENV: 'production' })).toBeNull();
    expect(
      viewSigningSecret({ NODE_ENV: 'production', CONTENT_SIGNING_SECRET: DEV_VIEW_SIGNING_SECRET })
    ).toBeNull();
    expect(viewSigningSecret({ NODE_ENV: 'production', CONTENT_SIGNING_SECRET: 'real' })).toBe(
      'real'
    );
  });
});

describe('contact sheet markup', () => {
  it('escapes captions and marks overflowing tiles', () => {
    const html = sheetHtml([{ id: '<x>', index: '1', image: 'AAAA', overflow: true }], 700 / 960);
    expect(html).toContain('&lt;x&gt;');
    expect(html).not.toContain('<x>');
    expect(html).toContain('class="over"');
  });
});

describe('tool descriptions stay under 1,500 bytes', () => {
  it.each([deckRenderTool, deckApplyTool])('$name', tool => {
    expect(new TextEncoder().encode(tool.description).length).toBeLessThan(1500);
  });
});

describe('page render helpers', () => {
  it('maps a block box to the chunks it spans', () => {
    expect(chunksOf({ top: 0, bottom: 100 }, 1200)).toEqual([1]);
    expect(chunksOf({ top: 1150, bottom: 1300 }, 1200)).toEqual([1, 2]);
    expect(chunksOf({ top: 2400, bottom: 2401 }, 1200)).toEqual([3]);
  });

  it('chooses chunks from a start, or the ones holding the blocks, capped', () => {
    const layout = {
      height: 5000,
      chunks: 5,
      blocks: [
        { id: 'x', top: 3700, bottom: 3800 },
        { id: 'y', top: 100, bottom: 200 },
      ],
    };
    expect(chooseChunks(layout, { max: 3, byBlocks: false })).toEqual([1, 2, 3]);
    expect(chooseChunks(layout, { start: 4, max: 3, byBlocks: true })).toEqual([4, 5]);
    expect(chooseChunks(layout, { max: 3, byBlocks: true })).toEqual([1, 4]);
    expect(chooseChunks(layout, { max: 1, byBlocks: true })).toEqual([1]);
  });

  it('collects changed block ids from an apply result', () => {
    expect(
      changedBlockIds({
        applied: [
          { op: 'update', id: 'a' },
          { op: 'delete', id: 'gone' },
          { op: 'insert', count: 2, ids: ['n1', 'n2'] },
          { op: 'move', id: 'a' },
          { op: 'insert', count: 1, reminted_ids: [{ from: 'dup', to: 'fresh' }] },
        ],
        inserted_ids: [['late']],
      })
    ).toEqual(['a', 'n1', 'n2', 'fresh', 'late']);
  });

  it('finds every block id in a nested tree', () => {
    expect([
      ...blockIdSet([{ id: 'a', children: [{ id: 'b', children: [{ id: 'c' }] }] }, { id: 'd' }]),
    ]).toEqual(['a', 'b', 'c', 'd']);
  });

  it.each([pageRenderTool, pageContentApplyTool])('$name description < 1,500 bytes', tool => {
    expect(new TextEncoder().encode(tool.description).length).toBeLessThan(1500);
  });
});

describe('deadlines and meta', () => {
  it('within() rejects with a RenderError once the deadline passes', async () => {
    const never = new Promise<never>(() => {});
    await expect(within(never, 20, 'Waiting')).rejects.toBeInstanceOf(RenderError);
    await expect(within(Promise.resolve(3), 1000, 'Quick')).resolves.toBe(3);
  });

  it('reads the deck meta from the served HTML, not the window', () => {
    const meta = { kind: 'deck', version: 'live:2.5', width: 960, height: 700, slides: [] };
    const html = `<body><script type="application/json" id="cm-view-meta">${JSON.stringify(meta)}</script></body>`;
    expect(metaFromHtml(html)).toEqual(meta);
    expect(metaFromHtml('<body></body>')).toBeNull();
    expect(metaFromHtml('<script id="cm-view-meta">{nope</script>')).toBeNull();
  });
});
