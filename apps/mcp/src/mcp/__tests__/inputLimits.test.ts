/**
 * The counting and budgeting pieces of the input limits (inputLimits.ts):
 * the element count matches the MCP SDK's measure, the raw-text bound never
 * undercounts it, and the in-flight budget holds per user and per server.
 */

import { describe, expect, it } from 'vitest';
import {
  countJsonElements,
  jsonValueBound,
  LIGHT_CALL_ELEMENTS,
  MAX_BODY_JSON_VALUES,
  MAX_TOOL_INPUT_ELEMENTS,
  SERVER_INFLIGHT_ELEMENTS,
  ToolInputBudget,
  USER_INFLIGHT_ELEMENTS,
} from '../inputLimits.ts';

const SAMPLES: unknown[] = [
  null,
  42,
  'text',
  [],
  {},
  [1, 2, 3],
  { a: 1, b: [1, 2, { c: [] }] },
  [[], [[]], {}, { x: {} }],
  { 'key, with [brackets] and {braces}': '"quoted", [not] {counted}', esc: 'a\\"b,c' },
  { blocks: [{ id: 'b', type: 'paragraph', content: [{ type: 'text', text: 'Hi, [x]' }] }] },
];

describe('countJsonElements', () => {
  it('counts array items and object members, recursively', () => {
    expect(countJsonElements(null)).toBe(0);
    expect(countJsonElements('x')).toBe(0);
    expect(countJsonElements([])).toBe(0);
    expect(countJsonElements([1, 2, 3])).toBe(3);
    expect(countJsonElements({ a: 1, b: [1, 2, { c: [] }] })).toBe(6);
  });

  it('stops once past the limit', () => {
    const big = Array.from({ length: 1_000 }, () => 0);
    expect(countJsonElements(big, 10)).toBe(11);
  });
});

describe('jsonValueBound', () => {
  it('is never below the element count, and ignores what is inside strings', () => {
    for (const sample of SAMPLES) {
      const text = JSON.stringify(sample);
      expect(jsonValueBound(text)).toBeGreaterThanOrEqual(countJsonElements(sample));
    }
    expect(jsonValueBound(JSON.stringify('a, [b], {c}, \\" d'))).toBe(0);
  });

  it('is exact when no container is empty', () => {
    const value = { a: [1, 2, 3], b: { c: 'x,y', d: [{ e: 1 }] } };
    expect(jsonValueBound(JSON.stringify(value))).toBe(countJsonElements(value));
  });

  it('stays within twice the count plus one, so a request inside the limit is never refused by it', () => {
    // The worst case: every container empty. 1,000 items, 999 commas,
    // one bracket and 1,000 braces.
    const allEmpty = Array.from({ length: 1_000 }, () => ({}));
    expect(countJsonElements(allEmpty)).toBe(1_000);
    expect(jsonValueBound(JSON.stringify(allEmpty))).toBe(2_000);
    for (const sample of SAMPLES) {
      const text = JSON.stringify(sample);
      expect(jsonValueBound(text)).toBeLessThanOrEqual(2 * countJsonElements(sample) + 1);
    }
    expect(MAX_BODY_JSON_VALUES).toBeGreaterThanOrEqual(2 * MAX_TOOL_INPUT_ELEMENTS + 1);
  });

  it('stops once past the limit', () => {
    expect(jsonValueBound('[' + Array(100).fill('0').join(',') + ']', 10)).toBe(11);
  });
});

describe('ToolInputBudget', () => {
  it('has the documented sizes', () => {
    expect(MAX_TOOL_INPUT_ELEMENTS).toBe(25_000);
    expect(LIGHT_CALL_ELEMENTS).toBe(2_000);
    expect(USER_INFLIGHT_ELEMENTS).toBe(50_000);
    expect(SERVER_INFLIGHT_ELEMENTS).toBe(100_000);
  });

  it('lets one user hold two maximal calls, not three', () => {
    const budget = new ToolInputBudget();
    const a = budget.tryAcquire('u1', 25_000);
    const b = budget.tryAcquire('u1', 25_000);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(budget.tryAcquire('u1', 25_000)).toBeNull();
    a?.();
    expect(budget.tryAcquire('u1', 25_000)).not.toBeNull();
  });

  it('holds the server to four maximal calls across users', () => {
    const budget = new ToolInputBudget();
    for (const user of ['u1', 'u1', 'u2', 'u2']) {
      expect(budget.tryAcquire(user, 25_000)).not.toBeNull();
    }
    expect(budget.tryAcquire('u3', 25_000)).toBeNull();
    expect(budget.inFlight()).toBe(100_000);
  });

  it('releases once, however often it is called', () => {
    const budget = new ToolInputBudget(10, 10);
    const release = budget.tryAcquire('u1', 6);
    release?.();
    release?.();
    expect(budget.inFlight()).toBe(0);
    expect(budget.inFlight('u1')).toBe(0);
    const again = budget.tryAcquire('u1', 6);
    expect(budget.tryAcquire('u2', 6)).toBeNull();
    again?.();
    expect(budget.tryAcquire('u2', 6)).not.toBeNull();
  });
});
