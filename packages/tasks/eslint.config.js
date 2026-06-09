import nodeConfig from '@repo/eslint-config/node';
import typescriptConfig from '@repo/eslint-config/typescript';

export default [
  ...nodeConfig,
  ...typescriptConfig,
  {
    ignores: ['src/scripts/**', '.trigger/**', 'dist/**', 'build/**'],
  },
  {
    rules: {
      'no-sync': 'off',
    },
  },
];
