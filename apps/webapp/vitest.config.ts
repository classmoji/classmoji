import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * Vitest config for webapp unit tests.
 *
 * Picks up *.test.ts under app/, leaving the Playwright suites under tests/
 * (which use *.spec.ts) untouched. `~` resolves to app/ as in tsconfig, so a
 * route under test can pull in a small real util rather than mocking it.
 */
export default defineConfig({
  resolve: {
    alias: { '~': fileURLToPath(new URL('./app', import.meta.url)) },
  },
  test: {
    include: ['app/**/__tests__/**/*.test.ts', 'app/**/*.test.ts'],
    environment: 'node',
  },
});
