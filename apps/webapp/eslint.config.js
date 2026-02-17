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
      'vite.config.js',
    ],
  },
  {
    rules: {
      'jsx-a11y/click-events-have-key-events': 'off',
      'jsx-a11y/no-static-element-interactions': 'off',
    },
  },
];
