import nodeConfig from '@repo/eslint-config/node';
import typescriptConfig from '@repo/eslint-config/typescript';

export default [
  ...nodeConfig,
  ...typescriptConfig,
  {
    // python/.venv is the local team-set solver venv; pip vendors JS into it.
    ignores: ['src/scripts/**', '.trigger/**', 'dist/**', 'build/**', 'python/.venv/**'],
  },
  {
    rules: {
      'no-sync': 'off',
    },
  },
];
