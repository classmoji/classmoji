// Set by astro.config.mjs (vite.define) at build time.
/** True in the Cloudflare Workers build, false in the Fly (Node) build. */
declare const __CF_BUILD__: boolean;
/** The wrangler.jsonc environment of a Cloudflare build ('dev', 'staging'); '' on Fly. */
declare const __SITE_ENV__: string;

// The Workers runtime module. The Node build aliases it to
// src/cloudflare/workers-stub.ts; only the bindings this site reads are typed.
declare module 'cloudflare:workers' {
  export const env: Record<string, unknown>;
}
