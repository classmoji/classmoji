/**
 * /health: "ok" with no extra header on Fly (an empty load context), plus the
 * Worker's version id on Cloudflare (the deploy job's smoke check reads it).
 */
import { describe, expect, it } from 'vitest';
import { RouterContextProvider, type LoaderFunctionArgs } from 'react-router';
import { cloudflareContext } from '@classmoji/workers/context';
import { loader } from '../health/route';

// React Router 8 always hands a loader a RouterContextProvider: an empty one
// on Fly, the Worker's (see @classmoji/workers/runtime) on Cloudflare.
const call = (context: RouterContextProvider) =>
  loader({
    request: new Request('http://x/health'),
    url: new URL('http://x/health'),
    pattern: '/health',
    params: {},
    context,
  } as LoaderFunctionArgs);

describe('/health', () => {
  it('is a bare ok on Node', async () => {
    const response = call(new RouterContextProvider());
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('ok');
    expect(response.headers.get('x-worker-version')).toBeNull();
  });

  it('carries the Worker version id on Cloudflare', () => {
    const context = new RouterContextProvider();
    context.set(cloudflareContext, {
      env: { CF_VERSION_METADATA: { id: 'v-123' } },
      ctx: { waitUntil: () => {}, passThroughOnException: () => {} },
    });
    expect(call(context).headers.get('x-worker-version')).toBe('v-123');
  });
});
