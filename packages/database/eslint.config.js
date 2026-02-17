import nodeConfig from '@repo/eslint-config/node';
import typescriptConfig from '@repo/eslint-config/typescript';

export default [
  ...nodeConfig,
  ...typescriptConfig,
  {
    ignores: ['migrations/**', 'prisma/generated/**'],
  },
  {
    rules: {
      'no-console': 'off',
    },
  },
];
