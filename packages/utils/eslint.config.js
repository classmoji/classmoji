import nodeConfig from '@repo/eslint-config/node';
import typescriptConfig from '@repo/eslint-config/typescript';

export default [
  ...nodeConfig,
  ...typescriptConfig,
  {
    files: ['vitest.config.ts'],
    rules: {
      'import/no-unresolved': 'off',
    },
  },
];
