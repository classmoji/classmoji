import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({ allowanceFor: vi.fn(), swapActive: vi.fn() }));

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    classroomLifecycle: {
      allowanceFor: (...a: unknown[]) => mocks.allowanceFor(...a),
      swapActive: (...a: unknown[]) => mocks.swapActive(...a),
    },
  },
}));

const { gateClassroomCreate, finishArchiveAndContinue } = await import('../activeClassGate.server');

const CS10 = { id: 'cs10', name: 'CS 10', slug: 'cs-10' };

beforeEach(() => vi.clearAllMocks());

describe('gateClassroomCreate', () => {
  it('creates ACTIVE when there is a free slot', async () => {
    mocks.allowanceFor.mockResolvedValue({ limit: 1, active: [], canCreate: true });

    await expect(gateClassroomCreate('alice', undefined)).resolves.toEqual({
      ok: true,
      status: 'ACTIVE',
      archiveClassroomId: null,
    });
  });

  it('offers the classes holding the slot when there is none', async () => {
    mocks.allowanceFor.mockResolvedValue({ limit: 1, active: [CS10], canCreate: false });

    const gate = await gateClassroomCreate('alice', undefined);

    expect(gate).toMatchObject({
      ok: false,
      response: { activeClassLimit: { activeClassrooms: [CS10] } },
    });
  });

  it('creates LOCKED when one of their own active classes was picked to archive', async () => {
    mocks.allowanceFor.mockResolvedValue({ limit: 1, active: [CS10], canCreate: false });

    await expect(gateClassroomCreate('alice', 'cs10')).resolves.toEqual({
      ok: true,
      status: 'LOCKED',
      archiveClassroomId: 'cs10',
    });
  });

  it('refuses a class to archive that is not one of theirs', async () => {
    mocks.allowanceFor.mockResolvedValue({ limit: 1, active: [CS10], canCreate: false });

    await expect(gateClassroomCreate('alice', 'someone-elses')).resolves.toMatchObject({
      ok: false,
      response: { error: 'That class is not one of your active classes.' },
    });
  });
});

describe('finishArchiveAndContinue', () => {
  it('swaps as the creator', async () => {
    await expect(
      finishArchiveAndContinue({
        newClassroomId: 'new',
        archiveClassroomId: 'cs10',
        userId: 'alice',
      })
    ).resolves.toBeNull();
    expect(mocks.swapActive).toHaveBeenCalledWith({
      activateClassroomId: 'new',
      archiveClassroomId: 'cs10',
      actorUserId: 'alice',
      tool: 'web:classroom.create_archive_and_continue',
    });
  });

  it('says what happened when the swap fails, without throwing', async () => {
    mocks.swapActive.mockRejectedValue(new Error('race'));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(
      finishArchiveAndContinue({
        newClassroomId: 'new',
        archiveClassroomId: 'cs10',
        userId: 'alice',
      })
    ).resolves.toContain('still locked');
  });
});
