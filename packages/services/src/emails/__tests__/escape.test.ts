import { describe, expect, it } from 'vitest';

import { escapeVars } from '../escape.ts';

/**
 * Resend requires every template variable to be a string, and rejects the whole
 * send otherwise. That send happens inside a Trigger task, so the rejection is
 * invisible to both the caller and the person waiting for the mail — the only
 * symptom is an email that never arrives. A real form verification failed this
 * way with `Variable "EXPIRES_HOURS" must be a \`string\``, which is why the
 * coercion lives in `escapeVars` rather than at each call site.
 */
describe('escapeVars', () => {
  it('hands back strings, never numbers', () => {
    const out = escapeVars({ EXPIRES_HOURS: 48, COUNT: 0 });

    expect(out.EXPIRES_HOURS).toBe('48');
    expect(out.COUNT).toBe('0');
    for (const value of Object.values(out)) expect(typeof value).toBe('string');
  });

  it('escapes markup in string values', () => {
    const out = escapeVars({ NAME: '<script>alert(1)</script>' });

    expect(out.NAME).not.toContain('<script>');
    expect(out.NAME).toContain('&lt;');
  });

  it('leaves a number free of escaping artefacts', () => {
    expect(escapeVars({ N: 1234 }).N).toBe('1234');
  });

  it('drops null and undefined rather than sending the words', () => {
    const out = escapeVars({ A: null, B: undefined, C: 'kept' });

    expect(out).not.toHaveProperty('A');
    expect(out).not.toHaveProperty('B');
    expect(out.C).toBe('kept');
  });
});
