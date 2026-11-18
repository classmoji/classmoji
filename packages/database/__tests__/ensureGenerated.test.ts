/**
 * scripts/ensureGenerated.ts (`db:ensure`) in a scratch package directory,
 * with a stand-in for `prisma generate` that writes the entry files.
 */
import { spawn, spawnSync } from 'node:child_process';
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureGenerated, GENERATED_ENTRIES } from '../scripts/ensureGenerated.ts';

const SCRIPT = fileURLToPath(new URL('../scripts/ensureGenerated.ts', import.meta.url));
const VERSIONS = 'prisma@7.10.1 @prisma/client@7.10.1';

let dir: string;
let calls = 0;

const fakeGenerate =
  (ok = true) =>
  () => {
    calls += 1;
    for (const file of GENERATED_ENTRIES) {
      mkdirSync(join(dir, file, '..'), { recursive: true });
      writeFileSync(join(dir, file), `// generated ${calls}\n`);
    }
    return ok;
  };

/** Every file under the scratch dir with its mtime (stamp included). */
function snapshot(): Record<string, number> {
  const out: Record<string, number> = {};
  const walk = (at: string) => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const path = join(at, entry.name);
      if (entry.isDirectory()) walk(path);
      else out[path] = statSync(path).mtimeMs;
    }
  };
  walk(dir);
  return out;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'db-ensure-'));
  writeFileSync(join(dir, 'schema.prisma'), 'model A { id Int @id }\n');
  calls = 0;
  // The cases below read process.env: an image-style opt-out in the shell
  // running the tests must not turn them into skips.
  vi.stubEnv('DB_ENSURE', '');
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

describe('ensureGenerated', () => {
  it('generates when the output is missing, and stamps it', () => {
    expect(ensureGenerated({ dir, versions: VERSIONS, generate: fakeGenerate() })).toBe(
      'generated'
    );
    expect(calls).toBe(1);
    expect(existsSync(join(dir, 'generated/.stamp'))).toBe(true);
  });

  it('skips with DB_ENSURE=off, creating nothing (no lock, no stamp)', () => {
    const env = { DB_ENSURE: 'off' };
    expect(ensureGenerated({ dir, env, versions: VERSIONS, generate: fakeGenerate() })).toBe(
      'skipped'
    );
    expect(calls).toBe(0);
    expect(readdirSync(dir)).toEqual(['schema.prisma']);
  });

  it('generates when forced, even with DB_ENSURE=off', () => {
    const env = { DB_ENSURE: 'off' };
    expect(
      ensureGenerated({ dir, env, force: true, versions: VERSIONS, generate: fakeGenerate() })
    ).toBe('generated');
    expect(calls).toBe(1);
    expect(existsSync(join(dir, 'generated/.stamp'))).toBe(true);
  });

  it('as a script with DB_ENSURE=off: prints the skip and exits 0', () => {
    const run = spawnSync(process.execPath, ['--experimental-strip-types', SCRIPT], {
      env: { ...process.env, DB_ENSURE: 'off' },
      encoding: 'utf8',
    });
    expect(run.status).toBe(0);
    expect(run.stdout.trim()).toBe('[db:ensure] skipped (DB_ENSURE=off)');
  });

  it('does nothing, and changes no file, when up to date', async () => {
    ensureGenerated({ dir, versions: VERSIONS, generate: fakeGenerate() });
    const before = snapshot();
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(ensureGenerated({ dir, versions: VERSIONS, generate: fakeGenerate() })).toBe(
      'up-to-date'
    );
    expect(calls).toBe(1);
    expect(snapshot()).toEqual(before);
  });

  it('generates again when an entry file is missing, the schema or a version changes', () => {
    ensureGenerated({ dir, versions: VERSIONS, generate: fakeGenerate() });
    rmSync(join(dir, GENERATED_ENTRIES[1]));
    expect(ensureGenerated({ dir, versions: VERSIONS, generate: fakeGenerate() })).toBe(
      'generated'
    );
    appendFileSync(join(dir, 'schema.prisma'), 'model B { id Int @id }\n');
    expect(ensureGenerated({ dir, versions: VERSIONS, generate: fakeGenerate() })).toBe(
      'generated'
    );
    expect(
      ensureGenerated({
        dir,
        versions: 'prisma@7.11.0 @prisma/client@7.11.0',
        generate: fakeGenerate(),
      })
    ).toBe('generated');
    expect(calls).toBe(4);
  });

  it('generates when forced, even if up to date', () => {
    ensureGenerated({ dir, versions: VERSIONS, generate: fakeGenerate() });
    expect(
      ensureGenerated({ dir, force: true, versions: VERSIONS, generate: fakeGenerate() })
    ).toBe('generated');
    expect(calls).toBe(2);
  });

  it('writes no stamp, and drops the old one, when the generate fails', () => {
    ensureGenerated({ dir, versions: VERSIONS, generate: fakeGenerate() });
    appendFileSync(join(dir, 'schema.prisma'), '// changed\n');
    expect(() =>
      ensureGenerated({ dir, versions: VERSIONS, generate: fakeGenerate(false) })
    ).toThrow(/generate failed/);
    expect(existsSync(join(dir, 'generated/.stamp'))).toBe(false);
    expect(existsSync(join(dir, 'generated/.lock'))).toBe(false);
    // A generate that exits 0 but leaves an entry out does not count either.
    rmSync(join(dir, 'generated'), { recursive: true });
    expect(() => ensureGenerated({ dir, versions: VERSIONS, generate: () => true })).toThrow(
      /generate failed/
    );
    expect(existsSync(join(dir, 'generated/.stamp'))).toBe(false);
  });

  it('takes over a lock whose owner is gone', () => {
    mkdirSync(join(dir, 'generated/.lock'), { recursive: true });
    writeFileSync(join(dir, 'generated/.lock/pid'), '2147483646');
    expect(ensureGenerated({ dir, versions: VERSIONS, generate: fakeGenerate() })).toBe(
      'generated'
    );
    expect(existsSync(join(dir, 'generated/.lock'))).toBe(false);
  });

  it('runs one generate when two processes start together', async () => {
    const counter = join(dir, 'calls');
    // A slow stand-in generate (300 ms), in two separate Node processes.
    const child = `
      import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
      import { join } from 'node:path';
      const { ensureGenerated, GENERATED_ENTRIES } = await import(${JSON.stringify(SCRIPT)});
      const dir = ${JSON.stringify(dir)};
      const result = ensureGenerated({ dir, versions: ${JSON.stringify(VERSIONS)}, generate: () => {
        appendFileSync(${JSON.stringify(counter)}, 'x');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
        for (const f of GENERATED_ENTRIES) { mkdirSync(join(dir, f, '..'), { recursive: true }); writeFileSync(join(dir, f), ''); }
        return true;
      } });
      console.log(result);`;
    const run = () =>
      new Promise<string>((resolve, reject) => {
        const proc = spawn(process.execPath, [
          '--experimental-strip-types',
          '--input-type=module',
          '-e',
          child,
        ]);
        let out = '';
        proc.stdout.on('data', chunk => (out += chunk));
        proc.on('error', reject);
        proc.on('close', code =>
          code === 0 ? resolve(out.trim()) : reject(new Error(`exit ${code}`))
        );
      });
    const results = await Promise.all([run(), run()]);
    expect(results.sort()).toEqual(['generated', 'up-to-date']);
    expect(readFileSync(counter, 'utf8')).toBe('x');
  }, 20_000);
});
