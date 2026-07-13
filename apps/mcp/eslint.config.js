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
      // The import resolver can't follow package-exports subpaths
      // (@classmoji/auth/server, @modelcontextprotocol/sdk/server/*.js) —
      // same accommodation as apps/webapp; tsc typechecks the real paths.
      'import/no-unresolved': 'off',
    },
  },
];
