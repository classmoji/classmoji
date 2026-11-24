/**
 * Collab never loads jsdom, `@blocknote/server-util` or
 * `@classmoji/page-schema/html` at runtime: the runtime import graph from
 * `src/index.ts` (static, lazy and transitive imports, as Node resolves them)
 * holds none of them. The image build runs the same check
 * (`apps/collab/Dockerfile`). Tests may still use `/html` to build fixtures.
 */
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/** Runs the check; resolves with its exit code and output (a failing exit is not an error here). */
function runCheck(): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    execFile(
      process.execPath,
      ['scripts/check-no-dom-runtime.mjs', '--entry', 'apps/collab/src/index.ts'],
      { cwd: REPO_ROOT, encoding: 'utf8' },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
        resolve({ code, stdout, stderr });
      }
    );
  });
}

describe('collab runtime', () => {
  it('imports no DOM (scripts/check-no-dom-runtime.mjs --entry apps/collab/src/index.ts)', async () => {
    const run = await runCheck();
    expect(run.stderr).not.toMatch(/loads a DOM at runtime/);
    expect(run.code).toBe(0);
    expect(run.stdout).toMatch(/no jsdom, @blocknote\/server-util, @classmoji\/page-schema\/html/);
  }, 60_000);
});
