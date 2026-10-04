/**
 * Collab server settings from the environment. Every value has a dev
 * default; production refuses to start without a real internal secret.
 *
 * | env                          | dev default                 | prod default |
 * |------------------------------|-----------------------------|--------------|
 * | COLLAB_PORT                  | 7700 (devport 7700 + id*10) | 7700         |
 * | COLLAB_INTERNAL_SECRET       | DEV_COLLAB_INTERNAL_SECRET  | (required)   |
 * | COLLAB_ALLOWED_ORIGINS       | (none) — plus WEBAPP/PAGES/SLIDES_URL     |
 * | COLLAB_CHECKPOINT_DELAY      | 10s                         | 1m           |
 * | COLLAB_CHECKPOINT_MAX_DELAY  | 30s                         | 4m           |
 */

import { resolveCollabInternalSecret } from '@classmoji/collab/env';

export interface CollabConfig {
  production: boolean;
  internalSecret: string;
  /** Exact origins (scheme://host[:port]) allowed to open a socket. */
  allowedOrigins: Set<string>;
  checkpointDelay: string;
  checkpointMaxDelay: string;
  /** Hocuspocus store debounce (ms) and its ceiling. */
  storeDebounceMs: number;
  storeMaxDebounceMs: number;
  /** How often each connection's access is re-checked (ms). */
  recheckIntervalMs: number;
}

const DURATION = /^\d+[smhdw]$/;

function duration(value: string | undefined, fallback: string, name: string): string {
  const v = value?.trim();
  if (!v) return fallback;
  if (!DURATION.test(v)) throw new Error(`${name} must look like 10s / 1m / 4m, got ${v}`);
  return v;
}

/** `https://a.example/path` → `https://a.example`; junk → null. */
export function originOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url.trim()).origin;
  } catch {
    return null;
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): CollabConfig {
  const production = env.NODE_ENV === 'production';

  // Shared resolution (@classmoji/collab/env): the env value, else the dev
  // secret outside production.
  const secret = resolveCollabInternalSecret(env);
  if (!secret) throw new Error('COLLAB_INTERNAL_SECRET is required in production');

  const allowedOrigins = new Set<string>();
  for (const url of [env.WEBAPP_URL, env.PAGES_URL, env.SLIDES_URL]) {
    const origin = originOf(url);
    if (origin) allowedOrigins.add(origin);
  }
  for (const entry of (env.COLLAB_ALLOWED_ORIGINS ?? '').split(',')) {
    const origin = originOf(entry);
    if (origin) allowedOrigins.add(origin);
  }

  return {
    production,
    internalSecret: secret,
    allowedOrigins,
    checkpointDelay: duration(
      env.COLLAB_CHECKPOINT_DELAY,
      production ? '1m' : '10s',
      'COLLAB_CHECKPOINT_DELAY'
    ),
    checkpointMaxDelay: duration(
      env.COLLAB_CHECKPOINT_MAX_DELAY,
      production ? '4m' : '30s',
      'COLLAB_CHECKPOINT_MAX_DELAY'
    ),
    storeDebounceMs: 2_000,
    storeMaxDebounceMs: 10_000,
    recheckIntervalMs: 60_000,
  };
}
