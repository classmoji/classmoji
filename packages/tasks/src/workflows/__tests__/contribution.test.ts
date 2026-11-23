/**
 * Reading a team repo's contributions, against a real repository in a temp
 * directory: `readClone` (git blame + git log) then `aggregateContributions`.
 * File names come from the repository itself, so a name that begins with `--`
 * has to be read as a path like any other.
 *
 * `@trigger.dev/sdk`, `@classmoji/services`, `@classmoji/database` and
 * `@classmoji/utils` are mocked; nothing here touches the network or a database.
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

vi.mock('@classmoji/database', () => ({ default: vi.fn() }));

vi.mock('@classmoji/utils', () => ({
  repoNamespace: vi.fn(),
}));

const { readClone } = await import('../contribution.ts');
const { aggregateContributions } = await import('../../helpers/contributionStats.ts');

let dir: string;

/** Commit `files` (name to line count, or raw content) as `author` on `date`. */
const commitAs = async (
  author: string,
  files: Record<string, number | Buffer>,
  date = '2026-11-02T10:00:00Z'
) => {
  const git = simpleGit(dir);
  await git.addConfig('user.name', author);
  await git.addConfig('user.email', `${author.toLowerCase()}@example.com`);
  for (const [name, content] of Object.entries(files)) {
    const full = path.join(dir, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    if (Buffer.isBuffer(content)) fs.writeFileSync(full, content);
    else {
      const body = Array.from({ length: content }, (_, i) => `${author} line ${i}`).join('\n');
      fs.writeFileSync(full, `${body}\n`);
    }
  }
  await git.add('.');
  // `--date` sets the author date, which is the one the stats read.
  await git.commit(`${author}'s work`, undefined, { '--date': date, '--allow-empty': null });
};

const aggregate = async () =>
  aggregateContributions({
    ...(await readClone(dir)),
    resolveUser: c => (c.email === 'ada@example.com' ? 'user-ada' : null),
  });

beforeEach(async () => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'contribution-')));
  await simpleGit(dir).init(['-b', 'main']);
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('team repo contributions', () => {
  it('credits no one with the starter code, and counts lines and commits per author', async () => {
    await commitAs('Teacher', { 'starter.py': 11 }, '2026-10-30T09:00:00Z');
    await commitAs('Ada', { 'src/app.java': 3, 'README.md': 2 }, '2026-11-02T10:00:00Z');
    await commitAs('Bob', { 'src/style.css': 1 }, '2026-11-05T12:00:00Z');
    await commitAs('Ada', { 'src/more.go': 4 }, '2026-11-19T23:00:00Z');

    const stats = await aggregate();

    expect(stats.starter_lines).toBe(11);
    expect(stats.total_lines).toBe(10);
    expect(stats.total_commits).toBe(3);
    expect(stats.authors.map(a => [a.user_id, a.git_name, a.lines, a.commits])).toEqual([
      ['user-ada', 'Ada', 9, 2],
      [null, 'Bob', 1, 1],
    ]);
    const ada = stats.authors[0];
    expect(ada.first_commit_at).toBe('2026-11-02T10:00:00.000Z');
    expect(ada.last_commit_at).toBe('2026-11-19T23:00:00.000Z');
    expect(ada.additions).toBe(9);
    expect(stats.authors.some(a => a.git_name === 'Teacher')).toBe(false);
    // Each student commit is kept, newest first, with its subject; the starter is not.
    expect(
      stats.commits?.map(c => [c.git_name, c.message, c.user_id, c.date.slice(0, 10)])
    ).toEqual([
      ['Ada', "Ada's work", 'user-ada', '2026-11-19'],
      ['Bob', "Bob's work", null, '2026-11-05'],
      ['Ada', "Ada's work", 'user-ada', '2026-11-02'],
    ]);
    expect(stats.commits_truncated).toBe(false);
  });

  it('credits no one with template history or the Classmoji Bot', async () => {
    await commitAs('TemplateAuthor', { 'lib/a.py': 5 }, '2024-04-01T10:00:00Z');
    await commitAs('OtherTemplateAuthor', { 'lib/b.py': 4 }, '2025-10-07T10:00:00Z');
    await commitAs('Classmoji Bot', { '.github/workflows/x.yml': 2 }, '2026-11-01T09:00:00Z');
    await commitAs('Ada', { 'src/app.py': 3 }, '2026-11-02T10:00:00Z');
    // The team repo was created on Nov 1: anything authored before is template history.
    const repoCreatedAt = new Date('2026-11-01T00:00:00Z').getTime();

    const stats = aggregateContributions({
      ...(await readClone(dir)),
      resolveUser: () => null,
      isStarterCommit: c =>
        new Date(c.date).getTime() <= repoCreatedAt || c.name === 'Classmoji Bot',
    });

    expect(stats.starter_lines).toBe(11);
    expect(stats.total_commits).toBe(1);
    expect(stats.authors.map(a => [a.git_name, a.lines, a.commits])).toEqual([['Ada', 3, 1]]);
  });

  it('credits a line to whoever changed it last', async () => {
    await commitAs('Teacher', { 'starter.txt': 2 });
    fs.writeFileSync(path.join(dir, 'starter.txt'), 'Teacher line 0\nchanged by Bob\n');
    await commitAs('Bob', {});

    const stats = await aggregate();
    expect(stats.starter_lines).toBe(1);
    expect(stats.authors.map(a => [a.git_name, a.lines, a.deletions])).toEqual([['Bob', 1, 1]]);
  });

  it('skips binaries and lock files, and reads a file whose name begins with -- as a path', async () => {
    await commitAs('Teacher', { 'start.txt': 1 });
    await commitAs('Ada', {
      '--output=x.js': 3,
      'logo.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0x01]),
      'package-lock.json': 500,
    });

    const clone = await readClone(dir);
    const stats = await aggregate();

    expect(clone.filesCounted).toBe(2); // start.txt and --output=x.js
    expect(stats.authors.map(a => [a.git_name, a.lines])).toEqual([['Ada', 3]]);
    // The name was never taken as an option: nothing else was written.
    expect(fs.existsSync(path.join(dir, 'x.js'))).toBe(false);
  });

  it('reads an empty repository as no contributions', async () => {
    const stats = await aggregate();
    expect(stats).toMatchObject({ head_sha: null, total_lines: 0, total_commits: 0, authors: [] });
  });
});
