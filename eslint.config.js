// Root ESLint configuration - using shared configs from @repo/eslint-config
import baseConfig from '@repo/eslint-config/base'

export default [
  ...baseConfig,
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/.turbo/**',
      '**/coverage/**',
      '**/public/build/**',
      'packages/database/migrations/**',
    ],
  },
]
