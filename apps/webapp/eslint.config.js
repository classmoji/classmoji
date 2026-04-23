import webappConfig from '@repo/eslint-config/webapp';

export default [
  ...webappConfig,
  {
    ignores: [
      'build/**',
      'public/build/**',
      '.cache/**',
      '.react-router/**',
      'playwright-report/**',
      'test-results/**',
      'tests/**',
      'vite.config.js',
    ],
  },
  {
    rules: {
      'import/namespace': 'off',
      'import/named': 'off',
      'import/no-unresolved': 'off',
      'jsx-a11y/click-events-have-key-events': 'off',
      'jsx-a11y/no-static-element-interactions': 'off',
      'jsx-a11y/label-has-associated-control': 'off',
      'jsx-a11y/no-autofocus': 'off',
    },
  },
];
