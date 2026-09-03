import { defineConfig } from 'vitest/config';

/**
 * Unit tests only. The Worker's pure parts (routing, signing, key derivation,
 * header policy, token cache) are exercised against fake `env` objects — no
 * miniflare, no network, no R2.
 */
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
