/**
 * Signature verification seam.
 *
 * Every other module imports `verifyContentUrl` / `cacheControlFor` /
 * `nowSeconds` and the verification types from HERE, never from the
 * implementation. The implementation is `@classmoji/content-signing`, the same
 * package the apps mint with, so a URL is verified by exactly the code that
 * signed it. wrangler bundles the workspace package's TypeScript source
 * directly (its `exports` points at `src/index.ts`).
 */
export * from '@classmoji/content-signing';
