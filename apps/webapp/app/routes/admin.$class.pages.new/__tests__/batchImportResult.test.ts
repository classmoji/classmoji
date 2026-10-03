/**
 * A batch import that left pages out names each one with its reason, rather
 * than a bare "N failed".
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { batchImportSummary } from '../utils';

const ROUTE_SOURCE = readFileSync(fileURLToPath(new URL('../route.tsx', import.meta.url)), 'utf8');

describe('batchImportSummary', () => {
  it('counts the pages that made it', () => {
    expect(
      batchImportSummary(5, [
        { title: 'Week 1', error: 'x' },
        { title: 'Week 2', error: 'y' },
      ])
    ).toBe('Imported 3 of 5 pages.');
  });

  it('reads right for a batch of one', () => {
    expect(batchImportSummary(1, [{ title: 'Week 1', error: 'x' }])).toBe('Imported 0 of 1 page.');
  });
});

describe('the batch import screen', () => {
  it('lists every failed page with its error instead of a count', () => {
    expect(ROUTE_SOURCE).toContain('setBatchResult({ total, failures: errors })');
    expect(ROUTE_SOURCE).toContain('{failure.title}');
    expect(ROUTE_SOURCE).toContain('{failure.error}');
    expect(ROUTE_SOURCE).not.toContain('failed.`');
  });
});
