import nodeConfig from '@repo/eslint-config/node';
import typescriptConfig from '@repo/eslint-config/typescript';

export default [
  ...nodeConfig,
  ...typescriptConfig,
  {
    ignores: ['dist/**', 'build/**'],
  },
  {
    rules: {
      'no-console': 'off',
      // The import resolver can't follow package-exports-only packages
      // (@classmoji/collab, @classmoji/collab/env) — same accommodation as
      // apps/mcp and apps/webapp; tsc typechecks the real paths.
      'import/no-unresolved': 'off',
    },
  },
  {
    files: ['vitest.config.ts'],
    rules: {
      'import/no-unresolved': 'off',
    },
  },
];
