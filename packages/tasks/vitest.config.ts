// eslint-disable-next-line import/no-unresolved -- subpath export, resolved at runtime
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/__tests__/**/*.test.ts', 'src/**/*.test.ts'],
    environment: 'node',
  },
});
