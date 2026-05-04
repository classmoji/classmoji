import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    testTimeout: 30000,
    include: ['tests/**/*.test.ts'],
    reporters: ['default'],
  },
});
