import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The page and slide limits. What matters: Pro comes from the one resolver,
 * the count is scoped to the classroom asked about, a free class at its limit
 * is refused with the shared code and sentence, and only slide DECKS count
 * toward the slide limit (uploaded files and links never do).
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
  assertCanCreateSlide,
  contentAllowance,
  contentLimitMessage,
  countsTowardSlideLimit,
  isContentLimitError,
  PLAN_ACTIVE_CLASSROOM_LIMITS,
  PLAN_CONTENT_LIMITS,
  PLAN_CONTENT_LIMIT,
  skippedOverLimitText,
  slidesWithinAllowance,
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

  it('counts slide decks in their own table, never files or links', async () => {
    getProStateForClassroomIdMock.mockResolvedValue(FREE);
    slideCountMock.mockResolvedValue(10);

    expect(await contentAllowance('class-y', 'slides')).toMatchObject({ used: 10, remaining: 0 });
    expect(slideCountMock).toHaveBeenCalledWith({
      where: { classroom_id: 'class-y', kind: 'DECK' },
    });
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
    pageCountMock.mockResolvedValue(10);

    const error = await assertCanCreateContent('class-x', 'pages').catch(e => e);

    expect(isContentLimitError(error)).toBe(true);
    expect(error).toMatchObject({ code: PLAN_CONTENT_LIMIT, kind: 'pages', limit: 10, used: 10 });
    expect(error.message).toBe(
      'Free classes can have up to 10 pages. Upgrade to Pro for unlimited pages.'
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

    await expect(assertCanCreateContent('class-x', 'pages', 500)).resolves.toBeUndefined();
  });
});

describe('assertCanCreateSlide', () => {
  it('refuses a deck at the limit, with the deck sentence', async () => {
    getProStateForClassroomIdMock.mockResolvedValue(FREE);
    slideCountMock.mockResolvedValue(10);

    const error = await assertCanCreateSlide('class-x', 'DECK').catch(e => e);

    expect(isContentLimitError(error)).toBe(true);
    expect(error).toMatchObject({ code: PLAN_CONTENT_LIMIT, kind: 'slides', limit: 10, used: 10 });
    expect(error.message).toBe(
      "Free classes can have up to 10 slide decks. Uploaded files and links don't count. " +
        'Upgrade to Pro for unlimited slide decks.'
    );
    expect(slideCountMock).toHaveBeenCalledWith({
      where: { classroom_id: 'class-x', kind: 'DECK' },
    });
  });

  it('allows the last free deck', async () => {
    getProStateForClassroomIdMock.mockResolvedValue(FREE);
    slideCountMock.mockResolvedValue(9);

    await expect(assertCanCreateSlide('class-x', 'DECK')).resolves.toBeUndefined();
  });

  it.each(['FILE', 'LINK'] as const)(
    'never refuses a %s slide, even in a free class far over the deck limit',
    async kind => {
      getProStateForClassroomIdMock.mockResolvedValue(FREE);
      slideCountMock.mockResolvedValue(40);

      await expect(assertCanCreateSlide('class-x', kind)).resolves.toBeUndefined();
      // Not counted at all: the kind decides before any read.
      expect(getProStateForClassroomIdMock).not.toHaveBeenCalled();
      expect(slideCountMock).not.toHaveBeenCalled();
    }
  );

  it('never refuses a deck in a Pro classroom', async () => {
    getProStateForClassroomIdMock.mockResolvedValue(PRO);

    await expect(assertCanCreateSlide('class-x', 'DECK', 500)).resolves.toBeUndefined();
    expect(slideCountMock).not.toHaveBeenCalled();
  });
});

describe('countsTowardSlideLimit', () => {
  it('counts decks only', () => {
    expect(countsTowardSlideLimit('DECK')).toBe(true);
    expect(countsTowardSlideLimit('FILE')).toBe(false);
    expect(countsTowardSlideLimit('LINK')).toBe(false);
  });
});

describe('slidesWithinAllowance', () => {
  const rows = [
    { id: 'd1', kind: 'DECK' as const },
    { id: 'f1', kind: 'FILE' as const },
    { id: 'd2', kind: 'DECK' as const },
    { id: 'l1', kind: 'LINK' as const },
    { id: 'd3', kind: 'DECK' as const },
    { id: 'f2', kind: 'FILE' as const },
  ];

  it('keeps every file and link and the first decks that fit, in order', () => {
    expect(slidesWithinAllowance(rows, 1)).toEqual({
      kept: [rows[0], rows[1], rows[3], rows[5]],
      skipped: 2,
    });
  });

  it('keeps files and links when no deck fits', () => {
    const { kept, skipped } = slidesWithinAllowance(rows, 0);
    expect(kept.map(r => r.id)).toEqual(['f1', 'l1', 'f2']);
    expect(skipped).toBe(3);
  });

  it('keeps everything with room for every deck, or no limit', () => {
    expect(slidesWithinAllowance(rows, 3)).toEqual({ kept: rows, skipped: 0 });
    expect(slidesWithinAllowance(rows, null)).toEqual({ kept: rows, skipped: 0 });
  });
});

describe('contentLimitMessage', () => {
  it('names decks for the slide limit and pages for the page limit', () => {
    expect(contentLimitMessage('slides', 10)).toBe(
      "Free classes can have up to 10 slide decks. Uploaded files and links don't count. " +
        'Upgrade to Pro for unlimited slide decks.'
    );
    expect(contentLimitMessage('pages', 10)).toBe(
      'Free classes can have up to 10 pages. Upgrade to Pro for unlimited pages.'
    );
  });
});

describe('PLAN_ACTIVE_CLASSROOM_LIMITS', () => {
  it('does not limit how many classes a Free teacher runs', () => {
    // Decided 2026-10-21: the rule exists, switched off. Changing this is a
    // product decision, not a refactor.
    expect(PLAN_ACTIVE_CLASSROOM_LIMITS).toEqual({ FREE: null, PRO: null });
  });
});

describe('skippedOverLimitText', () => {
  it('counts what an import left out, singular and plural, then the limit sentence', () => {
    expect(skippedOverLimitText('slides', 1, 10)).toBe(
      'skipped 1 slide deck. Free classes can have up to 10 slide decks. ' +
        "Uploaded files and links don't count. Upgrade to Pro for unlimited slide decks."
    );
    expect(skippedOverLimitText('slides', 3, 10)).toMatch(/^skipped 3 slide decks\. /);
    expect(skippedOverLimitText('pages', 1, 10)).toBe(
      'skipped 1 page. Free classes can have up to 10 pages. Upgrade to Pro for unlimited pages.'
    );
    expect(skippedOverLimitText('pages', 3, 10)).toMatch(/^skipped 3 pages\. /);
  });
});
