/**
 * `@classmoji/utils`'s barrel reaches browser and Worker bundles, so nothing
 * it imports (however deep) may load `@sentry/node`, `sentryNode.ts`, or any
 * Node built-in through the new Sentry modules. And the two shared Sentry
 * modules stay isomorphic: no SDK at runtime, no Node built-ins.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Runtime import specifiers of a file (type-only imports and exports excluded). */
const runtimeImports = (file: string): string[] => {
  const source = readFileSync(file, 'utf8');
  const specifiers: string[] = [];
  const pattern =
    /^\s*(import|export)\s+(type\s+)?[^'";]*?from\s+['"]([^'"]+)['"]|^\s*import\s+['"]([^'"]+)['"]/gm;
  for (const match of source.matchAll(pattern)) {
    if (match[2]) continue; // `import type` / `export type`
    specifiers.push(match[3] ?? match[4]);
  }
  for (const match of source.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g))
    specifiers.push(match[1]);
  return specifiers;
};

const graph = (entry: string): Map<string, string[]> => {
  const seen = new Map<string, string[]>();
  const visit = (file: string) => {
    if (seen.has(file)) return;
    const imports = runtimeImports(file);
    seen.set(file, imports);
    for (const specifier of imports) {
      if (specifier.startsWith('.')) visit(resolve(dirname(file), specifier));
    }
  };
  visit(entry);
  return seen;
};

describe('Sentry modules stay out of the barrel', () => {
  it('src/index.ts never reaches sentryNode.ts or @sentry/*', () => {
    const files = graph(resolve(SRC, 'index.ts'));
    expect(files.size).toBeGreaterThan(10);
    for (const [file, imports] of files) {
      expect(file).not.toMatch(/sentryNode\.ts$/);
      for (const specifier of imports) expect(specifier, file).not.toMatch(/^@sentry\//);
    }
  });

  it('sentryServer.ts and errorReport.ts load no SDK and no Node built-in', () => {
    for (const entry of ['sentryServer.ts', 'errorReport.ts']) {
      for (const [file, imports] of graph(resolve(SRC, entry))) {
        for (const specifier of imports) {
          expect(specifier, file).not.toMatch(/^@sentry\//);
          expect(specifier, file).not.toMatch(/^node:/);
        }
      }
    }
  });
});
