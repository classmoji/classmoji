import { describe, it, expect, vi, beforeEach } from 'vitest';

// site.service holds every visibility decision the anonymous web makes, so the
// tests below are mostly about what a viewer must NOT see. Prisma is mocked;
// @classmoji/utils is deliberately NOT — the subdomain regex and the reserved
// registries are the things under test, and a stub would test the stub.

const classroomSiteFindUnique = vi.fn();
const classroomSiteUpsert = vi.fn();
const classroomSiteUpdate = vi.fn();
const classroomFindUnique = vi.fn();
const pageFindFirst = vi.fn();
const moduleFindMany = vi.fn();

vi.mock('@classmoji/database', () => ({
  default: () => ({
    classroomSite: {
      findUnique: classroomSiteFindUnique,
      upsert: classroomSiteUpsert,
      update: classroomSiteUpdate,
    },
    classroom: { findUnique: classroomFindUnique },
    page: { findFirst: pageFindFirst },
    module: { findMany: moduleFindMany },
  }),
}));

const {
  SITE_ERROR,
  checkSubdomainAvailability,
  getHomePageForViewer,
  getPageBySlugForSite,
  getSiteBySubdomain,
  isPageVisibleOnSite,
  listPublicModulesForViewer,
  upsertSiteSettings,
  validateAndClaimSubdomain,
} = await import('../site.service.ts');

const activeClassroom = {
  id: 'class-1',
  slug: 'cs52',
  name: 'CS 52',
  status: 'ACTIVE',
  is_archived: false,
};

const siteRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'site-1',
  classroom_id: 'class-1',
  subdomain: 'cs52',
  is_enabled: true,
  home_page_id: 'page-1',
  show_schedule: true,
  classroom: activeClassroom,
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('site.checkSubdomainAvailability', () => {
  it('accepts a well-formed label nobody holds', async () => {
    classroomSiteFindUnique.mockResolvedValue(null);
    await expect(checkSubdomainAvailability('cs52')).resolves.toEqual({
      available: true,
      normalized: 'cs52',
    });
  });

  it('normalizes case and surrounding whitespace before deciding', async () => {
    // Hostnames are case-insensitive; the unique index is not. If this did not
    // normalize, `CS52` and `cs52` would be two rows for one site.
    classroomSiteFindUnique.mockResolvedValue(null);
    const result = await checkSubdomainAvailability('  CS52  ');
    expect(result).toEqual({ available: true, normalized: 'cs52' });
    expect(classroomSiteFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { subdomain: 'cs52' } })
    );
  });

  it.each([
    ['-leading-hyphen', 'a hyphen at the start is not a legal DNS label'],
    ['trailing-hyphen-', 'nor at the end'],
    ['under_score', 'underscores are not legal in a hostname'],
    ['has space', 'spaces are not legal'],
    ['', 'empty'],
    ['a'.repeat(64), '63 characters is the label limit'],
  ])('rejects %s as SUBDOMAIN_INVALID', async input => {
    await expect(checkSubdomainAvailability(input)).resolves.toMatchObject({
      available: false,
      reason: SITE_ERROR.SUBDOMAIN_INVALID,
    });
    // Never reached the database — invalid shapes are refused before the query.
    expect(classroomSiteFindUnique).not.toHaveBeenCalled();
  });

  it('accepts exactly 63 characters', async () => {
    classroomSiteFindUnique.mockResolvedValue(null);
    await expect(checkSubdomainAvailability('a'.repeat(63))).resolves.toMatchObject({
      available: true,
    });
  });

  it.each(['app', 'www', 'api', 'admin', 'classmoji', 'mail', 'status'])(
    'refuses the reserved label %s',
    async label => {
      await expect(checkSubdomainAvailability(label)).resolves.toMatchObject({
        available: false,
        reason: SITE_ERROR.SUBDOMAIN_RESERVED,
      });
    }
  );

  it('reports a label another classroom holds as taken', async () => {
    classroomSiteFindUnique.mockResolvedValue({ classroom_id: 'class-2' });
    await expect(checkSubdomainAvailability('cs52')).resolves.toMatchObject({
      available: false,
      reason: SITE_ERROR.SUBDOMAIN_TAKEN,
    });
  });

  it('does not report a classroom as blocking itself', async () => {
    classroomSiteFindUnique.mockResolvedValue({ classroom_id: 'class-1' });
    await expect(checkSubdomainAvailability('cs52', 'class-1')).resolves.toMatchObject({
      available: true,
    });
  });
});

describe('site.validateAndClaimSubdomain', () => {
  beforeEach(() => {
    classroomFindUnique.mockResolvedValue({ id: 'class-1', is_example: false });
    classroomSiteFindUnique.mockResolvedValue(null);
  });

  it('upserts the normalized label and leaves the site switched off', async () => {
    classroomSiteUpsert.mockResolvedValue(siteRow({ is_enabled: false }));
    await validateAndClaimSubdomain('class-1', 'CS52');

    const arg = classroomSiteUpsert.mock.calls[0][0] as {
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    };
    expect(arg.create).toEqual({ classroom_id: 'class-1', subdomain: 'cs52' });
    expect(arg.update).toEqual({ subdomain: 'cs52' });
    // Claiming a subdomain must not publish anything — enabling needs a home page.
    expect(arg.create).not.toHaveProperty('is_enabled');
  });

  it.each([
    ['not a label', 'SUBDOMAIN_INVALID'],
    ['app', 'SUBDOMAIN_RESERVED'],
  ])('rejects %s with %s', async (input, code) => {
    await expect(validateAndClaimSubdomain('class-1', input)).rejects.toMatchObject({ code });
    expect(classroomSiteUpsert).not.toHaveBeenCalled();
  });

  it('rejects a label another classroom already holds', async () => {
    classroomSiteFindUnique.mockResolvedValue({ classroom_id: 'class-2' });
    await expect(validateAndClaimSubdomain('class-1', 'cs52')).rejects.toMatchObject({
      code: SITE_ERROR.SUBDOMAIN_TAKEN,
    });
  });

  it('maps a P2002 race on the subdomain index to SUBDOMAIN_TAKEN', async () => {
    // The availability check is advisory: another classroom can claim the label
    // between the read and the write. The index is the authority.
    classroomSiteUpsert.mockRejectedValue(
      Object.assign(new Error('Unique constraint'), {
        code: 'P2002',
        meta: { target: ['subdomain'] },
      })
    );
    await expect(validateAndClaimSubdomain('class-1', 'cs52')).rejects.toMatchObject({
      code: SITE_ERROR.SUBDOMAIN_TAKEN,
    });
  });

  it('propagates an unrelated write failure untouched', async () => {
    classroomSiteUpsert.mockRejectedValue(new Error('connection reset'));
    await expect(validateAndClaimSubdomain('class-1', 'cs52')).rejects.toThrow('connection reset');
  });

  it('refuses example classrooms', async () => {
    classroomFindUnique.mockResolvedValue({ id: 'class-1', is_example: true });
    await expect(validateAndClaimSubdomain('class-1', 'cs52')).rejects.toMatchObject({
      code: SITE_ERROR.CLASSROOM_NOT_ELIGIBLE,
    });
    expect(classroomSiteUpsert).not.toHaveBeenCalled();
  });
});

describe('site.getSiteBySubdomain', () => {
  it('is not_found for an unclaimed label, without leaking why', async () => {
    classroomSiteFindUnique.mockResolvedValue(null);
    await expect(getSiteBySubdomain('nobody')).resolves.toEqual({ state: 'not_found' });
  });

  it('is not_found for a malformed host label, before touching the database', async () => {
    await expect(getSiteBySubdomain('not a label')).resolves.toEqual({ state: 'not_found' });
    expect(classroomSiteFindUnique).not.toHaveBeenCalled();
  });

  it('normalizes the host label', async () => {
    classroomSiteFindUnique.mockResolvedValue(siteRow());
    await getSiteBySubdomain('CS52');
    expect(classroomSiteFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { subdomain: 'cs52' } })
    );
  });

  it('is disabled when the row exists but the switch is off', async () => {
    classroomSiteFindUnique.mockResolvedValue(siteRow({ is_enabled: false }));
    await expect(getSiteBySubdomain('cs52')).resolves.toMatchObject({ state: 'disabled' });
  });

  it('prefers disabled over unavailable — the nearer, fixable cause', async () => {
    classroomSiteFindUnique.mockResolvedValue(
      siteRow({ is_enabled: false, classroom: { ...activeClassroom, is_archived: true } })
    );
    await expect(getSiteBySubdomain('cs52')).resolves.toMatchObject({ state: 'disabled' });
  });

  it.each<[Record<string, unknown>, string]>([
    [{ is_archived: true }, 'an archived classroom'],
    [{ status: 'UNPUBLISHED' }, 'a classroom that was never opened'],
  ])('is unavailable for %s (%s)', async overrides => {
    classroomSiteFindUnique.mockResolvedValue(
      siteRow({ classroom: { ...activeClassroom, ...overrides } })
    );
    await expect(getSiteBySubdomain('cs52')).resolves.toMatchObject({ state: 'unavailable' });
  });

  it('keeps serving a LOCKED classroom — a finished course stays linkable', async () => {
    classroomSiteFindUnique.mockResolvedValue(
      siteRow({ classroom: { ...activeClassroom, status: 'LOCKED' } })
    );
    await expect(getSiteBySubdomain('cs52')).resolves.toMatchObject({ state: 'active' });
  });

  it('never selects the settings record wholesale (it holds LLM API keys)', async () => {
    classroomSiteFindUnique.mockResolvedValue(siteRow());
    await getSiteBySubdomain('cs52');
    const arg = classroomSiteFindUnique.mock.calls[0][0] as {
      include: { classroom: { select: Record<string, unknown> } };
    };
    const select = arg.include.classroom.select;
    expect(select.settings).toEqual({ select: { theme: true } });
    expect(select.git_organization).toEqual({
      select: { id: true, login: true, provider: true },
    });
  });
});

describe('site.upsertSiteSettings', () => {
  it('refuses to enable a site with no home page', async () => {
    classroomSiteFindUnique.mockResolvedValue({
      classroom_id: 'class-1',
      is_enabled: false,
      home_page_id: null,
    });
    await expect(upsertSiteSettings('class-1', { is_enabled: true })).rejects.toMatchObject({
      code: SITE_ERROR.HOME_PAGE_REQUIRED,
    });
    expect(classroomSiteUpdate).not.toHaveBeenCalled();
  });

  it('refuses to clear the home page of a site that is already live', async () => {
    // The rule is evaluated on the RESULTING row, so there is no "it was already
    // enabled" escape hatch.
    classroomSiteFindUnique.mockResolvedValue({
      classroom_id: 'class-1',
      is_enabled: true,
      home_page_id: 'page-1',
    });
    await expect(upsertSiteSettings('class-1', { home_page_id: null })).rejects.toMatchObject({
      code: SITE_ERROR.HOME_PAGE_REQUIRED,
    });
  });

  it('allows clearing the home page while switching the site off', async () => {
    classroomSiteFindUnique.mockResolvedValue({
      classroom_id: 'class-1',
      is_enabled: true,
      home_page_id: 'page-1',
    });
    classroomSiteUpdate.mockResolvedValue({});
    await upsertSiteSettings('class-1', { is_enabled: false, home_page_id: null });
    expect(classroomSiteUpdate).toHaveBeenCalled();
  });

  it('rejects a home page belonging to another classroom', async () => {
    // The FK references pages(id) globally and would happily accept it; only a
    // classroom-scoped read can refuse.
    classroomSiteFindUnique.mockResolvedValue({
      classroom_id: 'class-1',
      is_enabled: false,
      home_page_id: null,
    });
    pageFindFirst.mockResolvedValue(null);

    await expect(
      upsertSiteSettings('class-1', { home_page_id: 'other-classroom-page' })
    ).rejects.toMatchObject({ code: SITE_ERROR.HOME_PAGE_INVALID });

    expect(pageFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'other-classroom-page', classroom_id: 'class-1' },
      })
    );
    expect(classroomSiteUpdate).not.toHaveBeenCalled();
  });

  it('rejects a draft home page', async () => {
    classroomSiteFindUnique.mockResolvedValue({
      classroom_id: 'class-1',
      is_enabled: false,
      home_page_id: null,
    });
    pageFindFirst.mockResolvedValue({ id: 'page-1', is_draft: true });
    await expect(
      upsertSiteSettings('class-1', { home_page_id: 'page-1', is_enabled: true })
    ).rejects.toMatchObject({ code: SITE_ERROR.HOME_PAGE_INVALID });
  });

  it('enables when the same call supplies a valid home page', async () => {
    classroomSiteFindUnique.mockResolvedValue({
      classroom_id: 'class-1',
      is_enabled: false,
      home_page_id: null,
    });
    pageFindFirst.mockResolvedValue({ id: 'page-1', is_draft: false });
    classroomSiteUpdate.mockResolvedValue({});

    await upsertSiteSettings('class-1', { home_page_id: 'page-1', is_enabled: true });

    expect((classroomSiteUpdate.mock.calls[0][0] as { data: unknown }).data).toEqual({
      is_enabled: true,
      home_page_id: 'page-1',
    });
  });

  it('leaves omitted fields alone', async () => {
    classroomSiteFindUnique.mockResolvedValue({
      classroom_id: 'class-1',
      is_enabled: true,
      home_page_id: 'page-1',
    });
    // The site stays enabled, so its stored home page is re-vetted even though
    // this patch never mentions it — see 'enable-only' below.
    pageFindFirst.mockResolvedValue({ id: 'page-1', is_draft: false });
    classroomSiteUpdate.mockResolvedValue({});
    await upsertSiteSettings('class-1', { show_schedule: false });
    expect((classroomSiteUpdate.mock.calls[0][0] as { data: unknown }).data).toEqual({
      show_schedule: false,
    });
  });

  // ── The resulting home page, not the one in the patch ─────────────────────
  // An enable-only patch names no page, so a check keyed off `input.home_page_id`
  // never fires for it — and the site goes live pointed at whatever it already
  // stored, which may have been unpublished or moved since it was chosen.

  it('refuses an enable-only patch when the STORED home page is now a draft', async () => {
    classroomSiteFindUnique.mockResolvedValue({
      classroom_id: 'class-1',
      is_enabled: false,
      home_page_id: 'page-1',
    });
    pageFindFirst.mockResolvedValue({ id: 'page-1', is_draft: true });

    await expect(upsertSiteSettings('class-1', { is_enabled: true })).rejects.toMatchObject({
      code: SITE_ERROR.HOME_PAGE_INVALID,
    });
    // Vetted the stored id, scoped to the classroom — not the (absent) patch value.
    expect(pageFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'page-1', classroom_id: 'class-1' } })
    );
    expect(classroomSiteUpdate).not.toHaveBeenCalled();
  });

  it('refuses an enable-only patch when the STORED home page now belongs to another classroom', async () => {
    // A page can be moved (or the row replaced) after it was nominated. The FK
    // still points at a live `pages` row, so only the classroom-scoped read
    // notices — which resolves to null here.
    classroomSiteFindUnique.mockResolvedValue({
      classroom_id: 'class-1',
      is_enabled: false,
      home_page_id: 'page-moved',
    });
    pageFindFirst.mockResolvedValue(null);

    await expect(upsertSiteSettings('class-1', { is_enabled: true })).rejects.toMatchObject({
      code: SITE_ERROR.HOME_PAGE_INVALID,
    });
    expect(classroomSiteUpdate).not.toHaveBeenCalled();
  });

  it('enables on an enable-only patch when the stored home page is still published here', async () => {
    classroomSiteFindUnique.mockResolvedValue({
      classroom_id: 'class-1',
      is_enabled: false,
      home_page_id: 'page-1',
    });
    pageFindFirst.mockResolvedValue({ id: 'page-1', is_draft: false });
    classroomSiteUpdate.mockResolvedValue({});

    await upsertSiteSettings('class-1', { is_enabled: true });

    // Only the field that was patched is written — the re-vetting must not
    // rewrite home_page_id back onto the row.
    expect((classroomSiteUpdate.mock.calls[0][0] as { data: unknown }).data).toEqual({
      is_enabled: true,
    });
  });

  it('does not re-vet a stored home page while the site stays off', async () => {
    // Nothing is public, and an admin editing an unrelated toggle cannot act on
    // "your home page is a draft" from that form.
    classroomSiteFindUnique.mockResolvedValue({
      classroom_id: 'class-1',
      is_enabled: false,
      home_page_id: 'page-1',
    });
    classroomSiteUpdate.mockResolvedValue({});

    await upsertSiteSettings('class-1', { show_schedule: true });

    expect(pageFindFirst).not.toHaveBeenCalled();
    expect(classroomSiteUpdate).toHaveBeenCalled();
  });

  it('refuses when the classroom has no site row yet', async () => {
    classroomSiteFindUnique.mockResolvedValue(null);
    await expect(upsertSiteSettings('class-1', { show_schedule: true })).rejects.toMatchObject({
      code: SITE_ERROR.SITE_NOT_FOUND,
    });
  });
});

describe('site.isPageVisibleOnSite', () => {
  const truthTable: Array<[boolean, boolean, string | null, boolean]> = [
    // is_draft, is_public, role,      visible
    [false, true, null, true], //   published + public → anyone
    [false, false, null, false], //  published, members-only → not anonymous
    [false, false, 'STUDENT', true], // …but any member sees it
    [false, false, 'OWNER', true],
    [true, true, null, false], //    a draft never serves, public or not
    [true, true, 'OWNER', false], //  …not even to the owner
    [true, false, 'TEACHER', false],
  ];

  it.each(truthTable)(
    'is_draft=%s is_public=%s role=%s → %s',
    (is_draft, is_public, role, expected) => {
      expect(isPageVisibleOnSite({ is_draft, is_public }, role as never)).toBe(expected);
    }
  );
});

describe('site.getHomePageForViewer', () => {
  it('is null when the home page was deleted out from under the site', async () => {
    // ON DELETE SET NULL: losing the page must not delete the site row.
    await expect(
      getHomePageForViewer({ classroom_id: 'class-1', home_page_id: null }, null)
    ).resolves.toBeNull();
    expect(pageFindFirst).not.toHaveBeenCalled();
  });

  it('returns the page when the viewer may see it', async () => {
    pageFindFirst.mockResolvedValue({ id: 'page-1', is_draft: false, is_public: true });
    await expect(
      getHomePageForViewer({ classroom_id: 'class-1', home_page_id: 'page-1' }, null)
    ).resolves.toMatchObject({ id: 'page-1' });
  });

  it('is null — with NO fallback page — for an anonymous viewer of a members-only home', async () => {
    // Deliberately no "first public page" substitute: that would publish a page
    // the instructor never nominated.
    pageFindFirst.mockResolvedValue({ id: 'page-1', is_draft: false, is_public: false });
    await expect(
      getHomePageForViewer({ classroom_id: 'class-1', home_page_id: 'page-1' }, null)
    ).resolves.toBeNull();
  });

  it('scopes the lookup to the classroom', async () => {
    pageFindFirst.mockResolvedValue(null);
    await getHomePageForViewer({ classroom_id: 'class-1', home_page_id: 'page-1' }, 'OWNER');
    expect(pageFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'page-1', classroom_id: 'class-1' } })
    );
  });
});

describe('site.getPageBySlugForSite', () => {
  it('resolves by slug first, and never runs the id query when the slug matches', async () => {
    // Determinism: slugs are author-controlled text, so a page could be titled
    // after another page's uuid. Slug always wins.
    pageFindFirst.mockResolvedValueOnce({ id: 'page-9', slug: 'page-1' });

    const page = await getPageBySlugForSite('class-1', 'page-1');

    expect(page).toMatchObject({ id: 'page-9' });
    expect(pageFindFirst).toHaveBeenCalledTimes(1);
    expect(pageFindFirst).toHaveBeenCalledWith({
      where: { classroom_id: 'class-1', slug: 'page-1' },
    });
  });

  it('falls back to a classroom-scoped id lookup when no slug matches', async () => {
    pageFindFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'page-1', slug: null });

    const page = await getPageBySlugForSite('class-1', 'page-1');

    expect(page).toMatchObject({ id: 'page-1' });
    expect(pageFindFirst).toHaveBeenNthCalledWith(2, {
      where: { classroom_id: 'class-1', id: 'page-1' },
    });
  });
});

describe('site.listPublicModulesForViewer', () => {
  const modules = [
    {
      id: 'mod-1',
      title: 'Week 1',
      items: [
        { id: 'i1', item_type: 'PAGE', page: { id: 'p1', is_draft: false, is_public: true } },
        { id: 'i2', item_type: 'PAGE', page: { id: 'p2', is_draft: false, is_public: false } },
        { id: 'i3', item_type: 'PAGE', page: { id: 'p3', is_draft: true, is_public: true } },
        { id: 'i4', item_type: 'SLIDE', slide: { id: 's1', is_draft: false, is_public: true } },
        { id: 'i5', item_type: 'SLIDE', slide: { id: 's2', is_draft: false, is_public: false } },
        { id: 'i6', item_type: 'REPOSITORY', repository: { id: 'r1', is_published: true } },
        { id: 'i7', item_type: 'QUIZ', quiz: { id: 'q1', status: 'PUBLISHED' } },
      ],
    },
    {
      id: 'mod-2',
      title: 'Week 2',
      items: [{ id: 'i8', item_type: 'REPOSITORY', repository: { id: 'r2', is_published: true } }],
    },
  ];

  it('queries only modules that are BOTH published and public, in app order', async () => {
    moduleFindMany.mockResolvedValue([]);
    await listPublicModulesForViewer('class-1', null);
    expect(moduleFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { classroom_id: 'class-1', is_published: true, is_public: true },
        orderBy: [{ position: 'asc' }, { created_at: 'asc' }],
      })
    );
  });

  it('shows an anonymous visitor only public, published pages and slides', async () => {
    moduleFindMany.mockResolvedValue(modules);
    const result = await listPublicModulesForViewer('class-1', null);

    // No repository or quiz survives — dropped entirely, so not even the title
    // leaks, and mod-2 disappears with its only item.
    expect(result).toHaveLength(1);
    expect(result[0].items.map(i => i.id)).toEqual(['i1', 'i4']);
  });

  it('shows a member every published item, including repos and quizzes', async () => {
    moduleFindMany.mockResolvedValue(modules);
    const result = await listPublicModulesForViewer('class-1', 'STUDENT');

    // Members get the app's ordinary publish rules: is_public stops mattering,
    // but the draft page (i3) is still hidden.
    expect(result.map(m => m.id)).toEqual(['mod-1', 'mod-2']);
    expect(result[0].items.map(i => i.id)).toEqual(['i1', 'i2', 'i4', 'i5', 'i6', 'i7']);
  });

  it('hides an unpublished repo from a member even inside a public module', async () => {
    moduleFindMany.mockResolvedValue([
      {
        id: 'mod-3',
        items: [
          { id: 'i9', item_type: 'REPOSITORY', repository: { id: 'r3', is_published: false } },
          { id: 'i10', item_type: 'QUIZ', quiz: { id: 'q2', status: 'DRAFT' } },
        ],
      },
    ]);
    await expect(listPublicModulesForViewer('class-1', 'STUDENT')).resolves.toEqual([]);
  });

  it('drops modules left with no visible items rather than rendering empty shells', async () => {
    moduleFindMany.mockResolvedValue([{ id: 'mod-4', title: 'Secret Week', items: [] }]);
    await expect(listPublicModulesForViewer('class-1', null)).resolves.toEqual([]);
  });
});
