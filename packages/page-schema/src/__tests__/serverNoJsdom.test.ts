/**
 * `@classmoji/page-schema/server` loads no DOM: neither `jsdom` nor
 * `@blocknote/server-util`, directly or through any module it imports (the
 * Y.Doc conversions have to run where jsdom cannot, e.g. workerd).
 *
 * Checked in a child `node` process (`fixtures/noDomChild.ts`) whose resolve
 * hook refuses both packages for every import and require Node makes, so a
 * load from inside node_modules is caught too (`vi.mock` would only see what
 * vitest itself transforms). The same child run on `@classmoji/page-html` must
 * be refused, which proves the hook really bites. And the package itself
 * installs neither: no production dependency reaches them (from the lockfile).
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';

import { pageContentToYDoc, yDocToPageContent } from '../server.ts';

const CHILD = fileURLToPath(new URL('./fixtures/noDomChild.ts', import.meta.url));
const entry = (name: string) => fileURLToPath(new URL(`../${name}`, import.meta.url));

interface ChildReport {
  blocked: string[];
  resolvedNamed: string[];
  error: string | null;
  windowType: string;
  documentType: string;
  blocks: unknown[] | null;
}

function runChild(entryPath: string): { status: number | null; report: ChildReport } {
  const result = spawnSync(process.execPath, [CHILD, entryPath], {
    encoding: 'utf8',
    timeout: 60_000,
  });
  const line = result.stdout.trim().split('\n').at(-1) ?? '';
  if (!line.startsWith('{')) {
    throw new Error(`child printed no report (status ${result.status}):\n${result.stderr}`);
  }
  return { status: result.status, report: JSON.parse(line) as ChildReport };
}

describe('@classmoji/page-schema/server needs no DOM', () => {
  it('imports and round-trips the kitchen sink with jsdom and server-util unresolvable', () => {
    const { status, report } = runChild(entry('server.ts'));
    expect(report.error).toBeNull();
    expect(report.blocked).toEqual([]);
    expect(report.resolvedNamed).toEqual([]);
    expect(report.windowType).toBe('undefined');
    expect(report.documentType).toBe('undefined');
    expect(status).toBe(0);

    // The same blocks the round trip gives in this process.
    const fixture = JSON.parse(
      readFileSync(new URL('./fixtures/kitchen-sink.content.json', import.meta.url), 'utf8')
    ) as { blocks: unknown[]; coverImage?: { url: string; position: number } | null };
    const loaded = new Y.Doc();
    Y.applyUpdate(
      loaded,
      Y.encodeStateAsUpdate(
        pageContentToYDoc({ blocks: fixture.blocks, coverImage: fixture.coverImage ?? null })
      )
    );
    expect(report.blocks).toEqual(JSON.parse(JSON.stringify(yDocToPageContent(loaded).blocks)));
  }, 60_000);

  it('the check bites: @classmoji/page-html, which does need a DOM, is refused', () => {
    const { status, report } = runChild(
      fileURLToPath(new URL('../../../page-html/src/index.ts', import.meta.url))
    );
    expect(status).toBe(1);
    expect(report.blocked.join('\n')).toMatch(/@blocknote\/server-util|jsdom/);
  }, 60_000);
});

describe('@classmoji/page-schema does not install a DOM', () => {
  // What the package brings with it, from the lockfile npm installs from:
  // every package its production dependencies reach, transitively. Neither
  // jsdom nor BlockNote's server editor may be among them (they live in
  // @classmoji/page-html, which only the Trigger worker and tests depend on).
  // In this monorepo both stay on disk, hoisted, for the packages that do
  // depend on them; what this pins is that page-schema never asks for them.
  type LockEntry = {
    dependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
    link?: boolean;
    resolved?: string;
  };
  const lock = JSON.parse(
    readFileSync(new URL('../../../../package-lock.json', import.meta.url), 'utf8')
  ) as { packages: Record<string, LockEntry> };

  /** npm's lookup: `<from>/node_modules/<name>`, then each parent's. */
  function locate(from: string, name: string): string | null {
    let dir = from;
    for (;;) {
      const key = `${dir ? `${dir}/` : ''}node_modules/${name}`;
      if (lock.packages[key]) return key;
      if (!dir) return null;
      const at = dir.lastIndexOf('/node_modules/');
      dir = at === -1 ? '' : dir.slice(0, at);
    }
  }

  function closure(root: string): string[] {
    const seen = new Set<string>();
    const queue = [root];
    while (queue.length) {
      let key = queue.shift() as string;
      const entry = lock.packages[key];
      if (!entry) continue;
      if (entry.link && entry.resolved) key = entry.resolved;
      if (seen.has(key)) continue;
      seen.add(key);
      const real = lock.packages[key] ?? entry;
      const deps = {
        ...real.dependencies,
        ...real.optionalDependencies,
        ...real.peerDependencies,
      };
      for (const name of Object.keys(deps)) {
        const found = locate(key, name);
        if (found) queue.push(found);
      }
    }
    return [...seen];
  }

  const isDom = (key: string) => /node_modules\/(jsdom|@blocknote\/server-util)$/.test(key);

  it('declares neither jsdom nor @blocknote/server-util as a dependency', () => {
    const own = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
    expect(Object.keys(own.dependencies ?? {})).not.toContain('@blocknote/server-util');
    expect(Object.keys(own.dependencies ?? {})).not.toContain('jsdom');
  });

  it('reaches neither through any production dependency, transitively', () => {
    const reached = closure('packages/page-schema');
    expect(reached.length).toBeGreaterThan(20);
    expect(reached.filter(isDom)).toEqual([]);
    // The check bites: page-html reaches both.
    expect(closure('packages/page-html').filter(isDom).length).toBeGreaterThanOrEqual(2);
  });
});
