import baseConfig from './base.js';
import globals from 'globals';

export default [
  ...baseConfig,
  {
    files: ['**/*.{js,ts}'],
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.es2025,
      },
    },
    rules: {
      'no-process-exit': 'error',
      'no-sync': 'warn',
      'prefer-promises/prefer-await-to-then': 'off',
      'prefer-promises/prefer-await-to-callbacks': 'off',
    },
  },
];
