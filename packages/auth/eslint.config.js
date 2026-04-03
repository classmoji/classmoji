import nodeConfig from '@repo/eslint-config/node';
import typescriptConfig from '@repo/eslint-config/typescript';

export default [
  ...nodeConfig,
  ...typescriptConfig,
  {
    ignores: ['test-token-refresh.mjs'],
  },
  {
    settings: {
      'import/core-modules': [
        '@classmoji/services',
        '@classmoji/database',
        '@classmoji/utils',
        '@classmoji/tasks',
        'better-auth',
        'better-auth/react',
        'better-auth/client/plugins',
        'better-auth/client',
        'better-auth/plugins',
        'better-auth/adapters/prisma',
      ],
    },
  },
];
