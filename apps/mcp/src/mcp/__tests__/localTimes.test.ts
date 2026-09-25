/**
 * The class-zone pass the registry applies to every classroom-bound result
 * (localTimes.ts). The registry wiring is covered in registry.test.ts; this pins
 * the edges: error results, non-JSON text, arrays, and fields a payload already
 * owns.
 */

import { describe, expect, it } from 'vitest';
import { localizePayload, localizeToolResult } from '../localTimes.ts';

const NY = 'America/New_York';
const NOW = new Date('2026-09-24T15:20:00Z');

describe('localizeToolResult', () => {
  it('passes error results through untouched', () => {
    const result = {
      isError: true,
      content: [{ type: 'text' as const, text: '{"closes_at":"2026-09-25T03:59:00Z"}' }],
    };
    expect(localizeToolResult(result, NY, NOW)).toBe(result);
  });

  it('passes non-JSON text through untouched', () => {
    const result = { content: [{ type: 'text' as const, text: 'read-ok' }] };
    expect(localizeToolResult(result, NY, NOW)).toEqual(result);
  });

  it('renders the form close the way the student should have heard it', () => {
    const result = {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({ forms: [{ title: 'Survey', closes_at: '2026-09-25T03:59:00Z' }] }),
        },
      ],
    };
    const body = JSON.parse(localizeToolResult(result, NY, NOW).content[0].text);
    // Tonight, not "tomorrow (Sep 25)".
    expect(body.forms[0].closes_at_local).toBe('Thu Sep 24, 2026, 11:59 PM EDT');
    expect(body.now_local).toBe('Thursday, September 24, 2026, 11:20 AM EDT (America/New_York)');
  });
});

describe('localizePayload', () => {
  it('adds per-field renderings to a top-level array but no top-level extras', () => {
    const out = localizePayload([{ due_date: '2026-09-16T18:00:00Z' }], NY, NOW);
    expect(out).toEqual([
      { due_date: '2026-09-16T18:00:00Z', due_date_local: 'Wed Sep 16, 2026, 2:00 PM EDT' },
    ]);
  });

  it('never overwrites a timezone or now_local the payload already has', () => {
    const out = localizePayload(
      { timezone: 'mine', now_local: 'mine', start_time: '2026-09-16T18:00:00Z' },
      NY,
      NOW
    ) as Record<string, unknown>;
    expect(out.timezone).toBe('mine');
    expect(out.now_local).toBe('mine');
    expect(out.start_time_local).toBe('Wed Sep 16, 2026, 2:00 PM EDT');
  });

  it('returns the very same object when there is nothing to render', () => {
    const payload = { title: 'no dates here', count: 2 };
    expect(localizePayload(payload, NY, NOW)).toBe(payload);
  });
});
