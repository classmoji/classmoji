/**
 * Every task states its retry policy.
 *
 * The project default (trigger.config.js) is a single attempt, and that stays:
 * a blind retry repeats a task's side effects (a second regrade request, a
 * second charge, a repo deleted twice). So the default is never the decision.
 * Each task spreads one of the blip helpers (`...retryOnGitBlip`,
 * `...retryOnDatabaseBlip`) when its run is safe to repeat, or sets its own
 * `retry`, usually `{ maxAttempts: 1 }` with a comment saying why not.
 *
 * Read from source rather than by importing the tasks, which would load every
 * service and the database client.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '..', '..');
const TASK_DIRS = ['workflows', 'agents'].map(dir => join(SRC, dir));
const TASK_START = /\b(?:schemaTask|schedules\.task|task)\(\{/g;
const RETRY_DECLARED = /(?:^|[\s,{])retry\s*:|\.\.\.retryOn[A-Za-z]+/;

const sourceFiles = (dir: string): string[] => {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap(entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sourceFiles(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
};

/**
 * The text of the object literal that opens at `start` (a `{`), keeping only
 * what sits directly inside it: nested objects, strings and comments are
 * dropped, so a `retry` key elsewhere in the body cannot count.
 */
const topLevelText = (source: string, start: number): string => {
  let depth = 0;
  let out = '';
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === '/' && next === '/') {
      i = source.indexOf('\n', i);
      if (i < 0) break;
      continue;
    }
    if (ch === '/' && next === '*') {
      i = source.indexOf('*/', i + 2) + 1;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      for (i += 1; i < source.length && source[i] !== ch; i += 1) {
        if (source[i] === '\\') i += 1;
      }
      continue;
    }
    if (ch === '{' || ch === '(' || ch === '[') {
      depth += 1;
      if (depth > 1) continue;
    } else if (ch === '}' || ch === ')' || ch === ']') {
      depth -= 1;
      if (depth === 0) return out;
      continue;
    }
    if (depth === 1) out += ch;
  }
  return out;
};

const tasks = TASK_DIRS.flatMap(sourceFiles).flatMap(file => {
  const source = readFileSync(file, 'utf8');
  const inComment = (index: number) => {
    const lineStart = source.lastIndexOf('\n', index) + 1;
    return /^\s*(?:\/\/|\*|\/\*)/.test(source.slice(lineStart, index));
  };
  return [...source.matchAll(TASK_START)]
    .filter(match => !inComment(match.index))
    .map(match => {
      const open = match.index + match[0].length - 1;
      const body = topLevelText(source, open);
      const id = /\bid\s*:\s*([^,\n]+)/.exec(source.slice(open, open + 400))?.[1]?.trim();
      const line = source.slice(0, match.index).split('\n').length;
      return { where: `${relative(SRC, file)}:${line}`, id, body };
    });
});

describe('task retry policy', () => {
  it('finds the tasks', () => {
    expect(tasks.length).toBeGreaterThan(60);
  });

  it('every task declares its retry policy instead of inheriting the default', () => {
    const undeclared = tasks
      .filter(t => !RETRY_DECLARED.test(t.body))
      .map(t => `${t.where} ${t.id ?? ''}`);
    expect(undeclared).toEqual([]);
  });
});
