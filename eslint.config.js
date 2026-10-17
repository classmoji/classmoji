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
      // TypeScript Trigger.dev tasks in the ai-agent submodule: no TS lint
      // there yet (its `npm run typecheck` checks them).
      'apps/ai-agent/src/trigger/**',
    ],
  },
]
