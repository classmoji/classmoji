import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  boundIssues,
  capArray,
  capElements,
  capKeys,
  countJsonElements,
  issueText,
  MAX_SHOWN_ISSUE_MESSAGE_CHARS,
  MAX_SHOWN_ISSUES,
  MAX_SHOWN_ISSUES_TEXT_CHARS,
} from '../inputCaps.ts';

/** An element schema that counts how often it runs. */
function counted() {
  const calls = { n: 0 };
  const schema = z.number().refine(() => {
    calls.n += 1;
    return true;
  });
  return { calls, schema };
}

const issue = (message: string, path: (string | number)[] = []): z.ZodIssue => ({
  code: z.ZodIssueCode.custom,
  message,
  path,
});

describe('capArray', () => {
  it('refuses an array over the cap with one issue, before any element is parsed', async () => {
    const { calls, schema } = counted();
    const capped = capArray(z.array(schema).max(3), 3);
    const big = Array.from({ length: 100_000 }, () => 'not a number');

    const sync = capped.safeParse(big);
    expect(sync.success).toBe(false);
    if (!sync.success) expect(sync.error.issues).toHaveLength(1);
    const async = await capped.safeParseAsync(big);
    expect(async.success).toBe(false);
    if (!async.success) expect(async.error.issues).toHaveLength(1);
    expect(calls.n).toBe(0);
  });

  it('raises the same issue as .max(), message and error map included', () => {
    const plain = z.array(z.number()).max(3);
    const capped = capArray(z.array(z.number()).max(3), 3);
    const four = [1, 2, 3, 4];
    const issues = (r: z.ZodSafeParseResult<unknown>) => (r.success ? [] : r.error.issues);
    const messages = (r: z.ZodSafeParseResult<unknown>) => issues(r).map(i => [i.code, i.message]);

    expect(issues(capped.safeParse(four))).toEqual(issues(plain.safeParse(four)));
    expect(issues(capped.safeParse(four, { reportInput: true }))).toEqual(
      issues(plain.safeParse(four, { reportInput: true }))
    );
    const error: z.ZodErrorMap = i => (i.code === 'too_big' ? `at most ${i.maximum}` : undefined);
    expect(issues(capped.safeParse(four, { error }))).toEqual(
      issues(plain.safeParse(four, { error }))
    );
    expect(messages(capped.safeParse(four, { error }))).toEqual([['too_big', 'at most 3']]);

    const named = capArray(z.array(z.number()).max(3, 'Pick at most 3'), 3, 'Pick at most 3');
    const namedPlain = z.array(z.number()).max(3, 'Pick at most 3');
    expect(issues(named.safeParse(four))).toEqual(issues(namedPlain.safeParse(four)));
    expect(messages(named.safeParse(four, { error }))).toEqual([['too_big', 'Pick at most 3']]);
  });

  it('passes arrays within the cap, and other values, to the schema unchanged', () => {
    const capped = capArray(z.array(z.number()).max(3), 3);
    expect(capped.parse([1, 2, 3])).toEqual([1, 2, 3]);
    const notArray = capped.safeParse('x');
    expect(notArray.success).toBe(false);
    if (!notArray.success) expect(notArray.error.issues[0].code).toBe('invalid_type');
    expect(capped.optional().parse(undefined)).toBeUndefined();
  });

  it('puts the issue at the array’s path inside an object', () => {
    const shape = z.object({ items: capArray(z.array(z.number()).max(2), 2) }).strict();
    const result = shape.safeParse({ items: [1, 2, 3] });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues.map(i => i.path)).toEqual([['items']]);
  });
});

describe('capKeys', () => {
  it('refuses an object with too many keys with one issue, before its values are parsed', async () => {
    const { calls, schema } = counted();
    const capped = capKeys(z.record(z.string(), schema), 5, 'at most 5 keys');
    const big = Object.fromEntries(Array.from({ length: 100_000 }, (_, i) => [`k${i}`, 'x']));

    for (const result of [capped.safeParse(big), await capped.safeParseAsync(big)]) {
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues).toHaveLength(1);
        expect(result.error.issues[0].message).toBe('at most 5 keys');
      }
    }
    expect(calls.n).toBe(0);
  });

  it('passes objects within the cap, arrays and non-objects to the schema unchanged', () => {
    const capped = capKeys(z.record(z.string(), z.number()), 2);
    expect(capped.parse({ a: 1, b: 2 })).toEqual({ a: 1, b: 2 });
    expect(capped.safeParse([1, 2, 3]).success).toBe(false);
    expect(capped.safeParse(null).success).toBe(false);
  });
});

describe('capElements', () => {
  it('refuses a value over the element budget with one issue', async () => {
    const { calls, schema } = counted();
    const capped = capElements(z.array(z.array(schema)), 1_000);
    const nested = Array.from({ length: 400 }, () => Array.from({ length: 400 }, () => 'x'));

    for (const result of [capped.safeParse(nested), await capped.safeParseAsync(nested)]) {
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.issues).toHaveLength(1);
    }
    expect(calls.n).toBe(0);
  });

  it('passes a value within the budget', () => {
    const capped = capElements(z.array(z.array(z.number())), 1_000);
    const value = Array.from({ length: 10 }, () => [1, 2, 3]);
    expect(capped.parse(value)).toEqual(value);
  });
});

describe('countJsonElements', () => {
  it('counts array elements and object members, recursively', () => {
    expect(countJsonElements({ a: [1, 2, { b: 3 }], c: null })).toBe(6);
    expect(countJsonElements('x')).toBe(0);
  });

  it('stops once past the limit', () => {
    expect(
      countJsonElements(
        Array.from({ length: 10_000 }, () => 1),
        10
      )
    ).toBe(11);
  });
});

describe('issueText', () => {
  it('reads like the plain join for a short list', () => {
    const issues = [issue('Required', ['a']), issue('Pick at most 2', ['b', 0]), issue('Bad')];
    expect(issueText(issues)).toBe(issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; '));
  });

  it('keeps the first issues and says how many more there were', () => {
    const issues = Array.from({ length: 5_000 }, (_, i) => issue('Expected string', ['x', i]));
    const text = issueText(issues);
    expect(text.match(/Expected string/g)).toHaveLength(MAX_SHOWN_ISSUES);
    expect(text.endsWith(`; …and ${5_000 - MAX_SHOWN_ISSUES} more`)).toBe(true);
  });

  it('cuts long messages, long paths and the whole text', () => {
    const huge = issueText([issue('k'.repeat(300_000), ['answers', 'z'.repeat(10_000)])]);
    expect(huge.length).toBeLessThan(400);
    const many = issueText(
      Array.from({ length: 50 }, (_, i) => issue('m'.repeat(1_000), ['p'.repeat(1_000), i]))
    );
    expect(many.length).toBeLessThanOrEqual(MAX_SHOWN_ISSUES_TEXT_CHARS + 50);
    expect(many).toMatch(/…and \d+ more$/);
  });
});

describe('boundIssues', () => {
  it('keeps the first issues, cut, plus one saying how many more', () => {
    const issues = Array.from({ length: 100 }, (_, i) => issue('x'.repeat(1_000), ['k', i]));
    const bounded = boundIssues(issues);
    expect(bounded).toHaveLength(MAX_SHOWN_ISSUES + 1);
    expect(bounded[0].message.length).toBeLessThanOrEqual(MAX_SHOWN_ISSUE_MESSAGE_CHARS + 1);
    expect(bounded.at(-1)!.message).toBe(`…and ${100 - MAX_SHOWN_ISSUES} more`);
  });

  it('leaves a short list as it is', () => {
    const issues = [issue('a', ['x']), issue('b', ['y', 0])];
    expect(boundIssues(issues)).toEqual(issues);
  });

  it('cuts the unknown keys an issue lists, and a long path segment', () => {
    const keys = Array.from({ length: 5_000 }, (_, i) => `${'k'.repeat(300)}${i}`);
    const parsed = z
      .object({ position: z.object({ after: z.string() }).strict() })
      .safeParse({ position: { after: 'a', ...Object.fromEntries(keys.map(k => [k, 1])) } });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    const unknown = parsed.error.issues.find(i => i.code === 'unrecognized_keys')!;
    expect(unknown.keys).toHaveLength(5_000);

    const [bounded] = boundIssues([unknown]);
    const kept = (bounded as { keys: string[] }).keys;
    expect(kept).toHaveLength(MAX_SHOWN_ISSUES);
    for (const key of kept) expect(key.length).toBeLessThanOrEqual(65);
    expect(bounded.message.length).toBeLessThanOrEqual(MAX_SHOWN_ISSUE_MESSAGE_CHARS + 1);
    expect(JSON.stringify(bounded).length).toBeLessThan(3_000);

    const [long] = boundIssues([issue('x', ['y'.repeat(1_000), 0])]);
    expect(long.path).toEqual([`${'y'.repeat(64)}…`, 0]);
  });

  it('keeps no union branches', () => {
    const parsed = z.union([z.string(), z.number()]).safeParse(true);
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues[0].code).toBe('invalid_union');
    const [bounded] = boundIssues(parsed.error.issues);
    expect(bounded.code).toBe('invalid_union');
    expect((bounded as { errors: unknown[] }).errors).toEqual([]);
  });
});
