import { defineConfig } from 'vitest/config';

/**
 * UNIT test config (default — `npm run test`). Fast, no DB, no server.
 * Integration tests (*.integration.test.ts) are excluded here and run via
 * vitest.integration.config.ts (real DB + spawned server).
 */
export default defineConfig({
  test: {
    include: ['src/**/__tests__/**/*.test.ts', 'tests/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/*.integration.test.ts'],
    environment: 'node',
  },
});
