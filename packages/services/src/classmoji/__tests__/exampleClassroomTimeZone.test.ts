import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The example sandbox is seeded with the creator's browser zone, like a real
 * classroom at creation. Only the classroom row's nested settings matter here,
 * so the transaction stops right after that first write.
 */

const classroomCreate = vi.fn();

vi.mock('@classmoji/database', () => ({
  default: () => ({
    gitOrganization: { upsert: vi.fn().mockResolvedValue({ id: 'example-org' }) },
    classroom: { findFirst: vi.fn().mockResolvedValue(null) },
    $transaction: (fn: (tx: unknown) => unknown) =>
      fn({ classroom: { create: (...a: unknown[]) => classroomCreate(...a) } }),
  }),
}));

const STOP = new Error('stop after the classroom row');

beforeEach(() => {
  classroomCreate.mockReset();
  classroomCreate.mockRejectedValue(STOP);
});

const settingsFor = async (timezone: string | null | undefined) => {
  const { provisionExampleClassroom } = await import('../exampleClassroom.service.ts');
  await expect(
    provisionExampleClassroom({ ownerUserId: 'u1', ownerLogin: 'tim', timezone })
  ).rejects.toBe(STOP);
  return (classroomCreate.mock.calls[0][0] as { data: { settings: { create: unknown } } }).data
    .settings.create;
};

describe('provisionExampleClassroom time zone', () => {
  it("seeds the creator's browser zone, canonicalized", async () => {
    expect(await settingsFor('america/new_york')).toEqual({
      show_grades_to_students: true,
      quizzes_enabled: true,
      timezone: 'America/New_York',
    });
  });

  it('seeds no zone when none, or an invalid one, is given', async () => {
    expect(((await settingsFor(undefined)) as { timezone: unknown }).timezone).toBeNull();
    classroomCreate.mockClear();
    expect(((await settingsFor('Mars/Olympus')) as { timezone: unknown }).timezone).toBeNull();
  });
});
