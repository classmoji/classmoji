/**
 * `cloudinary-migrate` wiring: the payload guard (a dry run is the default and
 * `dryRun: false` needs `confirm: 'MIGRATE'`), the dry run never reaching the
 * execute half, and the derived media ids.
 */

import { describe, expect, it, vi } from 'vitest';

import { uuidV5 } from '../../../../services/src/media/uuidV5.ts';

vi.mock('@trigger.dev/sdk', () => ({
  schemaTask: (config: object) => config,
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('@classmoji/database', () => ({ default: () => ({}) }));
vi.mock('@classmoji/services', () => ({
  ClassmojiService: { media: { uuidV5 } },
  ContentService: {},
}));

const {
  CLOUDINARY_MIGRATION_NAMESPACE,
  cloudinaryMigrate,
  migratedMediaId,
  PlanMismatchError,
  parseMigratePayload,
  runCloudinaryMigrate,
} = await import('../cloudinaryMigrate.ts');

describe('parseMigratePayload', () => {
  it('defaults to a dry run', () => {
    expect(parseMigratePayload(undefined)).toEqual({ dryRun: true });
    expect(parseMigratePayload({})).toEqual({ dryRun: true });
    expect(parseMigratePayload({ limit: 3 })).toEqual({ dryRun: true, limit: 3 });
  });

  it('refuses dryRun: false without confirm: MIGRATE:<planHash>', () => {
    expect(() => parseMigratePayload({ dryRun: false })).toThrow(/confirm: 'MIGRATE:<planHash/);
    for (const confirm of ['MIGRATE', 'migrate:0123456789abcdef', 'MIGRATE:0123', true]) {
      expect(() => parseMigratePayload({ dryRun: false, confirm })).toThrow(/confirm/);
    }
    expect(parseMigratePayload({ dryRun: false, confirm: 'MIGRATE:0123456789abcdef' })).toEqual({
      dryRun: false,
      confirmPlanHash: '0123456789abcdef',
    });
    // A confirm on a dry run is harmless and ignored.
    expect(parseMigratePayload({ confirm: 'MIGRATE:0123456789abcdef' })).toEqual({ dryRun: true });
  });

  it('refuses unknown keys, a non-boolean dryRun and a bad limit', () => {
    expect(() => parseMigratePayload({ dry_run: false })).toThrow(/unknown payload key/);
    expect(() => parseMigratePayload({ dryRun: 'false' })).toThrow(/boolean/);
    expect(() => parseMigratePayload({ limit: 0 })).toThrow(/limit/);
    expect(() => parseMigratePayload({ limit: 1.5 })).toThrow(/limit/);
    expect(() => parseMigratePayload([])).toThrow(/object/);
  });

  it('is the task schema, so the guard runs before run', () => {
    expect((cloudinaryMigrate as unknown as { schema: unknown }).schema).toBe(parseMigratePayload);
    expect(cloudinaryMigrate).toMatchObject({
      id: 'cloudinary-migrate',
      retry: { maxAttempts: 1 },
      queue: { concurrencyLimit: 1 },
    });
  });
});

describe('runCloudinaryMigrate', () => {
  const plan = { totals: {}, planHash: 'aaaaaaaaaaaaaaaa' } as never;

  it('a dry run plans and never calls execute', async () => {
    const execute = vi.fn();
    const planFn = vi.fn(async () => plan);
    const result = await runCloudinaryMigrate(
      { dryRun: true, limit: 5 },
      { plan: planFn, execute }
    );
    expect(result).toEqual({ mode: 'dry-run', plan });
    expect(planFn).toHaveBeenCalledWith({ limit: 5 });
    expect(execute).not.toHaveBeenCalled();
  });

  it('an execute run plans, then executes that plan', async () => {
    const report = { counts: {} } as never;
    const execute = vi.fn(async () => report);
    const result = await runCloudinaryMigrate(
      { dryRun: false, confirmPlanHash: 'aaaaaaaaaaaaaaaa' },
      { plan: async () => plan, execute }
    );
    expect(execute).toHaveBeenCalledWith(plan);
    expect(result).toEqual({ mode: 'execute', plan, report });
  });

  it('refuses to execute a plan that is not the confirmed one (drift, or a replay)', async () => {
    const execute = vi.fn();
    await expect(
      runCloudinaryMigrate(
        { dryRun: false, confirmPlanHash: 'bbbbbbbbbbbbbbbb' },
        { plan: async () => plan, execute }
      )
    ).rejects.toBeInstanceOf(PlanMismatchError);
    expect(execute).not.toHaveBeenCalled();
  });
});

describe('migratedMediaId', () => {
  it('is uuidv5(publicId:classroomId) under the fixed namespace — stable and per classroom', () => {
    const id = migratedMediaId('classmoji/slides/s/a', 'room-1');
    expect(id).toBe(uuidV5(CLOUDINARY_MIGRATION_NAMESPACE, 'classmoji/slides/s/a:room-1'));
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(migratedMediaId('classmoji/slides/s/a', 'room-1')).toBe(id);
    expect(migratedMediaId('classmoji/slides/s/a', 'room-2')).not.toBe(id);
  });
});
