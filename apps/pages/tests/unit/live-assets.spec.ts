/**
 * Assets that arrive on a live page after it loaded (liveAssets.ts): the
 * editor asks for their display URLs on a miss, batched, once per reference.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';

import {
  ASSET_URLS_MAX_REFS,
  createAssetResolver,
  isResolvableRef,
  resolvableAssetRefs,
} from '../../app/utils/liveAssets.ts';

test.describe('which references are asked about', () => {
  test('repo paths and media refs; URLs are already URLs', () => {
    expect(isResolvableRef('pages/lab-1/assets/hero.png')).toBe(true);
    expect(isResolvableRef('media://4b7c')).toBe(true);
    for (const url of [
      'https://example.com/a.png',
      'http://x/y.png',
      'data:image/png;base64,AAAA',
      'blob:https://pages/123',
      '//cdn.example.com/a.png',
      '',
      'x'.repeat(3000),
    ]) {
      expect(isResolvableRef(url), url).toBe(false);
    }
    expect(resolvableAssetRefs(['a.png', 'a.png', 'https://x/y', 3, 'media://m'])).toEqual([
      'a.png',
      'media://m',
    ]);
    expect(resolvableAssetRefs('a.png')).toEqual([]);
  });
});

function fakeFetch(answer: (refs: string[]) => Record<string, string>) {
  const calls: string[][] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const { refs } = JSON.parse(init.body as string) as { refs: string[] };
    calls.push(refs);
    const assets = answer(refs);
    return new Response(JSON.stringify({ assets, srcSets: { [refs[0]]: `${refs[0]} 1x` } }));
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

test.describe('createAssetResolver', () => {
  test('misses in the same moment go out as one request', async () => {
    const { fetchImpl, calls } = fakeFetch(refs =>
      Object.fromEntries(refs.map(ref => [ref, `https://signed/${ref}`]))
    );
    const resolved: unknown[] = [];
    const resolver = createAssetResolver({
      pageId: 'p1',
      fetchImpl,
      delayMs: 1,
      onResolved: r => resolved.push(r),
    });
    const [a, b] = await Promise.all([
      resolver.resolve('pages/a.png'),
      resolver.resolve('media://b'),
    ]);
    expect(a).toBe('https://signed/pages/a.png');
    expect(b).toBe('https://signed/media://b');
    expect(calls).toEqual([['pages/a.png', 'media://b']]);
    expect(resolved).toHaveLength(1);
  });

  test('each reference is asked for once, including one the server cannot sign', async () => {
    const { fetchImpl, calls } = fakeFetch(() => ({}));
    const resolver = createAssetResolver({
      pageId: 'p1',
      fetchImpl,
      delayMs: 1,
      onResolved: () => {},
    });
    expect(await resolver.resolve('pages/gone.png')).toBeNull();
    expect(await resolver.resolve('pages/gone.png')).toBeNull();
    expect(calls).toHaveLength(1);
  });

  test('absolute URLs never reach the server', async () => {
    const { fetchImpl, calls } = fakeFetch(() => ({}));
    const resolver = createAssetResolver({ pageId: 'p', fetchImpl, onResolved: () => {} });
    expect(await resolver.resolve('https://example.com/a.png')).toBeNull();
    expect(calls).toHaveLength(0);
  });

  test('a large burst is split into capped requests', async () => {
    const { fetchImpl, calls } = fakeFetch(() => ({}));
    const resolver = createAssetResolver({
      pageId: 'p',
      fetchImpl,
      delayMs: 1,
      onResolved: () => {},
    });
    await Promise.all(
      Array.from({ length: ASSET_URLS_MAX_REFS + 5 }, (_, i) => resolver.resolve(`a/${i}.png`))
    );
    expect(calls.map(c => c.length)).toEqual([ASSET_URLS_MAX_REFS, 5]);
  });

  test('an unreachable server answers null, it does not throw', async () => {
    const resolver = createAssetResolver({
      pageId: 'p',
      delayMs: 1,
      onResolved: () => {},
      fetchImpl: (async () => {
        throw new TypeError('offline');
      }) as unknown as typeof fetch,
    });
    expect(await resolver.resolve('a.png')).toBeNull();
  });
});

test('the route signs only for an editor, with the loader’s tier and context', () => {
  const route = readFileSync(
    fileURLToPath(new URL('../../app/routes/api.asset-urls/route.ts', import.meta.url)),
    'utf8'
  );
  expect(route).toContain("await assertPageAccess({ request, page, accessType: 'edit' });");
  expect(route).toContain('ClassmojiService.contentDelivery.tierFor({ canEdit: true })');
  expect(route).toContain('resolvableAssetRefs(body.refs).slice(0, ASSET_URLS_MAX_REFS)');
});
