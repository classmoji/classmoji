/**
 * The docs-index tasks.
 *
 * The engine lives in `@classmoji/services` and has its own suites. What is
 * asserted here is the WIRING — the part that is invisible until it is wrong in
 * production:
 *
 *   - both task ids sit on ONE shared queue at `concurrencyLimit: 1`.
 *     Trigger.dev gives each task id its own queue unless told otherwise, so
 *     two separate `concurrencyLimit: 1` declarations would serialize each task
 *     against itself and do nothing about a manual backfill racing the
 *     schedule — which is the realistic case, because a backfill is triggered
 *     by hand exactly when somebody is impatient. The run ends in a sweep, so
 *     that race deletes live pages;
 *   - the cron slot is clear of the six existing ones;
 *   - the report is RETURNED, not only logged, and logged ONCE, whole;
 *   - the payload is validated BEFORE `run`, and an unknown key is a HARD
 *     FAILURE rather than a silent "use the defaults".
 *
 * `@trigger.dev/sdk` and `@classmoji/services` are mocked, so `run` is called
 * directly and nothing reaches Trigger, Postgres, GitHub or Cloudflare.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const reconcileDocsIndex = vi.fn();
const loggerInfo = vi.fn();

type SchemaTaskConfig = {
  id: string;
  schema: (input: unknown) => unknown;
  run: (payload: unknown) => Promise<unknown>;
};

vi.mock('@trigger.dev/sdk', () => ({
  schedules: { task: (config: unknown) => config },
  // Keeps the real contract: the schema runs BEFORE `run`, which is the whole
  // point of `schemaTask`.
  schemaTask: (config: SchemaTaskConfig) => ({
    ...config,
    run: async (payload: unknown) => config.run(config.schema(payload)),
  }),
  logger: { info: (...a: unknown[]) => loggerInfo(...a), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    docsIndex: { reconcileDocsIndex: (...a: unknown[]) => reconcileDocsIndex(...a) },
  },
}));

const {
  DOCS_INDEX_QUEUE,
  docsIndexBackfillTask,
  docsIndexReconcileTask,
  parseDocsBackfillPayload,
} = await import('../docsIndexReconcile.ts');

type TaskConfig = {
  id: string;
  cron?: string;
  queue?: { name?: string; concurrencyLimit?: number };
  run: (payload?: unknown) => Promise<unknown>;
};

const scheduled = docsIndexReconcileTask as unknown as TaskConfig;
const backfill = docsIndexBackfillTask as unknown as TaskConfig;

const REPORT = {
  commit: 'a'.repeat(40),
  pages: 30,
  eligible: 25,
  indexed: 25,
  skipped: 0,
  failed: 0,
  deleted: 0,
  byReason: { indexed: 25 },
  bySlug: [],
};

beforeEach(() => {
  reconcileDocsIndex.mockReset().mockResolvedValue(REPORT);
  loggerInfo.mockReset();
});

describe('both tasks share ONE queue', () => {
  it('declares the same queue name and a concurrency limit of 1 on both', () => {
    expect(scheduled.queue).toEqual({ name: 'docs-index', concurrencyLimit: 1 });
    expect(backfill.queue).toEqual({ name: 'docs-index', concurrencyLimit: 1 });
    expect(scheduled.queue).toBe(backfill.queue);
    expect(DOCS_INDEX_QUEUE).toEqual({ name: 'docs-index', concurrencyLimit: 1 });
  });

  it('says so in the SOURCE too, so a refactor cannot split them silently', () => {
    // The object identity above is satisfied by two tasks sharing a constant
    // that itself lost its `name`. This reads the file.
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(resolve(here, '..', 'docsIndexReconcile.ts'), 'utf8');
    // Comments talk about `concurrencyLimit: 1` at length; the count below is
    // about the CODE.
    const code = source
      .split('\n')
      .filter(line => !/^\s*(?:\/\/|\*|\/\*)/.test(line))
      .join('\n');

    expect(code).toMatch(/name:\s*'docs-index'/);
    expect(code).toMatch(/concurrencyLimit:\s*1/);
    // Exactly one queue declaration, referenced by both tasks.
    expect(code.match(/queue:\s*DOCS_INDEX_QUEUE/g) ?? []).toHaveLength(2);
    expect(code.match(/concurrencyLimit:/g) ?? []).toHaveLength(1);
  });
});

describe('the schedule', () => {
  it('runs at 06:10 UTC, clear of every existing cron', () => {
    expect(scheduled.id).toBe('docs-index-reconcile');
    expect(scheduled.cron).toBe('10 6 * * *');

    // The six slots already taken, read from their own files rather than
    // remembered: a sibling moving its cron onto this one must fail here.
    const here = dirname(fileURLToPath(import.meta.url));
    const siblings = [
      'notifications.ts',
      'gitRepoAssignment.ts',
      'customDomains.ts',
      'contentAssets.ts',
      'contentIndexReconcile.ts',
      'instructorContacts.ts',
    ];
    const taken = siblings.flatMap(file => {
      const source = readFileSync(resolve(here, '..', file), 'utf8');
      return [...source.matchAll(/^\s*cron:\s*'([^']+)'/gm)].map(match => match[1]);
    });
    expect(taken.length).toBeGreaterThan(0);
    expect(taken).not.toContain(scheduled.cron);
  });

  it('RETURNS the report as well as logging it, once, whole', async () => {
    const returned = await scheduled.run();

    expect(returned).toEqual(REPORT);
    expect(loggerInfo).toHaveBeenCalledTimes(1);
    const [, payload] = loggerInfo.mock.calls[0] as [string, Record<string, unknown>];
    // The commit sha rides along: this indexes the latest `main`, which may be
    // ahead of the deployed site, and that has to be visible rather than
    // inferred.
    expect(payload.commit).toBe(REPORT.commit);
    expect(payload.indexed).toBe(25);
  });

  it('takes no payload of its own', async () => {
    await scheduled.run();
    expect(reconcileDocsIndex).toHaveBeenCalledWith();
  });
});

describe('the backfill payload is validated before the run', () => {
  it.each([[undefined], [null], [{}], [{ concurrency: 1 }], [{ concurrency: 8 }]])(
    'accepts %j',
    input => {
      expect(() => parseDocsBackfillPayload(input)).not.toThrow();
    }
  );

  it('keeps a valid concurrency and passes it through', async () => {
    expect(parseDocsBackfillPayload({ concurrency: 2 })).toEqual({ concurrency: 2 });
    await backfill.run({ concurrency: 2 });
    expect(reconcileDocsIndex).toHaveBeenCalledWith({ concurrency: 2 });
  });

  it('passes NO options at all for an empty payload', async () => {
    await backfill.run({});
    expect(reconcileDocsIndex).toHaveBeenCalledWith({});
  });

  it.each([
    [{ concurrency: 0 }, /between 1 and 8/],
    [{ concurrency: 9 }, /between 1 and 8/],
    [{ concurrency: -1 }, /between 1 and 8/],
    [{ concurrency: 1.5 }, /between 1 and 8/],
    [{ concurrency: '2' }, /between 1 and 8/],
    // Copied from the CONTENT backfill, which does take it. The docs corpus is
    // classroom-independent, so this key can only be a mistake — and silently
    // ignoring it would run the whole fleet-wide job the operator thought they
    // had narrowed.
    [{ classroomIds: ['11111111-1111-4111-8111-111111111111'] }, /unknown payload key/],
    [{ Concurrency: 2 }, /unknown payload key/],
    [{ concurrency: 2, extra: true }, /unknown payload key/],
    [[], /must be an object/],
    ['2', /must be an object/],
  ])('rejects %j', (input, message) => {
    expect(() => parseDocsBackfillPayload(input)).toThrow(message);
  });

  it('refuses BEFORE the engine is called, not after', async () => {
    await expect(backfill.run({ classroomIds: ['x'] })).rejects.toThrow(/unknown payload key/);
    expect(reconcileDocsIndex).not.toHaveBeenCalled();
  });

  it('is the same engine as the schedule, not a second implementation', async () => {
    await scheduled.run();
    await backfill.run({});
    expect(reconcileDocsIndex).toHaveBeenCalledTimes(2);
    expect(backfill.id).toBe('docs-index-backfill');
  });
});
