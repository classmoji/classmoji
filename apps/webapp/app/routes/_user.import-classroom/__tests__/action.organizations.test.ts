/**
 * The import asks Github, with the importer's own token, whether they own each
 * organization of the export, and hands the service only what Github said:
 * once per organization id, the organization Github has under the export's
 * login counting only when it carries the export's id. When that login gives
 * no organization with the id (renamed since the export, or the name now
 * another organization's), the organization with the export's id is looked
 * for among the importer's own organizations, read once per request. A
 * missing token or a Github failure is an organization that is not verified,
 * never an error.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  importGithubClassrooms: vi.fn(),
  getImmediateUserOctokit: vi.fn(),
  graphql: vi.fn(),
  // Github's answers to the two queries: one organization by login, and a
  // page of the importer's own organizations.
  byLogin: vi.fn(),
  viewer: vi.fn(),
  session: { id: 'owner-1', token: 'gh-token' as string | null },
}));

vi.mock('~/utils/helpers', () => ({
  checkAuth:
    (fn: (args: unknown) => unknown) =>
    ({ request }: { request: Request }) =>
      fn({ request, user: { ...mocks.session, userId: mocks.session.id } }),
  addClassroomAuditLog: async () => {},
}));

vi.mock('~/constants', () => ({ ActionTypes: { IMPORT_CLASSROOM: 'import' } }));

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    githubClassroomImport: {
      importGithubClassrooms: (...a: unknown[]) => mocks.importGithubClassrooms(...a),
      // The service's rules for an organization id and a login, as it states them.
      organizationProviderId: (id: unknown) =>
        typeof id === 'number' && Number.isSafeInteger(id) && id > 0 ? String(id) : null,
      isGithubLogin: (login: unknown) =>
        typeof login === 'string' &&
        /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/.test(login),
    },
    classroom: { getTimeZone: vi.fn(), updateSettings: vi.fn() },
    emojiMapping: { ensureDefaultScale: vi.fn() },
  },
  GitHubProvider: {
    getImmediateUserOctokit: (...a: unknown[]) => mocks.getImmediateUserOctokit(...a),
  },
}));

const { action } = await import('../action.ts');
const { verifyImportOrganizations } = await import('../organizations.server.ts');

const classroom = (name: string, orgId: number, login: string) => ({
  slug: name,
  classroom: { githubId: 1, name, organization: { id: orgId, login }, assignments: [], grades: [] },
});

const post = (body: unknown) =>
  (action as unknown as (args: { request: Request }) => Promise<unknown>)({
    request: new Request('http://localhost/import-classroom', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  });

/** The organizations the action handed the service. */
const handed = () => {
  const options = mocks.importGithubClassrooms.mock.calls.at(-1)?.[2] as {
    organizations: Map<string, unknown>;
  };
  expect(options.organizations).toBeInstanceOf(Map);
  return Object.fromEntries(options.organizations);
};

const githubSays = (organization: unknown) => mocks.byLogin.mockResolvedValue({ organization });

const isViewerQuery = (query: string) => /\bviewer\s*\{/.test(query);

/** One page of the importer's organizations. */
const viewerPage = (nodes: unknown[], endCursor: string | null = null) => ({
  viewer: {
    organizations: { pageInfo: { hasNextPage: endCursor !== null, endCursor }, nodes },
  },
});

const theirOrganizations = (...nodes: unknown[]) =>
  mocks.viewer.mockResolvedValue(viewerPage(nodes));

const notFound = () =>
  Object.assign(new Error('Could not resolve'), {
    errors: [{ type: 'NOT_FOUND', message: 'Could not resolve to an Organization' }],
  });

const byLoginCalls = () =>
  mocks.graphql.mock.calls.filter(([q]) => !isViewerQuery(q as string)).map(([, v]) => v);
const viewerCalls = () =>
  mocks.graphql.mock.calls.filter(([q]) => isViewerQuery(q as string)).map(([, v]) => v);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.session = { id: 'owner-1', token: 'gh-token' };
  mocks.graphql.mockImplementation((query: string, variables: unknown) =>
    isViewerQuery(query) ? mocks.viewer(variables) : mocks.byLogin(variables)
  );
  mocks.viewer.mockResolvedValue(viewerPage([]));
  mocks.getImmediateUserOctokit.mockReturnValue({ graphql: mocks.graphql });
  mocks.importGithubClassrooms.mockResolvedValue({ results: [], errors: [] });
});

describe('import-classroom organization check', () => {
  it("asks Github with the session's token and hands over Github's login", async () => {
    githubSays({ login: 'Acme-Org', databaseId: 101, viewerCanAdminister: true });

    await post({ classrooms: [classroom('a', 101, 'acme-org')] });

    expect(mocks.getImmediateUserOctokit).toHaveBeenCalledExactlyOnceWith('gh-token');
    expect(mocks.graphql).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining('viewerCanAdminister'),
      expect.objectContaining({ login: 'acme-org', request: { signal: expect.any(AbortSignal) } })
    );
    expect(mocks.importGithubClassrooms.mock.calls[0][0]).toBe('owner-1');
    expect(handed()).toEqual({
      '101': { githubId: '101', verifiedAdmin: true, login: 'Acme-Org', reason: null },
    });
  });

  it('ignores a body field named like the verification', async () => {
    githubSays({ login: 'acme-org', databaseId: 101, viewerCanAdminister: false });

    await post({
      classrooms: [classroom('a', 101, 'acme-org')],
      organizations: { '101': { githubId: '101', verifiedAdmin: true, login: 'acme-org' } },
      options: { organizations: { '101': { verifiedAdmin: true } } },
    });

    expect(handed()).toEqual({
      '101': { githubId: '101', verifiedAdmin: false, login: null, reason: 'not_admin' },
    });
  });

  it("refuses an organization whose Github id is not the export's", async () => {
    githubSays({ login: 'acme-org', databaseId: 999, viewerCanAdminister: true });
    // The organization under that name is theirs too; it is still not the export's.
    theirOrganizations({ login: 'acme-org', databaseId: 999, viewerCanAdminister: true });

    await post({ classrooms: [classroom('a', 101, 'acme-org')] });

    expect(handed()).toEqual({
      '101': { githubId: '101', verifiedAdmin: false, login: null, reason: 'mismatch' },
    });
  });

  it.each<{ label: string; token: string | null }>([
    { label: 'no Github token (signed in another way)', token: null },
    { label: 'an empty token', token: '' },
  ])('with $label: not verified, Github not asked, no error', async ({ token }) => {
    mocks.session = { id: 'owner-1', token };

    await expect(post({ classrooms: [classroom('a', 101, 'acme-org')] })).resolves.toBeDefined();

    expect(mocks.graphql).not.toHaveBeenCalled();
    expect(handed()).toEqual({
      '101': { githubId: '101', verifiedAdmin: false, login: null, reason: 'no_github' },
    });
  });

  it.each<{ label: string; error: unknown; reason: string }>([
    {
      label: 'a refused token',
      error: Object.assign(new Error('Bad credentials'), { status: 401 }),
      reason: 'token_rejected',
    },
    {
      label: 'an organization Github does not show',
      error: Object.assign(new Error('Could not resolve'), {
        errors: [{ type: 'NOT_FOUND', message: 'Could not resolve to an Organization' }],
      }),
      reason: 'no_access',
    },
    {
      label: 'SSO not authorized for the token',
      error: Object.assign(new Error('forbidden'), {
        errors: [
          { type: 'FORBIDDEN', message: 'Resource protected by organization SAML enforcement.' },
        ],
      }),
      reason: 'no_access',
    },
    {
      label: "the organization's OAuth app restrictions",
      error: Object.assign(
        new Error('the organization has enabled OAuth App access restrictions'),
        { status: 403 }
      ),
      reason: 'no_access',
    },
    {
      label: 'a Github 502',
      error: Object.assign(new Error('Bad gateway'), { status: 502 }),
      reason: 'unreachable',
    },
    { label: 'a network failure', error: new TypeError('fetch failed'), reason: 'unreachable' },
  ])('$label: not verified, with the reason, no error', async ({ error, reason }) => {
    mocks.byLogin.mockRejectedValue(error);

    await expect(post({ classrooms: [classroom('a', 101, 'acme-org')] })).resolves.toBeDefined();

    expect(handed()).toEqual({
      '101': { githubId: '101', verifiedAdmin: false, login: null, reason },
    });
  });

  it('an organization Github answers null for is not verified', async () => {
    githubSays(null);

    await post({ classrooms: [classroom('a', 101, 'acme-org')] });

    expect(handed()['101']).toMatchObject({ verifiedAdmin: false, reason: 'no_access' });
  });

  it('asks once per distinct organization id', async () => {
    mocks.byLogin.mockImplementation(async ({ login }: { login: string }) => ({
      organization: {
        login,
        databaseId: login.startsWith('acme') ? 101 : 202,
        viewerCanAdminister: true,
      },
    }));

    await post({
      classrooms: [
        classroom('a', 101, 'acme-org'),
        classroom('b', 202, 'beta-org'),
        // The same organization under another export login: not asked again.
        classroom('c', 101, 'acme-old'),
      ],
    });

    expect(mocks.graphql).toHaveBeenCalledTimes(2);
    expect(byLoginCalls().map(v => (v as { login: string }).login)).toEqual([
      'acme-org',
      'beta-org',
    ]);
    expect(viewerCalls()).toEqual([]);
    expect(Object.keys(handed())).toEqual(['101', '202']);
  });

  it('does not ask Github about a login Github would not allow', async () => {
    await post({ classrooms: [classroom('a', 101, '<b>acme</b>')] });

    expect(byLoginCalls()).toEqual([]);
    expect(viewerCalls()).toHaveLength(1);
    expect(handed()['101']).toMatchObject({ verifiedAdmin: false, reason: 'no_access' });
  });

  it('gives up on Github after the timeout', async () => {
    mocks.graphql.mockReturnValue(new Promise(() => {}));

    const map = await verifyImportOrganizations('gh-token', [classroom('a', 101, 'acme-org')], {
      octokitFor: () => ({ graphql: mocks.graphql }),
      timeoutMs: 20,
    });

    expect(Object.fromEntries(map)).toEqual({
      '101': { githubId: '101', verifiedAdmin: false, login: null, reason: 'unreachable' },
    });
  });

  it('cancels the request to Github after the timeout', async () => {
    mocks.graphql.mockReturnValue(new Promise(() => {}));

    await verifyImportOrganizations('gh-token', [classroom('a', 101, 'acme-org')], {
      octokitFor: () => ({ graphql: mocks.graphql }),
      timeoutMs: 20,
    });

    const signals = mocks.graphql.mock.calls.map(
      ([, variables]) => (variables as { request: { signal: AbortSignal } }).request.signal
    );
    expect(signals).toHaveLength(1);
    expect(signals[0].aborted).toBe(true);
  });

  it('an organization Github reports without its login is not verified', async () => {
    githubSays({ databaseId: 101, viewerCanAdminister: true });

    await post({ classrooms: [classroom('a', 101, 'acme-org')] });

    expect(handed()).toEqual({
      '101': { githubId: '101', verifiedAdmin: false, login: null, reason: 'no_access' },
    });
  });

  it.each<{ label: string; value: unknown }>([
    { label: 'null', value: null },
    { label: 'missing', value: undefined },
    { label: 'the string "true"', value: 'true' },
    { label: '1', value: 1 },
  ])('viewerCanAdminister $label under the login: not an owner', async ({ value }) => {
    githubSays({ login: 'acme-org', databaseId: 101, viewerCanAdminister: value });

    await post({ classrooms: [classroom('a', 101, 'acme-org')] });

    expect(handed()).toEqual({
      '101': { githubId: '101', verifiedAdmin: false, login: null, reason: 'not_admin' },
    });
  });

  it('checks at most 20 organizations per request; the others are not verified', async () => {
    mocks.byLogin.mockImplementation(async ({ login }: { login: string }) => ({
      organization: { login, databaseId: Number(login.slice(4)), viewerCanAdminister: true },
    }));
    const classrooms = Array.from({ length: 21 }, (_, i) =>
      classroom(`c${i + 1}`, i + 1, `org-${i + 1}`)
    );

    await post({ classrooms });

    expect(byLoginCalls()).toHaveLength(20);
    const organizations = handed();
    expect(Object.keys(organizations)).toHaveLength(20);
    expect(organizations['21']).toBeUndefined();
    expect(organizations['20']).toMatchObject({ verifiedAdmin: true, login: 'org-20' });
  });
});

describe('import-classroom organization check: an organization renamed since the export', () => {
  it.each<{ label: string; answer: () => void }>([
    {
      label: 'Github resolves no organization',
      answer: () => mocks.byLogin.mockRejectedValue(notFound()),
    },
    { label: 'Github answers null', answer: () => githubSays(null) },
  ])('$label under the old login: verified by its id, with its login now', async ({ answer }) => {
    answer();
    theirOrganizations(
      { login: 'other-org', databaseId: 303, viewerCanAdminister: true },
      { login: 'Acme-Renamed', databaseId: 101, viewerCanAdminister: true }
    );

    await post({ classrooms: [classroom('a', 101, 'acme-org')] });

    expect(byLoginCalls()).toEqual([expect.objectContaining({ login: 'acme-org' })]);
    expect(viewerCalls()).toEqual([
      expect.objectContaining({ after: null, request: { signal: expect.any(AbortSignal) } }),
    ]);
    expect(handed()).toEqual({
      '101': { githubId: '101', verifiedAdmin: true, login: 'Acme-Renamed', reason: null },
    });
  });

  it('another organization now holding the old login: verified only through the id', async () => {
    githubSays({ login: 'acme-org', databaseId: 999, viewerCanAdminister: true });
    theirOrganizations(
      { login: 'acme-org', databaseId: 999, viewerCanAdminister: true },
      { login: 'acme-renamed', databaseId: 101, viewerCanAdminister: true }
    );

    await post({ classrooms: [classroom('a', 101, 'acme-org')] });

    expect(handed()).toEqual({
      '101': { githubId: '101', verifiedAdmin: true, login: 'acme-renamed', reason: null },
    });
  });

  it("another organization now holding the old login, the export's not theirs: not verified", async () => {
    githubSays({ login: 'acme-org', databaseId: 999, viewerCanAdminister: true });
    theirOrganizations({ login: 'acme-org', databaseId: 999, viewerCanAdminister: true });

    await post({ classrooms: [classroom('a', 101, 'acme-org')] });

    expect(handed()).toEqual({
      '101': { githubId: '101', verifiedAdmin: false, login: null, reason: 'mismatch' },
    });
  });

  it('a member, not an owner, of the organization with that id: not_admin', async () => {
    mocks.byLogin.mockRejectedValue(notFound());
    theirOrganizations({ login: 'acme-renamed', databaseId: 101, viewerCanAdminister: false });

    await post({ classrooms: [classroom('a', 101, 'acme-org')] });

    expect(handed()).toEqual({
      '101': { githubId: '101', verifiedAdmin: false, login: null, reason: 'not_admin' },
    });
  });

  it('not among their organizations either: the answer for the login stands', async () => {
    mocks.byLogin.mockRejectedValue(notFound());
    theirOrganizations({ login: 'other-org', databaseId: 303, viewerCanAdminister: true });

    await post({ classrooms: [classroom('a', 101, 'acme-org')] });

    expect(handed()).toEqual({
      '101': { githubId: '101', verifiedAdmin: false, login: null, reason: 'no_access' },
    });
  });

  it('an organization listed with a login Github would not allow: not verified', async () => {
    mocks.byLogin.mockRejectedValue(notFound());
    theirOrganizations({ login: '<b>acme</b>', databaseId: 101, viewerCanAdminister: true });

    await post({ classrooms: [classroom('a', 101, 'acme-org')] });

    expect(handed()['101']).toMatchObject({ verifiedAdmin: false, login: null });
  });

  it('Github failing to list their organizations: unreachable, no error', async () => {
    mocks.byLogin.mockRejectedValue(notFound());
    mocks.viewer.mockRejectedValue(Object.assign(new Error('Bad gateway'), { status: 502 }));

    await expect(post({ classrooms: [classroom('a', 101, 'acme-org')] })).resolves.toBeDefined();

    expect(handed()).toEqual({
      '101': { githubId: '101', verifiedAdmin: false, login: null, reason: 'unreachable' },
    });
  });

  it('Github not listing their organizations in time: unreachable', async () => {
    mocks.byLogin.mockResolvedValue({ organization: null });
    mocks.viewer.mockReturnValue(new Promise(() => {}));

    const map = await verifyImportOrganizations('gh-token', [classroom('a', 101, 'acme-org')], {
      octokitFor: () => ({ graphql: mocks.graphql }),
      timeoutMs: 20,
    });

    expect(Object.fromEntries(map)).toEqual({
      '101': { githubId: '101', verifiedAdmin: false, login: null, reason: 'unreachable' },
    });
  });

  it('reads their organizations page by page', async () => {
    mocks.byLogin.mockRejectedValue(notFound());
    mocks.viewer
      .mockResolvedValueOnce(
        viewerPage([{ login: 'other-org', databaseId: 303, viewerCanAdminister: true }], 'page-2')
      )
      .mockResolvedValueOnce(
        viewerPage([{ login: 'acme-renamed', databaseId: 101, viewerCanAdminister: true }])
      );

    await post({ classrooms: [classroom('a', 101, 'acme-org')] });

    expect(viewerCalls()).toEqual([
      expect.objectContaining({ after: null }),
      expect.objectContaining({ after: 'page-2' }),
    ]);
    expect(handed()['101']).toMatchObject({ verifiedAdmin: true, login: 'acme-renamed' });
  });

  it('reads at most 10 pages of their organizations', async () => {
    mocks.byLogin.mockRejectedValue(notFound());
    let page = 0;
    mocks.viewer.mockImplementation(async () => {
      page += 1;
      return viewerPage(
        [{ login: `other-${page}`, databaseId: 1000 + page, viewerCanAdminister: true }],
        `page-${page + 1}`
      );
    });

    await post({ classrooms: [classroom('a', 101, 'acme-org')] });

    expect(viewerCalls()).toHaveLength(10);
    expect(handed()['101']).toMatchObject({ verifiedAdmin: false, reason: 'no_access' });
  });

  it.each<{ label: string; value: unknown }>([
    { label: 'null', value: null },
    { label: 'missing', value: undefined },
    { label: 'the string "true"', value: 'true' },
    { label: '1', value: 1 },
  ])('viewerCanAdminister $label among their organizations: not an owner', async ({ value }) => {
    mocks.byLogin.mockRejectedValue(notFound());
    theirOrganizations({ login: 'acme-renamed', databaseId: 101, viewerCanAdminister: value });

    await post({ classrooms: [classroom('a', 101, 'acme-org')] });

    expect(handed()).toEqual({
      '101': { githubId: '101', verifiedAdmin: false, login: null, reason: 'not_admin' },
    });
  });

  it('uses the organizations Github lists beside an error for another one', async () => {
    mocks.byLogin.mockRejectedValue(notFound());
    mocks.viewer.mockRejectedValue(
      Object.assign(new Error('Request failed due to following response errors'), {
        errors: [
          { type: 'FORBIDDEN', message: 'Resource protected by organization SAML enforcement.' },
        ],
        data: viewerPage([
          null,
          { login: 'acme-renamed', databaseId: 101, viewerCanAdminister: true },
        ]),
      })
    );

    await post({ classrooms: [classroom('a', 101, 'acme-org')] });

    expect(handed()['101']).toMatchObject({ verifiedAdmin: true, login: 'acme-renamed' });
  });

  it('lists their organizations once per request, however many need it', async () => {
    mocks.byLogin.mockRejectedValue(notFound());
    theirOrganizations(
      { login: 'acme-renamed', databaseId: 101, viewerCanAdminister: true },
      { login: 'beta-renamed', databaseId: 202, viewerCanAdminister: true }
    );

    await post({
      classrooms: [
        classroom('a', 101, 'acme-org'),
        classroom('b', 202, 'beta-org'),
        classroom('c', 303, 'gamma-org'),
        // The same organization under another export login: not asked again.
        classroom('d', 101, 'acme-old'),
      ],
    });

    expect(byLoginCalls().map(v => (v as { login: string }).login)).toEqual([
      'acme-org',
      'beta-org',
      'gamma-org',
    ]);
    expect(viewerCalls()).toHaveLength(1);
    expect(handed()).toEqual({
      '101': { githubId: '101', verifiedAdmin: true, login: 'acme-renamed', reason: null },
      '202': { githubId: '202', verifiedAdmin: true, login: 'beta-renamed', reason: null },
      '303': { githubId: '303', verifiedAdmin: false, login: null, reason: 'no_access' },
    });
  });

  it('a failed listing is not asked again for the next organization', async () => {
    mocks.byLogin.mockRejectedValue(notFound());
    mocks.viewer.mockRejectedValue(new TypeError('fetch failed'));

    await post({
      classrooms: [classroom('a', 101, 'acme-org'), classroom('b', 202, 'beta-org')],
    });

    expect(viewerCalls()).toHaveLength(1);
    expect(handed()).toEqual({
      '101': { githubId: '101', verifiedAdmin: false, login: null, reason: 'unreachable' },
      '202': { githubId: '202', verifiedAdmin: false, login: null, reason: 'unreachable' },
    });
  });

  it.each<{ label: string; answer: () => void; reason: string }>([
    {
      label: 'SSO not authorized for the token',
      answer: () =>
        mocks.byLogin.mockRejectedValue(
          Object.assign(new Error('forbidden'), {
            errors: [
              {
                type: 'FORBIDDEN',
                message: 'Resource protected by organization SAML enforcement.',
              },
            ],
          })
        ),
      reason: 'no_access',
    },
    {
      label: "the organization's OAuth app restrictions",
      answer: () =>
        mocks.byLogin.mockRejectedValue(
          Object.assign(new Error('the organization has enabled OAuth App access restrictions'), {
            status: 403,
          })
        ),
      reason: 'no_access',
    },
    {
      label: "the organization under the login is the export's, not owned",
      answer: () => githubSays({ login: 'acme-org', databaseId: 101, viewerCanAdminister: false }),
      reason: 'not_admin',
    },
    {
      label: 'a refused token',
      answer: () =>
        mocks.byLogin.mockRejectedValue(
          Object.assign(new Error('Bad credentials'), { status: 401 })
        ),
      reason: 'token_rejected',
    },
    {
      label: 'Github not answering',
      answer: () =>
        mocks.byLogin.mockRejectedValue(Object.assign(new Error('Bad gateway'), { status: 502 })),
      reason: 'unreachable',
    },
  ])('$label: their organizations are not listed', async ({ answer, reason }) => {
    answer();
    theirOrganizations({ login: 'acme-org', databaseId: 101, viewerCanAdminister: true });

    await post({ classrooms: [classroom('a', 101, 'acme-org')] });

    expect(viewerCalls()).toEqual([]);
    expect(handed()).toEqual({
      '101': { githubId: '101', verifiedAdmin: false, login: null, reason },
    });
  });
});
