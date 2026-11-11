import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

/**
 * Every workspace, the MCP SDK, the AI SDK, Trigger.dev and better-auth load
 * one zod: the root `node_modules/zod`, on zod 4. A full lockfile
 * regeneration can silently move that root slot back to zod 3 (a dependency
 * that wants zod 3 wins it) and nest zod 4 under each workspace, which still
 * passes every other test. Only `@infisical/sdk` (deploy-time secrets sync in
 * packages/tasks/trigger.config.js) keeps its own zod 3 copy.
 */
const ALLOWED_OTHER_COPIES = new Set(['node_modules/@infisical/sdk/node_modules/zod']);

type LockPackage = { version?: string };
const lock = JSON.parse(
  readFileSync(new URL('../../../../package-lock.json', import.meta.url), 'utf8')
) as { packages: Record<string, LockPackage> };

const zodEntries = Object.entries(lock.packages).filter(
  ([path]) => path === 'node_modules/zod' || path.endsWith('/node_modules/zod')
);
const major = (version: string | undefined) => Number((version ?? '').split('.')[0]);

describe('one zod', () => {
  it('the root node_modules/zod in package-lock.json is zod 4', () => {
    expect(lock.packages['node_modules/zod']?.version).toMatch(/^4\./);
  });

  it('no other copy is installed, apart from the one @infisical/sdk keeps', () => {
    const others = zodEntries
      .filter(([path]) => path !== 'node_modules/zod' && !ALLOWED_OTHER_COPIES.has(path))
      .map(([path, entry]) => `${path} ${entry.version}`);
    expect(others).toEqual([]);
  });

  it('no zod 3 copy is reachable from a workspace', () => {
    const zod3 = zodEntries
      .filter(([path, entry]) => major(entry.version) < 4 && !ALLOWED_OTHER_COPIES.has(path))
      .map(([path]) => path);
    expect(zod3).toEqual([]);
  });

  it('the zod this package loads is the root copy, on zod 4', () => {
    const require = createRequire(import.meta.url);
    const resolved = require.resolve('zod/package.json');
    const root = new URL('../../../../node_modules/zod/package.json', import.meta.url).pathname;
    expect(resolved).toBe(root);
    expect(major((require('zod/package.json') as LockPackage).version)).toBe(4);
  });
});
