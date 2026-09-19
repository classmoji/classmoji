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
  {
    // The VERIFY seam. The shared config forbids importing the signing package
    // outside the app's one minting choke point, because a signature is the
    // Worker's only proof of entitlement. This file is the other side of that
    // contract: it re-exports the package so every Worker module verifies with
    // exactly the code the apps signed with, and it mints nothing.
    files: ['src/verify.ts'],
    rules: {
      'no-restricted-imports': 'off',
    },
  },
];
