import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * Vitest config for admin unit tests. Picks up *.test.ts under app/. `~`
 * resolves to app/ as in tsconfig.
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
