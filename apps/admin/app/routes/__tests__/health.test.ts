/**
 * /health: "ok" with no extra header on Fly (no load context), plus the
 * Worker's version id on Cloudflare (the deploy job's smoke check reads it).
 */
import { describe, expect, it } from 'vitest';
import type { LoaderFunctionArgs } from 'react-router';
import { loader } from '../health/route';

const call = (context: unknown) =>
  loader({ request: new Request('http://x/health'), params: {}, context } as LoaderFunctionArgs);

describe('/health', () => {
  it('is a bare ok on Node', async () => {
    for (const context of [undefined, {}]) {
      const response = call(context);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe('ok');
      expect(response.headers.get('x-worker-version')).toBeNull();
    }
  });

  it('carries the Worker version id on Cloudflare', () => {
    const response = call({
      cloudflare: { env: { CF_VERSION_METADATA: { id: 'v-123' } }, ctx: {} },
    });
    expect(response.headers.get('x-worker-version')).toBe('v-123');
  });
});
