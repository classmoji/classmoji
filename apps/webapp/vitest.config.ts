import { defineConfig } from 'vitest/config';

/**
 * Vitest config for webapp unit tests.
 *
 * Picks up *.test.ts under app/, leaving the Playwright suites under tests/
 * (which use *.spec.ts) untouched.
 */
export default defineConfig({
  test: {
    include: ['app/**/__tests__/**/*.test.ts', 'app/**/*.test.ts'],
    environment: 'node',
  },
});
