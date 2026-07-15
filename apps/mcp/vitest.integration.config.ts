import { defineConfig } from 'vitest/config';

/**
 * INTEGRATION test config (plan §8.1 layer 2) — mirrors the apps/ai-agent
 * split-config pattern: real seeded DB, a real spawned server process,
 * generous timeouts, strictly sequential execution (shared port + DB rows).
 *
 * Run with: npx vitest run --config vitest.integration.config.ts
 * Requires: local postgres up (npm run db:start) and seeded (npm run db:seed);
 * DATABASE_URL is read from the repo-root .env when not already set.
 */
export default defineConfig({
  test: {
    include: ['tests/**/*.integration.test.ts'],
    environment: 'node',
    testTimeout: 120_000, // 2 minutes per test (ai-agent convention)
    hookTimeout: 60_000, // server spawn + health poll
    // vitest 4 equivalent of the ai-agent config's `threads: false`:
    // forked processes, run strictly sequentially — tests share a server + DB.
    pool: 'forks',
    fileParallelism: false,
    maxWorkers: 1,
    silent: false,
  },
});
