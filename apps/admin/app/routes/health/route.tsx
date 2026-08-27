/**
 * Liveness probe for fly.toml's http_service check. Without a check a boot
 * crash still reads as a green deploy.
 */
export const loader = () => new Response('ok', { status: 200 });
