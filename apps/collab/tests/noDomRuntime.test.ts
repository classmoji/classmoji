/**
 * Collab never loads jsdom, `@blocknote/server-util` or
 * `@classmoji/page-schema/html` at runtime: the runtime import graph from
 * `src/index.ts` (static, lazy and transitive imports, as Node resolves them)
 * holds none of them. The image build runs the same check
 * (`apps/collab/Dockerfile`). Tests may still use `/html` to build fixtures.
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

describe('collab runtime', () => {
  it('imports no DOM (scripts/check-no-dom-runtime.mjs --entry apps/collab/src/index.ts)', () => {
    const run = spawnSync(
      process.execPath,
      ['scripts/check-no-dom-runtime.mjs', '--entry', 'apps/collab/src/index.ts'],
      { cwd: REPO_ROOT, encoding: 'utf8' }
    );
    expect(run.stderr).not.toMatch(/loads a DOM at runtime/);
    expect(run.status).toBe(0);
    expect(run.stdout).toMatch(/no jsdom, @blocknote\/server-util, @classmoji\/page-schema\/html/);
  }, 60_000);
});
