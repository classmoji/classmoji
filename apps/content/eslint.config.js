import nodeConfig from '@repo/eslint-config/node';
import typescriptConfig from '@repo/eslint-config/typescript';

export default [
  ...nodeConfig,
  ...typescriptConfig,
  {
    ignores: ['dist/**', '.wrangler/**', 'worker-configuration.d.ts'],
  },
  {
    rules: {
      // Workers logs are the observability story for this service.
      'no-console': 'off',
      // The import resolver can't follow `.ts` specifiers; tsc typechecks them.
      'import/no-unresolved': 'off',
    },
  },
];
