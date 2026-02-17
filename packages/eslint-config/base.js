import js from '@eslint/js';
import globals from 'globals';
import pluginImport from 'eslint-plugin-import';
import prettier from 'eslint-config-prettier';
import pluginPrettier from 'eslint-plugin-prettier';

export default [
  js.configs.recommended,
  pluginImport.flatConfigs.recommended,
  prettier,

  {
    files: ['**/*.{js,jsx,ts,tsx}'],
    plugins: {
      prettier: pluginPrettier,
    },
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.browser,
        ...globals.es2025,
        ...globals.node,
      },
    },
    settings: {
      'import/resolver': {
        node: {
          extensions: ['.js', '.jsx', '.ts', '.tsx'],
          moduleDirectory: ['node_modules', 'src'],
        },
      },
      'import/external-module-folders': ['node_modules', '../../node_modules'],
      // don't forget if you add a new package to also add it here
      'import/core-modules': [
        '@classmoji/services',
        '@classmoji/database',
        '@classmoji/utils',
        '@classmoji/tasks',
      ],
    },
    rules: {
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      'prettier/prettier': 'error',
    },
  },
  {
    files: ['cypress/**/*.{js,jsx}'],
    languageOptions: {
      globals: { ...globals.browser, cy: 'readonly', Cypress: 'readonly' },
    },
    rules: {
      'no-unused-expressions': 'off',
    },
  },
];
