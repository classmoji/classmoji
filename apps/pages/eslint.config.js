import webappConfig from '@repo/eslint-config/webapp';

export default [
  ...webappConfig,
  {
    ignores: [
      'build/**',
      'public/build/**',
      '.cache/**',
      '.react-router/**',
      'server.ts',
      'server/**',
      'vite.config.js',
    ],
  },
  {
    rules: {
      'jsx-a11y/click-events-have-key-events': 'off',
      'jsx-a11y/no-static-element-interactions': 'off',
      'jsx-a11y/no-noninteractive-element-interactions': 'off',
      'jsx-a11y/no-autofocus': 'off',
    },
  },
];
