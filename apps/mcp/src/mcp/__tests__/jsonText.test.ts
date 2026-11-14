import { describe, expect, it } from 'vitest';
import { ok } from '../../tools/shared.ts';
import { jsonText } from '../jsonText.ts';
import { localizeToolResult } from '../localTimes.ts';

const payload = {
  modules: [{ id: 'm1', title: 'Welcome', items: [{ id: 'i1', title: 'Hello' }] }],
};

describe('jsonText (#932)', () => {
  it('writes compact JSON that parses back to the payload', () => {
    const text = jsonText(payload);
    expect(text).not.toMatch(/\n/);
    expect(JSON.parse(text)).toEqual(payload);
  });

  it('is what ok() puts in a tool result', () => {
    expect(ok(payload).content).toEqual([{ type: 'text', text: jsonText(payload) }]);
  });

  it('keeps a localized result compact', () => {
    const result = ok({ student_deadline: '2026-09-21T03:59:00.000Z' });
    const localized = localizeToolResult(result, 'America/New_York');
    const block = localized.content[0] as { type: string; text: string };
    expect(block.text).not.toMatch(/\n/);
    expect(JSON.parse(block.text).student_deadline_local).toMatch(/Sep 20, 2026/);
  });
});
