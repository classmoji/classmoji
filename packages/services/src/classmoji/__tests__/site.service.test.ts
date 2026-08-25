import { describe, it, expect, vi, beforeEach } from 'vitest';

// site.service holds every visibility decision the anonymous web makes, so the
// tests below are mostly about what a viewer must NOT see. Prisma is mocked;
// @classmoji/utils is deliberately NOT — the subdomain regex and the reserved
// registries are the things under test, and a stub would test the stub.

const classroomSiteFindUnique = vi.fn();
const classroomSiteFindMany = vi.fn();
const classroomSiteUpsert = vi.fn();
const classroomSiteUpdate = vi.fn();
const classroomSiteUpdateMany = vi.fn();
const classroomSiteDelete = vi.fn();
const classroomFindUnique = vi.fn();
const pageFindFirst = vi.fn();
const moduleFindMany = vi.fn();

vi.mock('@classmoji/database', () => ({
  default: () => ({
    classroomSite: {
      findUnique: classroomSiteFindUnique,
      findMany: classroomSiteFindMany,
      upsert: classroomSiteUpsert,
      update: classroomSiteUpdate,
      updateMany: classroomSiteUpdateMany,
      delete: classroomSiteDelete,
    },
    classroom: { findUnique: classroomFindUnique },
    page: { findFirst: pageFindFirst },
    module: { findMany: moduleFindMany },
  }),
}));

// How a classroom's tier is resolved is its own unit
// (subscription.service.test.ts). Stubbed here so the custom-domain tests
// exercise the GATE rather than re-testing the tier rule behind it.
const getProStateForClassroomId = vi.fn();
vi.mock('../subscription.service.ts', () => ({
  getProStateForClassroomId: (...a: unknown[]) => getProStateForClassroomId(...a),
}));

// Certificate teardown is best-effort by design; these tests pin WHEN it is
// asked for, not what Fly does with it.
const removeCert = vi.fn();
const isFlyCertsConfigured = vi.fn();
vi.mock('../../fly/index.ts', () => ({
  removeCert: (...a: unknown[]) => removeCert(...a),
  isFlyCertsConfigured: () => isFlyCertsConfigured(),
}));

const {
  SITE_ERROR,
  checkSubdomainAvailability,
  clearCustomDomain,
  deleteSiteForClassroom,
  getHomePageForViewer,
  getPageBySlugForSite,
  getSiteByCustomDomain,
  getSiteBySubdomain,
  isPageVisibleOnSite,
  listCustomDomainRoutes,
  listPublicModulesForViewer,
  markCustomDomainVerified,
  setCustomDomain,
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
  // Default posture for the custom-domain block: PRO classroom, Fly configured.
  // Every test that cares about the other side says so explicitly.
  getProStateForClassroomId.mockResolvedValue({
    tier: 'PRO',
    isActive: true,
    isPro: true,
    subscription: { id: 'sub-1' },
  });
  isFlyCertsConfigured.mockReturnValue(true);
  removeCert.mockResolvedValue(true);
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

  // ── The public schedule's time zone ───────────────────────────────────────
  //
  // The column exists because /schedule formats deadlines on the SERVER and
  // ships no JavaScript, so a wrong zone is a wrong calendar day on a public
  // page. Validated against the runtime's own tz data rather than a list: Intl
  // is what `dayjs.tz` uses downstream, so this checks the thing that actually
  // has to work rather than a copy of it.
  describe('timezone', () => {
    // A settled, DISABLED site with a stored home page, so these exercise the
    // zone rule alone instead of tripping the home-page invariants.
    const settled = () => {
      classroomSiteFindUnique.mockResolvedValue({
        classroom_id: 'class-1',
        is_enabled: false,
        home_page_id: 'page-1',
      });
      classroomSiteUpdate.mockResolvedValue({});
    };

    const written = () => (classroomSiteUpdate.mock.calls[0][0] as { data: unknown }).data;

    it('stores a valid IANA zone', async () => {
      settled();
      await upsertSiteSettings('class-1', { timezone: 'America/New_York' });
      expect(written()).toEqual({ timezone: 'America/New_York' });
    });

    it("stores the canonical spelling, not the caller's", async () => {
      // Intl matches zone names case-insensitively and resolves aliases. One
      // spelling per zone in the column is what keeps the settings <select>
      // able to render the stored value as a selected option.
      settled();
      await upsertSiteSettings('class-1', { timezone: 'america/new_york' });
      expect(written()).toEqual({ timezone: 'America/New_York' });
    });

    it('accepts zones Intl.supportedValuesOf omits', async () => {
      // Why this validates by BUILDING a formatter rather than by list
      // membership: `UTC` is not in supportedValuesOf on this runtime, and
      // refusing it would be absurd — it is the schedule's own fallback.
      settled();
      await upsertSiteSettings('class-1', { timezone: 'UTC' });
      expect(written()).toEqual({ timezone: 'UTC' });
    });

    it.each([
      ['a zone that does not exist', 'Not/AZone'],
      ['a display name rather than a zone', 'Eastern Time'],
      ['a bare offset', 'GMT+5'],
      ['a near-miss the DB CHECK would also refuse', 'America/New York'],
    ])('refuses %s', async (_case, zone) => {
      settled();
      await expect(upsertSiteSettings('class-1', { timezone: zone })).rejects.toMatchObject({
        code: SITE_ERROR.TIMEZONE_INVALID,
      });
      // Refused BEFORE the write. A zone that reaches the column renders a
      // public page in a zone nobody chose.
      expect(classroomSiteUpdate).not.toHaveBeenCalled();
    });

    it('clears the zone on null, back to the UTC fallback', async () => {
      settled();
      await upsertSiteSettings('class-1', { timezone: null });
      expect(written()).toEqual({ timezone: null });
    });

    it('treats a blank string as a clear, not as an invalid zone', async () => {
      // What an emptied form control submits. Rejecting it would put an error
      // on a row the admin had just reset.
      settled();
      await upsertSiteSettings('class-1', { timezone: '   ' });
      expect(written()).toEqual({ timezone: null });
    });

    it('leaves the stored zone alone when the patch omits it', async () => {
      // The three-state convention every key here follows: absent ≠ null.
      settled();
      await upsertSiteSettings('class-1', { show_schedule: true });
      expect(written()).toEqual({ show_schedule: true });
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
        {
          id: 'i6',
          item_type: 'REPOSITORY',
          repository: { id: 'r1', is_published: true, assignments: [] },
        },
        { id: 'i7', item_type: 'QUIZ', quiz: { id: 'q1', status: 'PUBLISHED', due_date: null } },
      ],
    },
    {
      id: 'mod-2',
      title: 'Week 2',
      items: [
        {
          id: 'i8',
          item_type: 'REPOSITORY',
          repository: { id: 'r2', is_published: true, assignments: [] },
        },
      ],
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

  it('loads a repository assignment DEADLINE and nothing else it could print', async () => {
    // The narrow select is the no-leak guarantee at its source: an assignment
    // title never enters the process on an anonymous request, so no renderer
    // downstream can print one by accident.
    moduleFindMany.mockResolvedValue([]);
    await listPublicModulesForViewer('class-1', null);

    const include = moduleFindMany.mock.calls[0][0].include.items.include;
    expect(include.repository.select.assignments).toEqual({
      where: { is_published: true },
      select: { student_deadline: true },
    });
  });

  it('gives an anonymous visitor public pages and slides as real items', async () => {
    moduleFindMany.mockResolvedValue(modules);
    const result = await listPublicModulesForViewer('class-1', null);

    const visible = result[0].items.filter(item => item.kind === 'visible');
    expect(visible.map(item => item.id)).toEqual(['i1', 'i4']);
  });

  it('replaces every members-only item with a typed placeholder, in item order', async () => {
    moduleFindMany.mockResolvedValue(modules);
    const result = await listPublicModulesForViewer('class-1', null);

    // i3 is a DRAFT page: invisible to enrolled students too, so it gets no
    // placeholder either — a public site must not advertise unreleased work.
    expect(result[0].items.map(item => [item.id, item.kind])).toEqual([
      ['i1', 'visible'],
      ['i2', 'placeholder'],
      ['i4', 'visible'],
      ['i5', 'placeholder'],
      ['i6', 'placeholder'],
      ['i7', 'placeholder'],
    ]);
    expect(result[0].items.map(item => item.kind === 'placeholder' && item.item_type)).toEqual([
      false,
      'PAGE',
      false,
      'SLIDE',
      'REPOSITORY',
      'QUIZ',
    ]);
  });

  it('never lets a placeholder carry anything but its type and its date', async () => {
    // The assertion that has to survive every future change to the include:
    // a placeholder is BUILT from these four keys, not derived by omission, so
    // a title/name/slug/template can only appear here if someone adds it.
    moduleFindMany.mockResolvedValue(modules);
    const result = await listPublicModulesForViewer('class-1', null);

    const placeholders = result.flatMap(module =>
      module.items.filter(item => item.kind === 'placeholder')
    );
    expect(placeholders.length).toBeGreaterThan(0);
    for (const placeholder of placeholders) {
      expect(Object.keys(placeholder).sort()).toEqual(['due_at', 'id', 'item_type', 'kind']);
    }
  });

  it('keeps a module whose every item is redacted, title and all', async () => {
    moduleFindMany.mockResolvedValue(modules);
    const result = await listPublicModulesForViewer('class-1', null);

    // mod-2 holds one members-only repo. It used to vanish, taking the shape of
    // the course with it; now it is a titled section with one locked row.
    expect(result.map(module => module.id)).toEqual(['mod-1', 'mod-2']);
    expect(result[1].items).toEqual([
      { kind: 'placeholder', id: 'i8', item_type: 'REPOSITORY', due_at: null },
    ]);
  });

  it("renders Tim's Welcome module: a dated repo placeholder beside an undated page one", async () => {
    // The case this behaviour was built for. One public+published module whose
    // only contents are a repository with a deadline and a members-only page:
    // the schedule used to say "nothing has been published yet".
    const due = new Date('2026-09-12T23:59:00Z');
    moduleFindMany.mockResolvedValue([
      {
        id: 'mod-welcome',
        title: 'Welcome',
        items: [
          {
            id: 'item-repo',
            item_type: 'REPOSITORY',
            repository: {
              id: 'repo-hello-world',
              is_published: true,
              assignments: [
                { student_deadline: new Date('2026-09-26T23:59:00Z') },
                { student_deadline: due },
                { student_deadline: null },
              ],
            },
          },
          {
            id: 'item-page',
            item_type: 'PAGE',
            page: { id: 'page-1', is_draft: false, is_public: false },
          },
        ],
      },
    ]);

    const result = await listPublicModulesForViewer('class-1', null);

    expect(result).toHaveLength(1);
    expect(result[0].title).toBe('Welcome');
    expect(result[0].items).toEqual([
      // Earliest published deadline wins — the repository's "due date", the
      // same reduction the admin repo summary makes.
      { kind: 'placeholder', id: 'item-repo', item_type: 'REPOSITORY', due_at: due },
      { kind: 'placeholder', id: 'item-page', item_type: 'PAGE', due_at: null },
    ]);
  });

  it("carries a quiz's own due date onto its placeholder", async () => {
    const due = new Date('2026-10-01T16:00:00Z');
    moduleFindMany.mockResolvedValue([
      {
        id: 'mod-quiz',
        title: 'Quizzes',
        items: [
          { id: 'i-q', item_type: 'QUIZ', quiz: { id: 'q9', status: 'PUBLISHED', due_date: due } },
        ],
      },
    ]);

    const result = await listPublicModulesForViewer('class-1', null);
    expect(result[0].items[0]).toEqual({
      kind: 'placeholder',
      id: 'i-q',
      item_type: 'QUIZ',
      due_at: due,
    });
  });

  it('gives an anonymous visitor NO row at all for an unpublished item', async () => {
    // Unpublished is not "members-only": an enrolled student cannot see these
    // either, so a placeholder would announce coursework nobody has been given.
    moduleFindMany.mockResolvedValue([
      {
        id: 'mod-3',
        title: 'Later',
        items: [
          {
            id: 'i9',
            item_type: 'REPOSITORY',
            repository: { id: 'r3', is_published: false, assignments: [] },
          },
          { id: 'i10', item_type: 'QUIZ', quiz: { id: 'q2', status: 'DRAFT', due_date: null } },
        ],
      },
    ]);

    const result = await listPublicModulesForViewer('class-1', null);
    // The module still exists — it is published and public — but it is bare.
    expect(result).toEqual([expect.objectContaining({ id: 'mod-3', title: 'Later', items: [] })]);
  });

  it('shows a member every published item, including repos and quizzes', async () => {
    moduleFindMany.mockResolvedValue(modules);
    const result = await listPublicModulesForViewer('class-1', 'STUDENT');

    // Members get the app's ordinary publish rules: is_public stops mattering,
    // but the draft page (i3) is still hidden. No placeholder ever reaches a
    // member — everything they may see, they see in full.
    expect(result.map(m => m.id)).toEqual(['mod-1', 'mod-2']);
    expect(result[0].items.map(i => i.id)).toEqual(['i1', 'i2', 'i4', 'i5', 'i6', 'i7']);
    expect(result.every(m => m.items.every(i => i.kind === 'visible'))).toBe(true);
  });

  it('hides an unpublished repo from a member even inside a public module', async () => {
    moduleFindMany.mockResolvedValue([
      {
        id: 'mod-3',
        items: [
          {
            id: 'i9',
            item_type: 'REPOSITORY',
            repository: { id: 'r3', is_published: false, assignments: [] },
          },
          { id: 'i10', item_type: 'QUIZ', quiz: { id: 'q2', status: 'DRAFT', due_date: null } },
        ],
      },
    ]);
    // Members keep the old rule: a module left with nothing is dropped, so a
    // signed-in student never sees an empty shell where staff see drafts.
    await expect(listPublicModulesForViewer('class-1', 'STUDENT')).resolves.toEqual([]);
  });

  it('keeps an empty public module as a bare title for an anonymous visitor', async () => {
    moduleFindMany.mockResolvedValue([{ id: 'mod-4', title: 'Week 3', items: [] }]);
    await expect(listPublicModulesForViewer('class-1', null)).resolves.toEqual([
      { id: 'mod-4', title: 'Week 3', items: [] },
    ]);
  });
});

describe('site.deleteSiteForClassroom', () => {
  it('deletes the row and reports the subdomain it freed', async () => {
    classroomSiteFindUnique.mockResolvedValue({ id: 'site-1', subdomain: 'cs52' });
    classroomSiteDelete.mockResolvedValue({ id: 'site-1' });

    await expect(deleteSiteForClassroom('class-1')).resolves.toEqual({
      id: 'site-1',
      subdomain: 'cs52',
    });
    expect(classroomSiteDelete).toHaveBeenCalledWith({ where: { classroom_id: 'class-1' } });
  });

  it('refuses a classroom with no site instead of letting prisma throw P2025', async () => {
    classroomSiteFindUnique.mockResolvedValue(null);

    await expect(deleteSiteForClassroom('class-1')).rejects.toMatchObject({
      code: SITE_ERROR.SITE_NOT_FOUND,
    });
    // The whole reason for the pre-check: a double-submit must not reach the DB.
    expect(classroomSiteDelete).not.toHaveBeenCalled();
  });
});

// ─── custom domains (PRO) ────────────────────────────────────────────────────

describe('site.setCustomDomain', () => {
  it('refuses a classroom with no site row instead of letting prisma throw P2025', async () => {
    // A classroom with no site has no subdomain to fall back to, and
    // `prisma.update` on a missing row throws an error no caller can render.
    classroomSiteFindUnique.mockResolvedValue(null);

    await expect(setCustomDomain('class-1', 'cs52.me')).rejects.toMatchObject({
      code: SITE_ERROR.SITE_NOT_FOUND,
    });
    expect(classroomSiteUpdate).not.toHaveBeenCalled();
  });

  it('enforces PRO at the SERVICE layer, before any validation or write', async () => {
    // The route checks too, but this is the gate that holds: MCP tools, a
    // future API and any script reach this function without passing a loader.
    classroomSiteFindUnique.mockResolvedValue({ id: 'site-1', custom_domain: null });
    getProStateForClassroomId.mockResolvedValue({
      tier: 'FREE',
      isActive: false,
      isPro: false,
      subscription: null,
    });

    await expect(setCustomDomain('class-1', 'cs52.me')).rejects.toMatchObject({
      code: SITE_ERROR.PRO_REQUIRED,
    });
    expect(classroomSiteUpdate).not.toHaveBeenCalled();
  });

  it('refuses a LAPSED pro subscription exactly as it refuses FREE', async () => {
    classroomSiteFindUnique.mockResolvedValue({ id: 'site-1', custom_domain: null });
    getProStateForClassroomId.mockResolvedValue({
      tier: 'PRO',
      isActive: false,
      isPro: false,
      subscription: { id: 'sub-lapsed' },
    });

    await expect(setCustomDomain('class-1', 'cs52.me')).rejects.toMatchObject({
      code: SITE_ERROR.PRO_REQUIRED,
    });
  });

  it('normalizes case, whitespace and a trailing dot before storing', async () => {
    // The stored value is compared against a normalized Host header on every
    // request, so anything else here is a row that can never match.
    classroomSiteFindUnique.mockResolvedValue({ id: 'site-1', custom_domain: null });
    classroomSiteUpdate.mockResolvedValue({ id: 'site-1' });

    await setCustomDomain('class-1', '  CS52.ME.  ');

    expect(classroomSiteUpdate).toHaveBeenCalledWith({
      where: { classroom_id: 'class-1' },
      data: { custom_domain: 'cs52.me', custom_domain_verified_at: null },
    });
  });

  it.each([
    ['cs52', 'a single label is not a domain'],
    ['https://cs52.me', 'a scheme is not part of a hostname'],
    ['cs52.me/path', 'nor is a path'],
    ['cs52.me:443', 'nor a port'],
    ['-bad.me', 'a leading hyphen is not a legal DNS label'],
    ['bad-.me', 'nor a trailing one'],
    ['under_score.me', 'underscores are not legal in a hostname'],
    ['has space.me', 'spaces are not legal'],
    ['café.fr', 'unicode must be punycoded by the caller'],
    ['', 'empty is not a domain'],
  ])('rejects %j — %s', async domain => {
    classroomSiteFindUnique.mockResolvedValue({ id: 'site-1', custom_domain: null });

    await expect(setCustomDomain('class-1', domain)).rejects.toMatchObject({
      code: SITE_ERROR.DOMAIN_INVALID,
    });
    expect(classroomSiteUpdate).not.toHaveBeenCalled();
  });

  it.each([
    ['classmoji.io'],
    ['cs52.classmoji.io'],
    ['pages.classmoji.io'],
    ['staging.classmoji.io'],
    ['lvh.me'],
    ['cs52.lvh.me'],
    ['fly.dev'],
    ['classmoji-pages.fly.dev'],
  ])('refuses the platform hostname %j', async domain => {
    // Not a validation slip — claiming one of these is a hijack of a hostname
    // our own wildcard certificate already answers for.
    classroomSiteFindUnique.mockResolvedValue({ id: 'site-1', custom_domain: null });

    await expect(setCustomDomain('class-1', domain)).rejects.toMatchObject({
      code: SITE_ERROR.DOMAIN_RESERVED,
    });
    expect(classroomSiteUpdate).not.toHaveBeenCalled();
  });

  it('accepts an apex domain and a deep subdomain of one', async () => {
    classroomSiteFindUnique.mockResolvedValue({ id: 'site-1', custom_domain: null });
    classroomSiteUpdate.mockResolvedValue({ id: 'site-1' });

    await expect(setCustomDomain('class-1', 'cs52.me')).resolves.toBeTruthy();
    await expect(setCustomDomain('class-1', 'www.cs.dartmouth.edu')).resolves.toBeTruthy();
  });

  it('turns the unique violation into DOMAIN_TAKEN', async () => {
    classroomSiteFindUnique.mockResolvedValue({ id: 'site-1', custom_domain: null });
    classroomSiteUpdate.mockRejectedValue({
      code: 'P2002',
      meta: { target: ['custom_domain'] },
    });

    await expect(setCustomDomain('class-1', 'cs52.me')).rejects.toMatchObject({
      code: SITE_ERROR.DOMAIN_TAKEN,
    });
  });

  it('re-throws a P2002 on some OTHER constraint as itself', async () => {
    // Matched by target so a constraint added later surfaces as what it is,
    // rather than as a misleading "that domain is taken".
    classroomSiteFindUnique.mockResolvedValue({ id: 'site-1', custom_domain: null });
    classroomSiteUpdate.mockRejectedValue({ code: 'P2002', meta: { target: ['subdomain'] } });

    await expect(setCustomDomain('class-1', 'cs52.me')).rejects.toMatchObject({ code: 'P2002' });
  });

  it('clears the verification stamp on a RE-CLAIM of the same hostname', async () => {
    // Re-claiming is the one moment we can honestly say "prove it again".
    classroomSiteFindUnique.mockResolvedValue({ id: 'site-1', custom_domain: 'cs52.me' });
    classroomSiteUpdate.mockResolvedValue({ id: 'site-1' });

    await setCustomDomain('class-1', 'cs52.me');

    expect(classroomSiteUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { custom_domain: 'cs52.me', custom_domain_verified_at: null },
      })
    );
    // Same hostname: nothing to release.
    expect(removeCert).not.toHaveBeenCalled();
  });

  it('releases the OLD certificate when the domain is re-pointed', async () => {
    // An inherited certificate is a live TLS endpoint for a hostname this
    // classroom no longer claims.
    classroomSiteFindUnique.mockResolvedValue({ id: 'site-1', custom_domain: 'old.example' });
    classroomSiteUpdate.mockResolvedValue({ id: 'site-1' });

    await setCustomDomain('class-1', 'cs52.me');

    expect(removeCert).toHaveBeenCalledWith('old.example');
  });

  it('survives a Fly failure while releasing the old certificate', async () => {
    // The claim already succeeded; a leaked certificate is the reconcile task's
    // problem, not a user-visible failure of an operation that worked.
    classroomSiteFindUnique.mockResolvedValue({ id: 'site-1', custom_domain: 'old.example' });
    classroomSiteUpdate.mockResolvedValue({ id: 'site-1' });
    removeCert.mockRejectedValue(new Error('fly down'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(setCustomDomain('class-1', 'cs52.me')).resolves.toBeTruthy();
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});

describe('site.clearCustomDomain', () => {
  it('clears both columns and releases the certificate', async () => {
    classroomSiteFindUnique.mockResolvedValue({ id: 'site-1', custom_domain: 'cs52.me' });
    classroomSiteUpdate.mockResolvedValue({ id: 'site-1' });

    await expect(clearCustomDomain('class-1')).resolves.toEqual({ released: 'cs52.me' });
    expect(classroomSiteUpdate).toHaveBeenCalledWith({
      where: { classroom_id: 'class-1' },
      data: { custom_domain: null, custom_domain_verified_at: null },
    });
    expect(removeCert).toHaveBeenCalledWith('cs52.me');
  });

  it('is a no-op when there is no domain to clear', async () => {
    // A double-submitted Remove button is not an error state.
    classroomSiteFindUnique.mockResolvedValue({ id: 'site-1', custom_domain: null });

    await expect(clearCustomDomain('class-1')).resolves.toEqual({ released: null });
    expect(classroomSiteUpdate).not.toHaveBeenCalled();
    expect(removeCert).not.toHaveBeenCalled();
  });

  it('refuses a classroom with no site row', async () => {
    classroomSiteFindUnique.mockResolvedValue(null);
    await expect(clearCustomDomain('class-1')).rejects.toMatchObject({
      code: SITE_ERROR.SITE_NOT_FOUND,
    });
  });

  it('skips the Fly call entirely when certificate automation is off', async () => {
    classroomSiteFindUnique.mockResolvedValue({ id: 'site-1', custom_domain: 'cs52.me' });
    classroomSiteUpdate.mockResolvedValue({ id: 'site-1' });
    isFlyCertsConfigured.mockReturnValue(false);

    await expect(clearCustomDomain('class-1')).resolves.toEqual({ released: 'cs52.me' });
    expect(removeCert).not.toHaveBeenCalled();
  });
});

describe('site.getSiteByCustomDomain', () => {
  const customSiteRow = (overrides: Record<string, unknown> = {}) => ({
    id: 'site-1',
    classroom_id: 'class-1',
    subdomain: 'cs52',
    custom_domain: 'cs52.me',
    custom_domain_verified_at: null,
    is_enabled: true,
    classroom: { id: 'class-1', is_archived: false, status: 'ACTIVE' },
    ...overrides,
  });

  it('refuses a malformed host WITHOUT touching the database', async () => {
    // The Host header is unauthenticated and attacker-controlled; an indexed
    // lookup per garbage value is a free amplification primitive.
    for (const host of ['', 'localhost', 'not a host', '..', 'a', '-x.me']) {
      await expect(getSiteByCustomDomain(host)).resolves.toEqual({ state: 'not_found' });
    }
    expect(classroomSiteFindUnique).not.toHaveBeenCalled();
  });

  it('refuses a platform hostname without touching the database', async () => {
    await expect(getSiteByCustomDomain('cs52.classmoji.io')).resolves.toEqual({
      state: 'not_found',
    });
    expect(classroomSiteFindUnique).not.toHaveBeenCalled();
  });

  it('normalizes the host before the lookup', async () => {
    classroomSiteFindUnique.mockResolvedValue(null);
    await getSiteByCustomDomain('CS52.ME.');
    expect(classroomSiteFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { custom_domain: 'cs52.me' } })
    );
  });

  it('reports not_found for a hostname nobody claims', async () => {
    classroomSiteFindUnique.mockResolvedValue(null);
    await expect(getSiteByCustomDomain('cs52.me')).resolves.toEqual({ state: 'not_found' });
  });

  it('reports LAPSED before any site-state check', async () => {
    // Billing first, deliberately: a lapsed classroom gets ONE consistent
    // answer on its custom domain whatever else is true of the site, and the
    // subdomain stays the single place a visitor learns the rest.
    classroomSiteFindUnique.mockResolvedValue(customSiteRow({ is_enabled: false }));
    getProStateForClassroomId.mockResolvedValue({
      tier: 'PRO',
      isActive: false,
      isPro: false,
      subscription: { id: 'sub-lapsed' },
    });

    const lookup = await getSiteByCustomDomain('cs52.me');
    expect(lookup.state).toBe('lapsed');
  });

  it('reports disabled for a switched-off site', async () => {
    classroomSiteFindUnique.mockResolvedValue(customSiteRow({ is_enabled: false }));
    const lookup = await getSiteByCustomDomain('cs52.me');
    expect(lookup.state).toBe('disabled');
  });

  it('reports unavailable for an archived or unpublished classroom', async () => {
    classroomSiteFindUnique.mockResolvedValue(
      customSiteRow({ classroom: { id: 'class-1', is_archived: true, status: 'ACTIVE' } })
    );
    expect((await getSiteByCustomDomain('cs52.me')).state).toBe('unavailable');

    classroomSiteFindUnique.mockResolvedValue(
      customSiteRow({ classroom: { id: 'class-1', is_archived: false, status: 'UNPUBLISHED' } })
    );
    expect((await getSiteByCustomDomain('cs52.me')).state).toBe('unavailable');
  });

  it('serves an active PRO site and reports its verification stamp', async () => {
    const verifiedAt = new Date('2026-08-01T00:00:00Z');
    classroomSiteFindUnique.mockResolvedValue(
      customSiteRow({ custom_domain_verified_at: verifiedAt })
    );

    const lookup = await getSiteByCustomDomain('cs52.me');
    expect(lookup).toMatchObject({ state: 'active', verifiedAt });
  });
});

describe('site.markCustomDomainVerified', () => {
  it('writes only when the stamp is still null AND the domain still matches', async () => {
    // Runs on a hot path, so it must be one write per CLAIM, not per request —
    // and if the domain changed between the read and this write, zero rows
    // match and the new claim keeps its unproven status.
    classroomSiteUpdateMany.mockResolvedValue({ count: 1 });

    await markCustomDomainVerified('site-1', 'cs52.me');

    expect(classroomSiteUpdateMany).toHaveBeenCalledWith({
      where: { id: 'site-1', custom_domain: 'cs52.me', custom_domain_verified_at: null },
      data: { custom_domain_verified_at: expect.any(Date) },
    });
  });
});

describe('site.listCustomDomainRoutes', () => {
  const routeRow = (overrides: Record<string, unknown> = {}) => ({
    subdomain: 'cs52',
    custom_domain: 'cs52.me',
    is_enabled: true,
    classroom: {
      is_archived: false,
      status: 'ACTIVE',
      memberships: [{ user: { subscriptions: [{ tier: 'PRO', ends_at: null }] } }],
    },
    ...overrides,
  });

  it('maps a live claim to an active route', async () => {
    classroomSiteFindMany.mockResolvedValue([routeRow()]);
    await expect(listCustomDomainRoutes()).resolves.toEqual([
      { domain: 'cs52.me', subdomain: 'cs52', active: true },
    ]);
  });

  it('still LISTS a lapsed or disabled claim, marked inactive', async () => {
    // Routing has to reach the loader for these — a lapsed domain needs a 302
    // and a disabled one a branded 404. Dropping them here would flatten both
    // into an edge 404. The reconcile task needs them listed too, or it would
    // delete their certificates the moment a subscription lapsed.
    classroomSiteFindMany.mockResolvedValue([
      routeRow({
        classroom: {
          is_archived: false,
          status: 'ACTIVE',
          memberships: [
            { user: { subscriptions: [{ tier: 'PRO', ends_at: new Date(Date.now() - 1000) }] } },
          ],
        },
      }),
    ]);
    await expect(listCustomDomainRoutes()).resolves.toEqual([
      { domain: 'cs52.me', subdomain: 'cs52', active: false },
    ]);

    classroomSiteFindMany.mockResolvedValue([routeRow({ is_enabled: false })]);
    await expect(listCustomDomainRoutes()).resolves.toEqual([
      { domain: 'cs52.me', subdomain: 'cs52', active: false },
    ]);
  });

  it('counts ANY accepted owner with an active PRO, matching the tier rule', async () => {
    classroomSiteFindMany.mockResolvedValue([
      routeRow({
        classroom: {
          is_archived: false,
          status: 'ACTIVE',
          memberships: [
            { user: { subscriptions: [{ tier: 'FREE', ends_at: null }] } },
            { user: { subscriptions: [{ tier: 'PRO', ends_at: null }] } },
          ],
        },
      }),
    ]);
    await expect(listCustomDomainRoutes()).resolves.toEqual([
      { domain: 'cs52.me', subdomain: 'cs52', active: true },
    ]);
  });
});
