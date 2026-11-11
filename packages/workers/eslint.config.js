import nodeConfig from '@repo/eslint-config/node';
import reactConfig from '@repo/eslint-config/react';
import typescriptConfig from '@repo/eslint-config/typescript';

export default [
  ...nodeConfig,
  ...reactConfig,
  ...typescriptConfig,
  {
    files: ['vitest.config.ts'],
    rules: {
      'import/no-unresolved': 'off',
    },
  },
];
