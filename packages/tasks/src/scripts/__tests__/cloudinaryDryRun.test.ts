/**
 * The dry-run CLI cannot migrate: nothing it imports — directly or through the
 * helpers it loads — reaches the execute module, `@classmoji/services` or
 * `@classmoji/database` (whose import builds a Prisma client from
 * `DATABASE_URL`, bypassing the read-only single connection).
 *
 * Walks the relative import graph from the script's source.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const ENTRY = resolve(here, '../cloudinaryDryRun.ts');

const IMPORT =
  /(?:^|\n)\s*(?:import|export)\s[^;]*?from\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;

function graph(entry: string): { files: string[]; packages: string[]; sources: string[] } {
  const files: string[] = [];
  const packages = new Set<string>();
  const sources: string[] = [];
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.shift()!;
    if (files.includes(file)) continue;
    files.push(file);
    const source = readFileSync(file, 'utf8');
    sources.push(source);
    for (const match of source.matchAll(IMPORT)) {
      const spec = match[1] ?? match[2]!;
      if (spec.startsWith('.')) queue.push(resolve(dirname(file), spec));
      else packages.add(spec);
    }
  }
  return { files, packages: [...packages].sort(), sources };
}

describe('cloudinaryDryRun import graph', () => {
  const { files, packages, sources } = graph(ENTRY);

  it('loads the planner and the read deps', () => {
    const names = files.map(file => file.slice(file.lastIndexOf('/') + 1));
    expect(names).toEqual(
      expect.arrayContaining(['cloudinaryPlan.ts', 'cloudinaryReads.ts', 'readOnlyPrisma.ts'])
    );
  });

  it('never loads the execute module or names executeMigration', () => {
    expect(files.some(file => file.endsWith('cloudinaryExecute.ts'))).toBe(false);
    expect(files.some(file => file.endsWith('cloudinaryMigrate.ts'))).toBe(false);
    expect(sources.some(source => source.includes('executeMigration'))).toBe(false);
  });

  it('imports no package that opens its own database client or writes', () => {
    expect(packages).toEqual(['@prisma/client', 'jsonwebtoken']);
  });
});
