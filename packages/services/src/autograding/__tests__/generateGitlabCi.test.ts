import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateGitlabCi } from '../generateGitlabCi.ts';

/** Pull the job's script out of the YAML literal block and run it with bash. */
function runScript(yaml: string, env: Record<string, string> = {}) {
  const lines = yaml.split('\n');
  const start = lines.indexOf('    - |') + 1;
  const body = lines
    .slice(start)
    .map(l => (l.startsWith('      ') ? l.slice(6) : l))
    .join('\n');
  const dir = mkdtempSync(join(tmpdir(), 'ci-'));
  const file = join(dir, 'job.sh');
  writeFileSync(file, body);
  try {
    const out = execFileSync('bash', [file], {
      env: {
        ...process.env,
        CI_PROJECT_PATH: 'cs/c1/hw1-alice',
        CI_COMMIT_SHA: 'abc',
        CI_PIPELINE_ID: '7',
        ...env,
      },
      encoding: 'utf8',
    });
    return { code: 0, out };
  } catch (error: unknown) {
    const e = error as { status: number; stdout: string };
    return { code: e.status, out: e.stdout };
  }
}

const decode = (b64: string) => JSON.parse(Buffer.from(b64, 'base64').toString('utf8')).status;

describe('generateGitlabCi', () => {
  it('runs command and IO tests with the same pass/fail semantics as the Github graders', () => {
    const yaml = generateGitlabCi([
      { name: 'passes', method: 'COMMAND', run_command: 'true' },
      { name: 'fails', method: 'COMMAND', run_command: 'exit 3' },
      {
        name: 'io included',
        method: 'IO',
        run_command: 'cat',
        input: 'hello world',
        expected_output: 'world',
        comparison_method: 'INCLUDED',
      },
      {
        name: 'io exact',
        method: 'IO',
        run_command: 'tr a-z A-Z',
        input: "it's",
        expected_output: "IT'S",
        comparison_method: 'EXACT',
      },
      {
        name: 'io regex',
        method: 'IO',
        run_command: 'cat',
        input: 'n=42',
        expected_output: '^n=[0-9]+$',
        comparison_method: 'REGEX',
      },
      {
        name: 'multi\nline',
        method: 'IO',
        run_command: 'cat',
        input: 'a\nb',
        expected_output: 'a\nb',
        comparison_method: 'EXACT',
      },
      { name: 'setup fails', method: 'PYTHON', setup_command: 'false', run_command: 'true' },
    ]);
    const { code, out } = runScript(yaml);
    expect(code).toBe(1); // a failing test fails the job
    const statuses = [...out.matchAll(/\[classmoji\] (\S+): (pass|fail)/g)].map(m => m[2]);
    expect(statuses).toEqual(['pass', 'fail', 'pass', 'pass', 'pass', 'pass', 'fail']);
  });

  it('builds a report payload the ingest task reads', () => {
    const yaml = generateGitlabCi([{ name: 'say "hi"', method: 'COMMAND', run_command: 'true' }], {
      triggerUrl: 'http://127.0.0.1:9/never',
      triggerToken: 'tok',
      classroomSlug: 'cs50',
      hmacToken: 'h"mac',
    });
    // Swap curl for an echo of the payload so the test needs no network.
    const echoed = yaml.replace(/curl -sS[^\n]*/, `printf '%s\\n' "$payload"`);
    const { code, out } = runScript(echoed);
    expect(code).toBe(0);
    const line = out.split('\n').find(l => l.startsWith('{"payload"'));
    const body = JSON.parse(line as string).payload;
    expect(body).toMatchObject({
      classroomSlug: 'cs50',
      repo: 'cs/c1/hw1-alice',
      sha: 'abc',
      run_id: '7',
      token: 'h"mac',
    });
    const [entry] = Object.values(body.results) as Array<{ name: string; result: string }>;
    expect(entry.name).toBe('say "hi"');
    expect(decode(entry.result)).toBe('pass');
  });
});
