/** Bindings, vars and secrets declared in `wrangler.jsonc`. */
export interface Env {
  /** R2 bucket used as the content cache. */
  CACHE: R2Bucket;
  /**
   * R2 bucket holding large media uploads — the PRIMARY copy, not a cache.
   *
   * Nothing in this Worker ever writes to it: the app uploads over the S3 API
   * and this side only reads. An object missing from here is a 404 and not a
   * cache miss, because there is no origin behind it to pull from.
   */
  MEDIA: R2Bucket;
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
 * Whether the MEDIA bucket is actually bound.
 *
 * Deliberately NOT part of `isConfigured`. Blob and theme delivery do not touch
 * that bucket, and a deploy that lost only the media binding must keep serving
 * them rather than 503ing the whole Worker. What it must not do is fail as a
 * generic 500 from the router's catch, which says nothing an operator can act
 * on — so the media route checks this itself and `/healthz` reports it, which
 * is the one place a missing binding can be seen before a student finds it.
 *
 * The type says `R2Bucket` because `wrangler.jsonc` declares the binding; this
 * is about the deploy where that declaration did not make it to the runtime.
 */
export function hasMediaBinding(env: Env): boolean {
  return Boolean(env.MEDIA);
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
