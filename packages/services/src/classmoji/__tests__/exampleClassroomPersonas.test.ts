import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Issue #374: the demo personas are made up, so they get no avatar image and
 * the UI draws their initials. A persona row left over from an earlier sandbox
 * (it is shared) has its stale image cleared too. The transaction stops at the
 * first write after the personas.
 */

const userCreate = vi.fn();
const userUpdate = vi.fn();
const accountFindUnique = vi.fn();

vi.mock('@classmoji/database', () => ({
  default: () => ({
    gitOrganization: { upsert: vi.fn().mockResolvedValue({ id: 'example-org' }) },
    classroom: { findFirst: vi.fn().mockResolvedValue(null) },
    $transaction: (fn: (tx: unknown) => unknown) =>
      fn({
        classroom: { create: vi.fn().mockResolvedValue({ id: 'c1' }) },
        classroomMembership: { create: vi.fn().mockResolvedValue({}) },
        account: { findUnique: (...a: unknown[]) => accountFindUnique(...a) },
        user: {
          create: (...a: unknown[]) => userCreate(...a),
          update: (...a: unknown[]) => userUpdate(...a),
        },
        module: { create: vi.fn().mockRejectedValue(STOP) },
      }),
  }),
}));

const STOP = new Error('stop after the personas');

beforeEach(() => {
  userCreate.mockReset().mockResolvedValue({ id: 'new-user' });
  userUpdate.mockReset().mockResolvedValue({ id: 'old-user' });
  accountFindUnique.mockReset();
});

const provision = async () => {
  const { provisionExampleClassroom } = await import('../exampleClassroom.service.ts');
  await expect(
    provisionExampleClassroom({ ownerUserId: 'u1', ownerLogin: 'tim', timezone: null })
  ).rejects.toBe(STOP);
};

describe('provisionExampleClassroom personas', () => {
  it('creates new personas with no image on the user or the account', async () => {
    accountFindUnique.mockResolvedValue(null);
    await provision();

    expect(userCreate).toHaveBeenCalled();
    for (const [args] of userCreate.mock.calls) {
      const { data } = args as {
        data: { image: unknown; accounts: { create: { image: unknown } } };
      };
      expect(data.image).toBeNull();
      expect(data.accounts.create.image).toBeNull();
    }
  });

  it("clears an existing persona's image, on the user and its Github account", async () => {
    accountFindUnique.mockResolvedValue({ user_id: 'old-user' });
    await provision();

    expect(userUpdate).toHaveBeenCalled();
    for (const [args] of userUpdate.mock.calls) {
      const { data } = args as {
        data: { image: unknown; accounts: { updateMany: { data: { image: unknown } } } };
      };
      expect(data.image).toBeNull();
      expect(data.accounts.updateMany.data.image).toBeNull();
    }
  });
});
