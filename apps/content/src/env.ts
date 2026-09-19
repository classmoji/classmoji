/** Bindings, vars and secrets declared in `wrangler.jsonc`. */
export interface Env {
  /** R2 bucket used as the content cache. */
  CACHE: R2Bucket;
  /** Cloudflare Images binding, used for width/format variants. */
  IMAGES: ImagesBinding;
  /** Webapp endpoint that mints short-lived GitHub installation tokens. */
  CONTENT_TOKEN_ENDPOINT: string;
  /** 'staging' | 'production' — surfaced on /healthz only. */
  ENVIRONMENT: string;
  /** HMAC master key for signed URLs (secret). */
  CONTENT_SIGNING_SECRET?: string;
  /**
   * The key CONTENT_SIGNING_SECRET replaced, set only while a rotation is in
   * flight (secret, optional).
   *
   * Verification falls back to it; nothing ever signs with it. It exists
   * because the apps and this Worker pick up a new key at different moments,
   * and because URLs minted under the old key are already in browsers and
   * caches — without this slot every one of them 403s the instant the key
   * changes. Absent is the steady state.
   */
  CONTENT_SIGNING_SECRET_PREVIOUS?: string;
  /** Bearer secret presented to the token endpoint (secret). */
  CONTENT_WORKER_SHARED_SECRET?: string;
}

/**
 * Fail closed, not loudly: a Worker missing its secrets must still boot and
 * answer /healthz, but it must not serve content.
 *
 * The previous-key slot is deliberately not part of this. It is optional by
 * design, and /healthz is unauthenticated: whether a rotation is under way is
 * not something an anonymous request gets to learn.
 */
export function isConfigured(env: Env): boolean {
  return Boolean(
    env.CONTENT_SIGNING_SECRET && env.CONTENT_WORKER_SHARED_SECRET && env.CONTENT_TOKEN_ENDPOINT
  );
}

/**
 * Master secrets to verify against, current first.
 *
 * A whitespace-only value counts as unset. A cleared previous-key slot can
 * easily end up holding a space or a newline, and a Worker that accepted ` `
 * as a master would accept signatures anyone could mint. Values that do survive
 * are passed through verbatim — never trimmed — because the apps sign with the
 * exact bytes Infisical gave them.
 *
 * Empty when the Worker is unconfigured — callers answer 503 before reaching
 * for this, and the signing package refuses an empty list rather than treating
 * a missing key as a bad signature.
 */
export function signingSecrets(env: Env): string[] {
  return [env.CONTENT_SIGNING_SECRET, env.CONTENT_SIGNING_SECRET_PREVIOUS].filter(
    (secret): secret is string => typeof secret === 'string' && secret.trim().length > 0
  );
}
