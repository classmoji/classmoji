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
  /** Bearer secret presented to the token endpoint (secret). */
  CONTENT_WORKER_SHARED_SECRET?: string;
}

/**
 * Fail closed, not loudly: a Worker missing its secrets must still boot and
 * answer /healthz, but it must not serve content.
 */
export function isConfigured(env: Env): boolean {
  return Boolean(
    env.CONTENT_SIGNING_SECRET && env.CONTENT_WORKER_SHARED_SECRET && env.CONTENT_TOKEN_ENDPOINT
  );
}
