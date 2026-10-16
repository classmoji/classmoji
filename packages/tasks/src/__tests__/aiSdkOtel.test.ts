/**
 * Telemetry layer 1: `@ai-sdk/otel` is not installed. Trigger registers AI SDK
 * telemetry at every chat-agent boot whenever `@ai-sdk/otel` can be imported,
 * so it must never be resolvable from this project, which deploys the chat
 * agents (src/private-agents).
 */
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const tasksRoot = join(fileURLToPath(import.meta.url), '../../..');
const repoRoot = join(tasksRoot, '../..');

describe('telemetry layer 1: @ai-sdk/otel is not installed', () => {
  it('does not resolve from packages/tasks', () => {
    expect(JSON.parse(readFileSync(join(tasksRoot, 'package.json'), 'utf8')).name).toBe(
      '@classmoji/tasks'
    );
    const requireFromTasks = createRequire(join(tasksRoot, 'package.json'));
    let code: unknown = null;
    try {
      requireFromTasks.resolve('@ai-sdk/otel');
    } catch (error) {
      code = (error as { code?: unknown }).code;
    }
    // Not "throws": an installed ESM-only package throws a different code.
    expect(code).toBe('MODULE_NOT_FOUND');
  });

  it('is in no node_modules folder Node would search from packages/tasks', () => {
    const found: string[] = [];
    for (let dir = tasksRoot; ; dir = dirname(dir)) {
      const candidate = join(dir, 'node_modules', '@ai-sdk', 'otel');
      if (existsSync(candidate)) found.push(candidate);
      if (dirname(dir) === dir) break;
    }
    expect(found).toEqual([]);
  });

  it('is installed by no workspace in the lockfile', () => {
    const lock = JSON.parse(readFileSync(join(repoRoot, 'package-lock.json'), 'utf8')) as {
      packages?: Record<string, unknown>;
    };
    expect(Object.keys(lock.packages ?? {}).length).toBeGreaterThan(0);
    const installed = Object.keys(lock.packages ?? {}).filter(key =>
      key.endsWith('node_modules/@ai-sdk/otel')
    );
    expect(installed).toEqual([]);
  });
});
