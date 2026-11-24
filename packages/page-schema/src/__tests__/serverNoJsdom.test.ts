/**
 * `@classmoji/page-schema/server` loads no DOM: neither `jsdom` nor
 * `@blocknote/server-util`, directly or through any module it imports (the
 * Y.Doc conversions have to run where jsdom cannot, e.g. workerd).
 *
 * Checked in a child `node` process (`fixtures/noDomChild.ts`) whose resolve
 * hook refuses both packages for every import and require Node makes, so a
 * load from inside node_modules is caught too (`vi.mock` would only see what
 * vitest itself transforms). The same child run on `/html` must be refused,
 * which proves the hook really bites.
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

  it('the check bites: /html, which does need a DOM, is refused', () => {
    const { status, report } = runChild(entry('html.ts'));
    expect(status).toBe(1);
    expect(report.blocked.join('\n')).toMatch(/@blocknote\/server-util|jsdom/);
  }, 60_000);
});
