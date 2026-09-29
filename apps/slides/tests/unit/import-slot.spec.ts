/**
 * One slides.com import at a time per process: one import peaks at a bit over
 * 1 GiB, and the slides machine has 2 GB.
 *
 * The slot itself is plain module state and runs here. The endpoint needs a
 * database and a session to run, so its use of the slot is pinned from source,
 * the way slide-gates.spec pins the upload slots.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';

import {
  IMPORT_BUSY_MESSAGE,
  MAX_CONCURRENT_IMPORTS,
  acquireImportSlot,
  importsInFlight,
  releaseImportSlot,
} from '../../app/utils/importSlot.server.ts';

const START = readFileSync(
  fileURLToPath(new URL('../../app/routes/api.slides.import.start/route.ts', import.meta.url)),
  'utf8'
);

test.describe('the import slot', () => {
  test.afterEach(() => {
    while (importsInFlight() > 0) releaseImportSlot();
  });

  test('one import holds it; a second is refused until the first gives it back', () => {
    expect(MAX_CONCURRENT_IMPORTS).toBe(1);
    expect(acquireImportSlot()).toBe(true);
    expect(acquireImportSlot()).toBe(false);
    expect(importsInFlight()).toBe(1);

    releaseImportSlot();
    expect(importsInFlight()).toBe(0);
    expect(acquireImportSlot()).toBe(true);
  });

  test('a release too many never frees a slot that is not there', () => {
    releaseImportSlot();
    releaseImportSlot();
    expect(importsInFlight()).toBe(0);
    expect(acquireImportSlot()).toBe(true);
    expect(acquireImportSlot()).toBe(false);
  });

  test('the refusal says what to do, not how the server works', () => {
    expect(IMPORT_BUSY_MESSAGE).toBe(
      'Another import is running right now. Please try again shortly.'
    );
  });
});

test.describe('the import endpoint', () => {
  test('takes the slot after the session and before the body is read', () => {
    const session = START.indexOf('await getAuthSession(request)');
    const slot = START.indexOf('if (!acquireImportSlot()) {');
    const read = START.indexOf('await readLimitedFormData(');
    expect(session).toBeGreaterThan(-1);
    expect(slot).toBeGreaterThan(session);
    expect(read).toBeGreaterThan(slot);
  });

  test('refuses a second import with a 503 the import screen shows', () => {
    const refusal = START.slice(START.indexOf('if (!acquireImportSlot()) {'));
    expect(refusal).toContain('{ error: IMPORT_BUSY_MESSAGE }');
    expect(refusal).toContain(
      "{ status: 503, headers: { 'Retry-After': String(IMPORT_RETRY_AFTER_SECONDS) } }"
    );
    // The screen throws `result.error` from any answer that is not ok.
    const page = readFileSync(
      fileURLToPath(new URL('../../app/routes/import/route.tsx', import.meta.url)),
      'utf8'
    );
    expect(page).toContain("throw new Error(result.error || 'Failed to start import');");
  });

  test('gives the slot back on every path: an early answer, or the import settling', () => {
    // An answer without an import (a bad form, a refused gate, a thrown error).
    expect(START).toContain('const slot = { held: true };');
    expect(START).toContain('} finally {\n    if (slot.held) releaseImportSlot();');
    // Once started, the import owns it — handed over only after the call that
    // starts it, and given back when it settles, whether it failed or not.
    const run = START.indexOf('const run = processZipImport({');
    const handedOver = START.indexOf('slot.held = false;');
    expect(run).toBeGreaterThan(-1);
    expect(handedOver).toBeGreaterThan(run);
    expect(START.match(/slot\.held = false;/g)).toHaveLength(1);
    expect(START.slice(handedOver)).toContain('.finally(releaseImportSlot);');
  });
});
