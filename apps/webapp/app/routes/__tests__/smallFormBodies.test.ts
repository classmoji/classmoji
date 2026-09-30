/**
 * Actions that post a few short fields read their body AFTER their gate, and
 * through the capped reader rather than `request.formData()`.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { SMALL_FORM_MAX_BYTES, readSmallForm } from '~/utils/smallFormBody.server';

const source = (relative: string) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

const actionOf = (text: string) => text.slice(text.indexOf('export const action'));

describe('readSmallForm', () => {
  it('reads a short form', async () => {
    const request = new Request('http://localhost/x', {
      method: 'POST',
      body: new URLSearchParams({ slideId: 'abc', field: 'is_draft', value: 'true' }),
    });
    const form = await readSmallForm(request);
    expect(form?.get('slideId')).toBe('abc');
  });

  it('refuses a body over the cap', async () => {
    const request = new Request('http://localhost/x', {
      method: 'POST',
      body: new URLSearchParams({ value: 'x'.repeat(SMALL_FORM_MAX_BYTES + 1) }),
    });
    expect(await readSmallForm(request)).toBeNull();
  });
});

describe.each([
  ['admin.$class.slides', '../admin.$class.slides/route.tsx', 'await assertClassroomAccess('],
  ['admin.$class.forms', '../admin.$class.forms/route.tsx', 'await requireFormsAccess('],
])('%s action', (_name, path, gateCall) => {
  const action = actionOf(source(path));

  it('runs its gate before it reads the body, and reads it capped', () => {
    const gate = action.indexOf(gateCall);
    const read = action.indexOf('await readSmallForm(request)');
    expect(gate).toBeGreaterThan(-1);
    expect(read).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(read);
    expect(action).not.toContain('await request.formData()');
  });
});
