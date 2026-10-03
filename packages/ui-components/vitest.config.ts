import { defineConfig } from 'vitest/config';

/**
 * Unit tests for the parts of this package that are logic rather than markup.
 *
 * `environment: 'node'` is deliberate: the upload client only needs `fetch`,
 * `File`, `Blob` and `AbortSignal`, all of which Node 22 has, and nothing in
 * this suite mounts a component. The components themselves are exercised where
 * they are used, in each app's own suite.
 */
export default defineConfig({
  test: {
    include: ['src/**/__tests__/**/*.test.ts?(x)', 'src/**/*.test.ts?(x)'],
    environment: 'node',
  },
});
