/**
 * Counting lines per author with `git blame`, against a real repository in a
 * temp directory. File names come from the repository itself, so a name that
 * begins with `--` has to be read as a path like any other.
 *
 * `@trigger.dev/sdk`, `@classmoji/services` and `@classmoji/utils` are mocked;
 * only `calculateContributions` (no network, no database) is exercised.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { simpleGit } from 'simple-git';
import fs from 'fs';
import os from 'os';
import path from 'path';

vi.mock('@trigger.dev/sdk', () => ({
  task: (config: unknown) => config,
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {},
  getGitProvider: vi.fn(),
}));

vi.mock('@classmoji/utils', () => ({
  repoNamespace: vi.fn(),
}));

const { calculateContributions } = await import('../contribution.ts');

let dir: string;

/** Commit `files` (name to line count) as `author`. */
const commitAs = async (author: string, files: Record<string, number>) => {
  const git = simpleGit(dir);
  await git.addConfig('user.name', author);
  await git.addConfig('user.email', `${author.toLowerCase()}@example.com`);
  for (const [name, lines] of Object.entries(files)) {
    const full = path.join(dir, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    const body = Array.from({ length: lines }, (_, i) => `// ${author} ${i}`).join('\n');
    fs.writeFileSync(full, `${body}\n`);
  }
  await git.add('.');
  await git.commit(`${author}'s work`);
};

beforeEach(async () => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'contribution-')));
  await simpleGit(dir).init(['-b', 'main']);
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('calculateContributions', () => {
  it('counts blamed lines per author, most first, for source files only', async () => {
    await commitAs('Ada', { 'src/app.js': 3, 'README.md': 5 });
    await commitAs('Bob', { 'src/style.css': 1 });

    expect(await calculateContributions(dir)).toBe('3 Ada\n1 Bob');
  });

  it('reads a file whose name begins with -- as a path', async () => {
    await commitAs('Ada', { '--output=x.js': 3 });
    await commitAs('Bob', { 'src/app.ts': 2 });

    expect(await calculateContributions(dir)).toBe('3 Ada\n2 Bob');
    // The name was never taken as an option: nothing else was written.
    expect(fs.existsSync(path.join(dir, 'x.js'))).toBe(false);
    expect(fs.readdirSync(dir).sort()).toEqual(['--output=x.js', '.git', 'src']);
  });
});
