import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The page and slide limits. What matters: Pro comes from the one resolver,
 * the count is scoped to the classroom asked about, and a free class at its
 * limit is refused with the shared code and sentence.
 */

const getProStateForClassroomIdMock = vi.fn();
const pageCountMock = vi.fn();
const slideCountMock = vi.fn();

vi.mock('../subscription.service.ts', () => ({
  getProStateForClassroomId: (...a: unknown[]) => getProStateForClassroomIdMock(...a),
}));

vi.mock('@classmoji/database', () => ({
  default: () => ({
    page: { count: (...a: unknown[]) => pageCountMock(...a) },
    slide: { count: (...a: unknown[]) => slideCountMock(...a) },
  }),
}));

const {
  assertCanCreateContent,
  contentAllowance,
  isContentLimitError,
  PLAN_ACTIVE_CLASSROOM_LIMITS,
  PLAN_CONTENT_LIMITS,
  PLAN_CONTENT_LIMIT,
} = await import('../planLimits.ts');

const FREE = { isPro: false, tier: 'FREE', isActive: true };
const PRO = { isPro: true, tier: 'PRO', isActive: true };

beforeEach(() => {
  vi.clearAllMocks();
});

describe('contentAllowance', () => {
  it('counts a free classroom against the free limit, scoped to that classroom', async () => {
    getProStateForClassroomIdMock.mockResolvedValue(FREE);
    pageCountMock.mockResolvedValue(4);

    expect(await contentAllowance('class-x', 'pages')).toEqual({
      limit: PLAN_CONTENT_LIMITS.FREE.pages,
      used: 4,
      remaining: PLAN_CONTENT_LIMITS.FREE.pages! - 4,
    });
    expect(getProStateForClassroomIdMock).toHaveBeenCalledWith('class-x');
    expect(pageCountMock).toHaveBeenCalledWith({ where: { classroom_id: 'class-x' } });
    expect(slideCountMock).not.toHaveBeenCalled();
  });

  it('counts slides in their own table', async () => {
    getProStateForClassroomIdMock.mockResolvedValue(FREE);
    slideCountMock.mockResolvedValue(10);

    expect(await contentAllowance('class-y', 'slides')).toMatchObject({ used: 10, remaining: 0 });
    expect(slideCountMock).toHaveBeenCalledWith({ where: { classroom_id: 'class-y' } });
    expect(pageCountMock).not.toHaveBeenCalled();
  });

  it('never goes negative for a class already over the limit', async () => {
    getProStateForClassroomIdMock.mockResolvedValue(FREE);
    pageCountMock.mockResolvedValue(25);

    expect(await contentAllowance('class-x', 'pages')).toMatchObject({ used: 25, remaining: 0 });
  });

  it('is unlimited on Pro, without counting', async () => {
    getProStateForClassroomIdMock.mockResolvedValue(PRO);

    expect(await contentAllowance('class-x', 'pages')).toEqual({
      limit: null,
      used: 0,
      remaining: null,
    });
    expect(pageCountMock).not.toHaveBeenCalled();
  });
});

describe('assertCanCreateContent', () => {
  it('allows the last free slot', async () => {
    getProStateForClassroomIdMock.mockResolvedValue(FREE);
    pageCountMock.mockResolvedValue(9);

    await expect(assertCanCreateContent('class-x', 'pages')).resolves.toBeUndefined();
  });

  it('refuses at the limit with the shared code and sentence', async () => {
    getProStateForClassroomIdMock.mockResolvedValue(FREE);
    slideCountMock.mockResolvedValue(10);

    const error = await assertCanCreateContent('class-x', 'slides').catch(e => e);

    expect(isContentLimitError(error)).toBe(true);
    expect(error).toMatchObject({ code: PLAN_CONTENT_LIMIT, kind: 'slides', limit: 10, used: 10 });
    expect(error.message).toBe(
      'Free classes can have up to 10 slides. Upgrade to Pro for unlimited slides.'
    );
  });

  it('refuses a batch that would not fit, even with room for some of it', async () => {
    getProStateForClassroomIdMock.mockResolvedValue(FREE);
    pageCountMock.mockResolvedValue(8);

    await expect(assertCanCreateContent('class-x', 'pages', 3)).rejects.toMatchObject({
      code: PLAN_CONTENT_LIMIT,
    });
  });

  it("does not let one classroom's count refuse another", async () => {
    getProStateForClassroomIdMock.mockResolvedValue(FREE);
    pageCountMock.mockImplementation(async ({ where }: { where: { classroom_id: string } }) =>
      where.classroom_id === 'full-class' ? 10 : 0
    );

    await expect(assertCanCreateContent('full-class', 'pages')).rejects.toMatchObject({
      code: PLAN_CONTENT_LIMIT,
    });
    await expect(assertCanCreateContent('empty-class', 'pages')).resolves.toBeUndefined();
  });

  it('never refuses a Pro classroom', async () => {
    getProStateForClassroomIdMock.mockResolvedValue(PRO);

    await expect(assertCanCreateContent('class-x', 'slides', 500)).resolves.toBeUndefined();
  });
});

describe('PLAN_ACTIVE_CLASSROOM_LIMITS', () => {
  it('does not limit how many classes a Free teacher runs', () => {
    // Decided 2026-10-21: the rule exists, switched off. Changing this is a
    // product decision, not a refactor.
    expect(PLAN_ACTIVE_CLASSROOM_LIMITS).toEqual({ FREE: null, PRO: null });
  });
});
