import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';

// Cloudflare builds only (injected by astro.config.mjs; the Fly build has no
// /health). CI's smoke check reads x-worker-version to tell the new version
// is the one answering.
export const prerender = false;

interface VersionMetadata {
  id?: string;
}

export const GET: APIRoute = () => {
  const version = (env as { CF_VERSION_METADATA?: VersionMetadata }).CF_VERSION_METADATA?.id ?? 'unknown';
  return new Response('ok\n', {
    status: 200,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
      'x-worker-version': version,
    },
  });
};
