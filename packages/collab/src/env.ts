/**
 * `@classmoji/collab/env` — SERVER-ONLY: where the collab server is and the
 * internal secret, resolved from the environment the same way by every
 * service (collab itself, pages, slides, MCP, hook-station). Not exported
 * from the package root, so the dev secret never lands in a client bundle.
 *
 *  - `COLLAB_URL`             internal HTTP base (server-to-server)
 *  - `COLLAB_WS_URL`          browsers' WebSocket URL (defaults to COLLAB_URL
 *                             with the ws/wss scheme)
 *  - `COLLAB_INTERNAL_SECRET` the `x-collab-secret` value
 *  - `COLLAB_PORT`            devport's port, used only for dev fallbacks
 *
 * Outside production (NODE_ENV !== 'production') the URLs fall back to the
 * local collab server on COLLAB_PORT (7700 + devport id × 10); the secret
 * falls back to the shared dev secret only in development/test. A missing
 * value resolves to null: callers turn live editing off, and the collab
 * server refuses to start without a secret.
 */

type Env = Record<string, string | undefined>;

/** The `x-collab-secret` every side uses outside production when none is set. */
export const DEV_COLLAB_INTERNAL_SECRET = 'classmoji-collab-dev-secret';

/** The collab port when COLLAB_PORT is unset. */
export const DEFAULT_COLLAB_PORT = 7700;

export interface CollabUrls {
  /** Internal HTTP base, e.g. `http://localhost:7710`. No trailing slash. */
  httpUrl: string;
  /** Browser WebSocket URL, e.g. `ws://localhost:7710`. No trailing slash. */
  wsUrl: string;
}

export interface CollabEnv extends CollabUrls {
  secret: string;
}

const isProduction = (env: Env) => env.NODE_ENV === 'production';
const trimSlash = (url: string) => url.trim().replace(/\/+$/, '');

/**
 * The internal secret:
 * - COLLAB_INTERNAL_SECRET when set — except the dev value in production;
 * - else the dev secret, but only when NODE_ENV is 'development' or 'test'
 *   (devport-env.sh also exports it for dev processes that run without
 *   NODE_ENV);
 * - else null (callers refuse to talk to collab / collab refuses to start).
 */
export function resolveCollabInternalSecret(env: Env = process.env): string | null {
  const secret = env.COLLAB_INTERNAL_SECRET?.trim();
  if (secret) return isProduction(env) && secret === DEV_COLLAB_INTERNAL_SECRET ? null : secret;
  return env.NODE_ENV === 'development' || env.NODE_ENV === 'test'
    ? DEV_COLLAB_INTERNAL_SECRET
    : null;
}

/**
 * The collab URLs, or null in production when COLLAB_URL is unset (a
 * WebSocket URL alone is not enough: servers need the HTTP base).
 */
export function resolveCollabUrls(env: Env = process.env): CollabUrls | null {
  const port =
    env.COLLAB_PORT && /^\d+$/.test(env.COLLAB_PORT.trim()) ? env.COLLAB_PORT.trim() : null;
  const httpUrl = env.COLLAB_URL?.trim()
    ? trimSlash(env.COLLAB_URL)
    : isProduction(env)
      ? null
      : `http://localhost:${port ?? DEFAULT_COLLAB_PORT}`;
  if (!httpUrl) return null;
  const wsUrl = env.COLLAB_WS_URL?.trim()
    ? trimSlash(env.COLLAB_WS_URL)
    : httpUrl.replace(/^http(s?):/, 'ws$1:');
  return { httpUrl, wsUrl };
}

/** URLs + secret, or null when any is unavailable (production without env). */
export function resolveCollabEnv(env: Env = process.env): CollabEnv | null {
  const urls = resolveCollabUrls(env);
  const secret = resolveCollabInternalSecret(env);
  return urls && secret ? { ...urls, secret } : null;
}
