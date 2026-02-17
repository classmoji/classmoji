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
    },
  },
];
