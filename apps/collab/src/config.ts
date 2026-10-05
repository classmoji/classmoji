/**
 * Collab server settings from the environment. Every value has a dev
 * default; production refuses to start without a real internal secret.
 *
 * | env                          | dev default                 | prod default |
 * |------------------------------|-----------------------------|--------------|
 * | COLLAB_PORT                  | 7700 (devport 7700 + id*10) | 7700         |
 * | COLLAB_INTERNAL_SECRET       | dev secret (dev/test only)  | (required)   |
 * | COLLAB_ALLOWED_ORIGINS       | (none) — plus WEBAPP/PAGES/SLIDES_URL     |
 * | COLLAB_CHECKPOINT_DELAY      | 10s                         | 1m           |
 * | COLLAB_CHECKPOINT_MAX_DELAY  | 30s                         | 4m           |
 */

import { AGENT_TOUCH_EXPIRE_MS } from '@classmoji/collab';

/** = checkpoint.ts CHECKPOINT_NOW_MAX_DELAY (kept here: checkpoint.ts imports this file's types). */
const CHECKPOINT_NOW_MAX_DELAY = '10s';
import { resolveCollabInternalSecret } from '@classmoji/collab/env';

import { CHECKPOINT_WARM_INTERVAL_MS } from './warm.ts';

export interface CollabConfig {
  production: boolean;
  internalSecret: string;
  /** Exact origins (scheme://host[:port]) allowed to open a socket. */
  allowedOrigins: Set<string>;
  checkpointDelay: string;
  checkpointMaxDelay: string;
  /** The "now" key's maxDelay (CHECKPOINT_NOW_MAX_DELAY; tests shorten it). */
  checkpointNowMaxDelay: string;
  /** Hocuspocus store debounce (ms) and its ceiling. */
  storeDebounceMs: number;
  storeMaxDebounceMs: number;
  /** How often each connection's access is re-checked (ms). */
  recheckIntervalMs: number;
  /** An agent session stays in awareness this long after its last op (ms). */
  agentPresenceMs: number;
  /**
   * How often a present agent's awareness state is sent again (ms): well
   * inside the 30-s timeout after which clients drop a state nobody renewed.
   */
  agentRenewMs: number;
  /** How long a batch's `touched` list stays in the agent's state (ms). */
  agentTouchMs: number;
  /**
   * Checkpoint watchdog: how long past a trigger's latest due time (its
   * debounce maxDelay) a row may stay dirty and unvisited before the trigger
   * counts as lost and is re-sent (ms). Covers queueing and the run itself.
   */
  checkpointWatchdogMarginMs: number;
  /**
   * The same for a "now" checkpoint (Save version, last leave), which runs
   * within seconds: short, so a lost one is re-sent while the person who
   * pressed Save version is still waiting (pages give up after 60 s).
   */
  checkpointWatchdogNowMarginMs: number;
  /** Consecutive lost triggers re-sent per classroom before giving up to the sweeper. */
  checkpointWatchdogRetries: number;
  /**
   * Warm-up runs of the checkpoint worker (warm.ts): at most one per
   * classroom per this many ms while a person has a live doc open.
   */
  checkpointWarmIntervalMs: number;
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
  if (!secret) {
    throw new Error(
      'COLLAB_INTERNAL_SECRET must be set (outside development/test), and not to the development value in production'
    );
  }

  // The git worker is the only way edits reach the content repo: a production
  // server that cannot trigger it would buffer edits forever.
  if (production && !env.TRIGGER_SECRET_KEY?.trim()) {
    throw new Error('TRIGGER_SECRET_KEY must be set in production');
  }

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
    checkpointNowMaxDelay: CHECKPOINT_NOW_MAX_DELAY,
    storeDebounceMs: 2_000,
    storeMaxDebounceMs: 10_000,
    recheckIntervalMs: 60_000,
    agentPresenceMs: 60_000,
    agentRenewMs: 10_000,
    agentTouchMs: AGENT_TOUCH_EXPIRE_MS,
    checkpointWatchdogMarginMs: 120_000,
    checkpointWatchdogNowMarginMs: 30_000,
    checkpointWatchdogRetries: 3,
    checkpointWarmIntervalMs: CHECKPOINT_WARM_INTERVAL_MS,
  };
}
