import type { LoaderFunctionArgs } from 'react-router';

/**
 * Liveness probe for fly.toml's http_service check. Without a check a boot
 * crash still reads as a green deploy.
 *
 * On Cloudflare Workers it also says which Worker version answered
 * (`x-worker-version`, from the CF_VERSION_METADATA binding), so the deploy
 * job can tell the new version is live. On Fly there is no such context and
 * the response is unchanged.
 */
export const loader = ({ context }: LoaderFunctionArgs) => {
  const version = context?.cloudflare?.env?.CF_VERSION_METADATA?.id;
  return new Response('ok', {
    status: 200,
    headers: version ? { 'x-worker-version': version } : undefined,
  });
};
