/**
 * pageSections.service with Prisma mocked: the shape of every query (page AND
 * user, or page AND classroom, plus the page-in-classroom check) and the id
 * validation in front of it. An id that is not a usable string never reaches
 * Prisma: reads answer "nothing", writes throw.
 *
 * The real-database behaviour (isolation between users and classrooms, the
 * current-student filter, the unique-conflict race) is in
 * pageSections.integration.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  membershipFindMany: vi.fn(),
  pageFindFirst: vi.fn(),
  checkFindMany: vi.fn(),
  checkCreateMany: vi.fn(),
  checkDeleteMany: vi.fn(),
  checkGroupBy: vi.fn(),
  unlockFindMany: vi.fn(),
  unlockFindUnique: vi.fn(),
  unlockCreate: vi.fn(),
  unlockGroupBy: vi.fn(),
}));

vi.mock('@classmoji/database', async () => ({
  ...(await vi.importActual<typeof import('@classmoji/database/gitIdentity')>(
    '@classmoji/database/gitIdentity'
  )),
  default: () => ({
    classroomMembership: { findMany: (...a: unknown[]) => db.membershipFindMany(...a) },
    page: { findFirst: (...a: unknown[]) => db.pageFindFirst(...a) },
    pageSectionCheck: {
      findMany: (...a: unknown[]) => db.checkFindMany(...a),
      createMany: (...a: unknown[]) => db.checkCreateMany(...a),
      deleteMany: (...a: unknown[]) => db.checkDeleteMany(...a),
      groupBy: (...a: unknown[]) => db.checkGroupBy(...a),
    },
    pageSectionUnlock: {
      findMany: (...a: unknown[]) => db.unlockFindMany(...a),
      findUnique: (...a: unknown[]) => db.unlockFindUnique(...a),
      create: (...a: unknown[]) => db.unlockCreate(...a),
      groupBy: (...a: unknown[]) => db.unlockGroupBy(...a),
    },
    // Logins are read on the classroom organization's provider.
    classroom: {
      findUnique: async () => ({ git_organization: { provider: 'GITHUB' } }),
    },
  }),
}));

const sections = await import('../pageSections.service.ts');
const { PageSectionsValidationError } = sections;

const UNUSABLE_IDS: unknown[] = [undefined, null, '', 42, { not: '' }, ['id-1'], 'x'.repeat(256)];
const UNUSABLE_BLOCK_IDS: unknown[] = [
  ...UNUSABLE_IDS,
  'x'.repeat(65),
  'has space',
  'semi;colon',
  '../up',
  'block"id',
];

beforeEach(() => {
  for (const m of Object.values(db)) m.mockReset();
});

describe('id validation', () => {
  it('accepts uuids and BlockNote-style ids', () => {
    expect(sections.isBlockId('2f0c9a3e-1b2c-4d5e-8f90-123456789abc')).toBe(true);
    expect(sections.isBlockId('initialBlockId_1')).toBe(true);
    expect(sections.isBlockId('x'.repeat(64))).toBe(true);
    expect(sections.isSectionId('page-1')).toBe(true);
  });

  it('refuses everything else', () => {
    for (const id of UNUSABLE_BLOCK_IDS) expect(sections.isBlockId(id)).toBe(false);
    for (const id of UNUSABLE_IDS) expect(sections.isSectionId(id)).toBe(false);
  });
});

describe('sectionViewer (the one reader rule)', () => {
  const row = (role: string, accepted = true) => ({ role, has_accepted_invite: accepted });
  const viewerOf = async (rows: unknown[]) => {
    db.membershipFindMany.mockResolvedValue(rows);
    return sections.sectionViewer({ userId: 'u-1', classroomId: 'c-1' });
  };

  it('reads every invite state of this user in this classroom, in one query', async () => {
    await viewerOf([]);
    expect(db.membershipFindMany).toHaveBeenCalledTimes(1);
    expect(db.membershipFindMany).toHaveBeenCalledWith({
      where: { user_id: 'u-1', classroom_id: 'c-1' },
      select: { role: true, has_accepted_invite: true },
    });
  });

  it('accepted student: unlocks, reveals nothing, sees no activity', async () => {
    expect(await viewerOf([row('STUDENT')])).toEqual({
      role: 'STUDENT',
      acceptedRole: 'STUDENT',
      teachingTeam: false,
      student: true,
      canEditAnyState: false,
      revealAll: false,
      canUnlock: true,
      canSeeActivity: false,
      canViewDrafts: false,
    });
  });

  it('staff who are also students are staff (highest accepted role wins)', async () => {
    expect(await viewerOf([row('STUDENT'), row('ASSISTANT')])).toMatchObject({
      acceptedRole: 'ASSISTANT',
      teachingTeam: true,
      student: false,
      revealAll: true,
      canUnlock: false,
      canSeeActivity: false,
    });
  });

  it('accepted owner and teacher: edit, reveal all, see activity', async () => {
    for (const role of ['OWNER', 'TEACHER']) {
      expect(await viewerOf([row(role)])).toMatchObject({
        role,
        acceptedRole: role,
        canEditAnyState: true,
        revealAll: true,
        canUnlock: false,
        canSeeActivity: true,
      });
    }
  });

  it('a pending TEACHER edits (so reveals all) but sees no activity', async () => {
    expect(await viewerOf([row('TEACHER', false)])).toEqual({
      role: 'TEACHER',
      acceptedRole: null,
      teachingTeam: false,
      student: false,
      canEditAnyState: true,
      revealAll: true,
      canUnlock: false,
      canSeeActivity: false,
      canViewDrafts: true,
    });
  });

  it('an accepted student with a pending TEACHER invite reveals all and cannot unlock', async () => {
    expect(await viewerOf([row('STUDENT'), row('TEACHER', false)])).toMatchObject({
      role: 'TEACHER',
      acceptedRole: 'STUDENT',
      student: true,
      canEditAnyState: true,
      revealAll: true,
      canUnlock: false,
      canSeeActivity: false,
    });
  });

  it('a pending ASSISTANT neither edits nor reveals, but may open drafts', async () => {
    expect(await viewerOf([row('ASSISTANT', false)])).toMatchObject({
      role: 'ASSISTANT',
      acceptedRole: null,
      canEditAnyState: false,
      revealAll: false,
      canViewDrafts: true,
      canUnlock: false,
      canSeeActivity: false,
    });
  });

  it('is nothing without a membership or with unusable ids (no query)', async () => {
    expect(await viewerOf([])).toEqual(sections.NO_SECTION_VIEWER);

    db.membershipFindMany.mockClear();
    for (const id of UNUSABLE_IDS) {
      expect(await sections.sectionViewer({ userId: id as string, classroomId: 'c-1' })).toEqual(
        sections.NO_SECTION_VIEWER
      );
      expect(await sections.sectionViewer({ userId: 'u-1', classroomId: id as string })).toEqual(
        sections.NO_SECTION_VIEWER
      );
    }
    expect(db.membershipFindMany).not.toHaveBeenCalled();
  });
});

describe('readerState', () => {
  it('reads this user on this page only', async () => {
    db.checkFindMany.mockResolvedValue([{ block_id: 'h-1' }]);
    db.unlockFindMany.mockResolvedValue([
      { block_id: 'l-1', unlocked_at: new Date('2026-10-12T10:00:00Z') },
    ]);

    expect(await sections.readerState({ pageId: 'p-1', userId: 'u-1' })).toEqual({
      checked: ['h-1'],
      unlocked: { 'l-1': '2026-10-12T10:00:00.000Z' },
    });
    expect(db.checkFindMany.mock.calls[0][0].where).toEqual({ page_id: 'p-1', user_id: 'u-1' });
    expect(db.unlockFindMany.mock.calls[0][0].where).toEqual({ page_id: 'p-1', user_id: 'u-1' });
  });

  it('is empty without querying for unusable ids', async () => {
    for (const id of UNUSABLE_IDS) {
      expect(await sections.readerState({ pageId: id as string, userId: 'u-1' })).toEqual({
        checked: [],
        unlocked: {},
      });
      expect(await sections.readerState({ pageId: 'p-1', userId: id as string })).toEqual({
        checked: [],
        unlocked: {},
      });
    }
    expect(db.checkFindMany).not.toHaveBeenCalled();
    expect(db.unlockFindMany).not.toHaveBeenCalled();
  });
});

describe('setChecked', () => {
  it('creates the row with skipDuplicates and reports a change', async () => {
    db.checkCreateMany.mockResolvedValue({ count: 1 });
    await expect(
      sections.setChecked({ pageId: 'p-1', userId: 'u-1', blockId: 'h-1', checked: true })
    ).resolves.toEqual({ checked: true, changed: true });
    expect(db.checkCreateMany).toHaveBeenCalledWith({
      data: [{ page_id: 'p-1', user_id: 'u-1', block_id: 'h-1' }],
      skipDuplicates: true,
    });
  });

  it('reports no change when the check already exists (first row kept)', async () => {
    db.checkCreateMany.mockResolvedValue({ count: 0 });
    await expect(
      sections.setChecked({ pageId: 'p-1', userId: 'u-1', blockId: 'h-1', checked: true })
    ).resolves.toEqual({ checked: true, changed: false });
  });

  it('unchecks by all three ids together and reports a change', async () => {
    db.checkDeleteMany.mockResolvedValue({ count: 1 });
    await expect(
      sections.setChecked({ pageId: 'p-1', userId: 'u-1', blockId: 'h-1', checked: false })
    ).resolves.toEqual({ checked: false, changed: true });
    expect(db.checkDeleteMany).toHaveBeenCalledWith({
      where: { page_id: 'p-1', user_id: 'u-1', block_id: 'h-1' },
    });
  });

  it('reports no change when unchecking something that was not checked', async () => {
    db.checkDeleteMany.mockResolvedValue({ count: 0 });
    await expect(
      sections.setChecked({ pageId: 'p-1', userId: 'u-1', blockId: 'h-1', checked: false })
    ).resolves.toEqual({ checked: false, changed: false });
  });

  it('refuses unusable ids and values before writing', async () => {
    const base = { pageId: 'p-1', userId: 'u-1', blockId: 'h-1', checked: true };
    for (const id of UNUSABLE_IDS) {
      await expect(sections.setChecked({ ...base, pageId: id as string })).rejects.toBeInstanceOf(
        PageSectionsValidationError
      );
      await expect(sections.setChecked({ ...base, userId: id as string })).rejects.toBeInstanceOf(
        PageSectionsValidationError
      );
    }
    for (const id of UNUSABLE_BLOCK_IDS) {
      await expect(sections.setChecked({ ...base, blockId: id as string })).rejects.toBeInstanceOf(
        PageSectionsValidationError
      );
    }
    await expect(
      sections.setChecked({ ...base, checked: 'yes' as unknown as boolean })
    ).rejects.toBeInstanceOf(PageSectionsValidationError);
    expect(db.checkCreateMany).not.toHaveBeenCalled();
    expect(db.checkDeleteMany).not.toHaveBeenCalled();
  });
});

describe('recordUnlock', () => {
  const page = { id: 'p-1', classroom_id: 'c-1' };
  const key = { page_id: 'p-1', user_id: 'u-1', block_id: 'l-1' };

  it("creates the row with the page's classroom", async () => {
    const at = new Date('2026-10-12T10:00:00Z');
    db.unlockFindUnique.mockResolvedValue(null);
    db.unlockCreate.mockResolvedValue({ unlocked_at: at });

    expect(await sections.recordUnlock({ page, userId: 'u-1', blockId: 'l-1' })).toEqual({
      unlockedAt: at,
      created: true,
    });
    expect(db.unlockCreate).toHaveBeenCalledWith({
      data: { ...key, classroom_id: 'c-1' },
      select: { unlocked_at: true },
    });
  });

  it('keeps the first unlock', async () => {
    const first = new Date('2026-10-01T10:00:00Z');
    db.unlockFindUnique.mockResolvedValue({ unlocked_at: first });

    expect(await sections.recordUnlock({ page, userId: 'u-1', blockId: 'l-1' })).toEqual({
      unlockedAt: first,
      created: false,
    });
    expect(db.unlockCreate).not.toHaveBeenCalled();
  });

  it('returns the winning row when a concurrent unlock inserts first', async () => {
    const winner = new Date('2026-10-12T10:00:00Z');
    db.unlockFindUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({ unlocked_at: winner });
    db.unlockCreate.mockRejectedValue(Object.assign(new Error('dup'), { code: 'P2002' }));

    expect(await sections.recordUnlock({ page, userId: 'u-1', blockId: 'l-1' })).toEqual({
      unlockedAt: winner,
      created: false,
    });
    expect(db.unlockFindUnique).toHaveBeenLastCalledWith({
      where: { page_id_user_id_block_id: key },
      select: { unlocked_at: true },
    });
  });

  it('rethrows any other error', async () => {
    db.unlockFindUnique.mockResolvedValue(null);
    db.unlockCreate.mockRejectedValue(Object.assign(new Error('fk'), { code: 'P2003' }));
    await expect(sections.recordUnlock({ page, userId: 'u-1', blockId: 'l-1' })).rejects.toThrow(
      'fk'
    );
  });

  it('refuses unusable ids before reading or writing', async () => {
    for (const id of UNUSABLE_IDS) {
      for (const args of [
        { page: { id: id as string, classroom_id: 'c-1' }, userId: 'u-1', blockId: 'l-1' },
        { page: { id: 'p-1', classroom_id: id as string }, userId: 'u-1', blockId: 'l-1' },
        { page, userId: id as string, blockId: 'l-1' },
      ]) {
        await expect(sections.recordUnlock(args)).rejects.toBeInstanceOf(
          PageSectionsValidationError
        );
      }
    }
    for (const id of UNUSABLE_BLOCK_IDS) {
      await expect(
        sections.recordUnlock({ page, userId: 'u-1', blockId: id as string })
      ).rejects.toBeInstanceOf(PageSectionsValidationError);
    }
    await expect(
      sections.recordUnlock({ page: null as never, userId: 'u-1', blockId: 'l-1' })
    ).rejects.toBeInstanceOf(PageSectionsValidationError);
    expect(db.unlockFindUnique).not.toHaveBeenCalled();
    expect(db.unlockCreate).not.toHaveBeenCalled();
  });
});

describe('staff views', () => {
  const MEMBERS = [
    { user_id: 'student-a', role: 'STUDENT' },
    { user_id: 'student-b', role: 'STUDENT' },
    { user_id: 'owner', role: 'OWNER' },
    // Staff and student in one classroom: staff, never counted.
    { user_id: 'ta-student', role: 'STUDENT' },
    { user_id: 'ta-student', role: 'ASSISTANT' },
  ];

  it('asks whether the page is in the classroom, then counts current students only', async () => {
    db.pageFindFirst.mockResolvedValue({ id: 'p-1' });
    db.membershipFindMany.mockResolvedValue(MEMBERS);
    db.unlockGroupBy.mockResolvedValue([{ block_id: 'l-1', _count: { _all: 2 } }]);

    expect(await sections.unlockCounts({ pageId: 'p-1', classroomId: 'c-1' })).toEqual({
      students: 2,
      unlocks: { 'l-1': 2 },
    });
    expect(db.pageFindFirst).toHaveBeenCalledWith({
      where: { id: 'p-1', classroom_id: 'c-1' },
      select: { id: true },
    });
    expect(db.membershipFindMany).toHaveBeenCalledWith({
      where: { classroom_id: 'c-1', has_accepted_invite: true },
      select: { user_id: true, role: true },
    });
    expect(db.unlockGroupBy.mock.calls[0][0].where).toEqual({
      page_id: 'p-1',
      classroom_id: 'c-1',
      user_id: { in: ['student-a', 'student-b'] },
    });
  });

  it('scopes check counts by page and the current students', async () => {
    db.pageFindFirst.mockResolvedValue({ id: 'p-1' });
    db.membershipFindMany.mockResolvedValue(MEMBERS);
    db.checkGroupBy.mockResolvedValue([{ block_id: 'h-1', _count: { _all: 1 } }]);

    expect(await sections.checkCounts({ pageId: 'p-1', classroomId: 'c-1' })).toEqual({
      students: 2,
      checks: { 'h-1': 1 },
    });
    expect(db.checkGroupBy.mock.calls[0][0].where).toEqual({
      page_id: 'p-1',
      user_id: { in: ['student-a', 'student-b'] },
    });
  });

  it('answers null for a page outside the classroom without reading rows', async () => {
    db.pageFindFirst.mockResolvedValue(null);

    expect(await sections.unlockCounts({ pageId: 'p-other', classroomId: 'c-1' })).toBeNull();
    expect(await sections.checkCounts({ pageId: 'p-other', classroomId: 'c-1' })).toBeNull();
    expect(await sections.sectionActivity({ pageId: 'p-other', classroomId: 'c-1' })).toBeNull();
    expect(db.membershipFindMany).not.toHaveBeenCalled();
    expect(db.unlockGroupBy).not.toHaveBeenCalled();
    expect(db.checkGroupBy).not.toHaveBeenCalled();
    expect(db.unlockFindMany).not.toHaveBeenCalled();
    expect(db.checkFindMany).not.toHaveBeenCalled();
  });

  it('answers null for unusable ids without querying', async () => {
    for (const id of UNUSABLE_IDS) {
      for (const args of [
        { pageId: id as string, classroomId: 'c-1' },
        { pageId: 'p-1', classroomId: id as string },
      ]) {
        expect(await sections.unlockCounts(args)).toBeNull();
        expect(await sections.checkCounts(args)).toBeNull();
        expect(await sections.sectionActivity(args)).toBeNull();
      }
    }
    for (const id of UNUSABLE_BLOCK_IDS.filter(id => id !== undefined)) {
      expect(
        await sections.sectionActivity({ pageId: 'p-1', classroomId: 'c-1', blockId: id as string })
      ).toBeNull();
    }
    expect(db.pageFindFirst).not.toHaveBeenCalled();
  });

  it('lists activity newest first with the git login on the classroom provider', async () => {
    db.pageFindFirst.mockResolvedValue({ id: 'p-1' });
    db.membershipFindMany.mockResolvedValue(MEMBERS);
    const at = new Date('2026-10-12T10:00:00Z');
    const user = {
      id: 'student-a',
      name: 'Ada',
      image: 'https://avatars.example/ada.png',
      accounts: [
        { provider_id: 'gitlab', username: 'ada-gl' },
        { provider_id: 'github', username: 'ada-gh' },
      ],
    };
    db.unlockFindMany.mockResolvedValue([{ block_id: 'l-1', unlocked_at: at, user }]);
    db.checkFindMany.mockResolvedValue([{ block_id: 'h-1', checked_at: at, user }]);

    const activity = await sections.sectionActivity({
      pageId: 'p-1',
      classroomId: 'c-1',
      blockId: 'l-1',
    });

    const expected = {
      userId: 'student-a',
      name: 'Ada',
      login: 'ada-gh',
      avatarUrl: 'https://avatars.example/ada.png',
      at,
    };
    expect(activity).toEqual({
      students: 2,
      unlocks: [{ blockId: 'l-1', ...expected }],
      checks: [{ blockId: 'h-1', ...expected }],
    });
    const unlockQuery = db.unlockFindMany.mock.calls[0][0];
    expect(unlockQuery.where).toEqual({
      page_id: 'p-1',
      classroom_id: 'c-1',
      user_id: { in: ['student-a', 'student-b'] },
      block_id: 'l-1',
    });
    expect(unlockQuery.orderBy[0]).toEqual({ unlocked_at: 'desc' });
    const checkQuery = db.checkFindMany.mock.calls[0][0];
    expect(checkQuery.where).toEqual({
      page_id: 'p-1',
      user_id: { in: ['student-a', 'student-b'] },
      block_id: 'l-1',
    });
    expect(checkQuery.orderBy[0]).toEqual({ checked_at: 'desc' });
    // Never selects more of the user than the list shows.
    expect(Object.keys(unlockQuery.select.user.select).sort()).toEqual([
      'accounts',
      'id',
      'image',
      'name',
    ]);
  });

  it('reads no rows when the classroom has no current students', async () => {
    db.pageFindFirst.mockResolvedValue({ id: 'p-1' });
    db.membershipFindMany.mockResolvedValue([{ user_id: 'owner', role: 'OWNER' }]);

    expect(await sections.unlockCounts({ pageId: 'p-1', classroomId: 'c-1' })).toEqual({
      students: 0,
      unlocks: {},
    });
    expect(await sections.sectionActivity({ pageId: 'p-1', classroomId: 'c-1' })).toEqual({
      students: 0,
      unlocks: [],
      checks: [],
    });
    expect(db.unlockGroupBy).not.toHaveBeenCalled();
    expect(db.unlockFindMany).not.toHaveBeenCalled();
  });
});

describe('staff views handed the page row', () => {
  const MEMBERS = [
    { user_id: 'student-a', role: 'STUDENT' },
    { user_id: 'owner', role: 'OWNER' },
  ];
  const page = { id: 'p-1', classroom_id: 'c-1' };

  it("reads the row's own classroom and never re-queries the page", async () => {
    db.membershipFindMany.mockResolvedValue(MEMBERS);
    db.unlockGroupBy.mockResolvedValue([{ block_id: 'l-1', _count: { _all: 1 } }]);
    db.checkGroupBy.mockResolvedValue([]);
    db.unlockFindMany.mockResolvedValue([]);
    db.checkFindMany.mockResolvedValue([]);

    expect(await sections.unlockCounts({ page })).toEqual({
      students: 1,
      unlocks: { 'l-1': 1 },
    });
    expect(await sections.checkCounts({ page })).toEqual({ students: 1, checks: {} });
    expect(await sections.sectionActivity({ page })).toEqual({
      students: 1,
      unlocks: [],
      checks: [],
    });
    expect(db.pageFindFirst).not.toHaveBeenCalled();
    expect(db.unlockGroupBy.mock.calls[0][0].where).toEqual({
      page_id: 'p-1',
      classroom_id: 'c-1',
      user_id: { in: ['student-a'] },
    });
    expect(db.membershipFindMany.mock.calls[0][0].where).toEqual({
      classroom_id: 'c-1',
      has_accepted_invite: true,
    });
  });

  it('answers null for a malformed row without querying', async () => {
    for (const bad of [{ id: '', classroom_id: 'c-1' }, { id: 'p-1', classroom_id: 42 }, null]) {
      const ref = { page: bad as unknown as { id: string; classroom_id: string } };
      expect(await sections.unlockCounts(ref)).toBeNull();
      expect(await sections.sectionActivity(ref)).toBeNull();
    }
    expect(db.membershipFindMany).not.toHaveBeenCalled();
    expect(db.pageFindFirst).not.toHaveBeenCalled();
  });

  it("`only: 'unlocks'` never queries checks, and `only: 'checks'` never queries unlocks", async () => {
    db.membershipFindMany.mockResolvedValue(MEMBERS);
    db.unlockFindMany.mockResolvedValue([]);
    db.checkFindMany.mockResolvedValue([]);

    await sections.sectionActivity({ page, blockId: 'l-1', only: 'unlocks' });
    expect(db.unlockFindMany).toHaveBeenCalledTimes(1);
    expect(db.checkFindMany).not.toHaveBeenCalled();

    db.unlockFindMany.mockClear();
    await sections.sectionActivity({ page, only: 'checks' });
    expect(db.checkFindMany).toHaveBeenCalledTimes(1);
    expect(db.unlockFindMany).not.toHaveBeenCalled();
  });
});
