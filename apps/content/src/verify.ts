/**
 * Signature verification seam.
 *
 * Every other module imports `verifyContentUrl` / `cacheControlFor` /
 * `nowSeconds` and the verification types from HERE, never from the
 * implementation. `@classmoji/content-signing` is the real thing; until it is
 * in this tree, `src/signing-stub.ts` mirrors its contract exactly.
 *
 * The swap is one line:
 *
 *   -export * from './signing-stub.ts';
 *   +export * from '@classmoji/content-signing';
 *
 * ...plus `"@classmoji/content-signing": "*"` in this app's dependencies. The
 * package also exports `parseContentUrl`, `TIER_POLICY`, `signBlobUrl` and
 * friends, which arrive through the same star export. Confirm the swapped
 * import bundles (`wrangler deploy --env staging --dry-run`) BEFORE deleting
 * `src/signing-stub.ts` and the stub-scoped test helpers.
 */
export * from './signing-stub.ts';
