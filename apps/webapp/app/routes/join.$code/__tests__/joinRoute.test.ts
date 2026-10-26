import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * /join/:code — the shareable class invite link.
 *
 * The page is public but shows only the class name and platform for a live
 * link. The action joins only the classroom the code names (the service does
 * the lookup), refuses while impersonating, audits the join, and on Github
 * sends the student straight to Github's invitation page. A pending student
 * opening the link again retries the git step; staff are sent on, untouched.
 */

const mocks = vi.hoisted(() => ({
  getAuthSession: vi.fn(),
  findJoinableClassroom: vi.fn(),
  joinByCode: vi.fn(),
  classroomFindById: vi.fn(),
  auditCreate: vi.fn(),
  membershipFindMany: vi.fn(),
  membershipFindFirst: vi.fn(),
  userFindUnique: vi.fn(),
  joinGitOrganization: vi.fn(),
}));

vi.mock('@classmoji/auth/server', () => ({
  getAuthSession: (...a: unknown[]) => mocks.getAuthSession(...a),
}));

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    joinLink: {
      findJoinableClassroom: (...a: unknown[]) => mocks.findJoinableClassroom(...a),
      joinByCode: (...a: unknown[]) => mocks.joinByCode(...a),
    },
    classroom: { findById: (...a: unknown[]) => mocks.classroomFindById(...a) },
    audit: { create: (...a: unknown[]) => mocks.auditCreate(...a) },
  },
}));

vi.mock('@classmoji/database', async () => ({
  ...(await vi.importActual<typeof import('@classmoji/database/gitIdentity')>(
    '@classmoji/database/gitIdentity'
  )),
  default: () => ({
    classroomMembership: {
      findMany: (...a: unknown[]) => mocks.membershipFindMany(...a),
      findFirst: (...a: unknown[]) => mocks.membershipFindFirst(...a),
    },
    user: { findUnique: (...a: unknown[]) => mocks.userFindUnique(...a) },
  }),
}));

vi.mock('~/utils/joinGitOrganization.server', () => ({
  joinGitOrganization: (...a: unknown[]) => mocks.joinGitOrganization(...a),
}));

// Client-only pieces the page renders; not under test here.
vi.mock('@classmoji/ui-components', () => ({ Button: () => null, IconGithub: () => null }));
vi.mock('~/components/ui/display/GitlabLogo', () => ({ GitlabLogo: () => null }));
vi.mock('~/utils/connectGitAccount', () => ({ connectGithub: vi.fn(), connectGitlabAt: vi.fn() }));

const { loader, action } = await import('../route');

const CODE = 'abcdEFGH1234_-xy';
const CLASS_X = {
  id: 'class-x',
  name: 'CS 10',
  slug: 'cs10',
  git_organization: { provider: 'GITHUB', login: 'cs10-org', base_url: null },
};
const args = (method = 'GET') =>
  ({
    params: { code: CODE },
    request: new Request(`http://localhost/join/${CODE}`, { method }),
  }) as never;

/** `data()` results carry their payload and init; redirects are Responses. */
const payload = (result: unknown) => (result as { data: Record<string, unknown> }).data;
const status = (result: unknown) =>
  result instanceof Response
    ? result.status
    : (result as { init?: { status?: number } }).init?.status;
const location = (result: unknown) => (result as Response).headers.get('Location');

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.auditCreate.mockResolvedValue(undefined);
  mocks.findJoinableClassroom.mockResolvedValue({ ok: true, classroom: CLASS_X });
  mocks.classroomFindById.mockResolvedValue({
    ...CLASS_X,
    git_organization: { id: 'org-1', ...CLASS_X.git_organization },
  });
});

describe('loader', () => {
  it('says only "not active" for a dead code', async () => {
    mocks.findJoinableClassroom.mockResolvedValue({ ok: false, reason: 'inactive' });
    const result = await loader(args());
    expect(status(result)).toBe(404);
    expect(payload(result)).toEqual({ state: 'inactive' });
  });

  it('shows a signed-out visitor the class name and platform, and a sign-in that returns here', async () => {
    mocks.getAuthSession.mockResolvedValue(null);
    const data = payload(await loader(args()));
    expect(data).toEqual({
      state: 'signed_out',
      classroom: { name: 'CS 10', organization: 'cs10-org', provider: 'GITHUB', gitlabHost: null },
      signInUrl: `/?redirect=${encodeURIComponent(`/join/${CODE}`)}`,
    });
    expect(JSON.stringify(data)).not.toContain('class-x');
  });

  it('sends someone already settled in the class on, and asks a Github-less user to connect', async () => {
    mocks.getAuthSession.mockResolvedValue({ userId: 'teacher' });
    mocks.membershipFindMany.mockResolvedValue([{ role: 'TEACHER', has_accepted_invite: true }]);
    mocks.userFindUnique.mockResolvedValue({ accounts: [] });
    expect(location(await loader(args()))).toBe('/select-organization');

    mocks.getAuthSession.mockResolvedValue({ userId: 'new' });
    mocks.membershipFindMany.mockResolvedValue([]);
    const data = payload(await loader(args()));
    expect(data).toMatchObject({ state: 'ready', pending: false, needsConnect: true });
  });
});

describe('action', () => {
  it('sends a signed-out visitor to sign in, joining nothing', async () => {
    mocks.getAuthSession.mockResolvedValue(null);
    const result = await action(args('POST'));
    expect(location(result)).toBe(`/?redirect=${encodeURIComponent(`/join/${CODE}`)}`);
    expect(mocks.joinByCode).not.toHaveBeenCalled();
  });

  it('refuses while impersonating', async () => {
    mocks.getAuthSession.mockResolvedValue({
      userId: 'student',
      session: { session: { impersonatedBy: 'admin' } },
    });
    const result = await action(args('POST'));
    expect(status(result)).toBe(403);
    expect(mocks.joinByCode).not.toHaveBeenCalled();
  });

  it('joins as the session user, audits it, and opens the Github invitation', async () => {
    mocks.getAuthSession.mockResolvedValue({ userId: 'user-a' });
    mocks.joinByCode.mockResolvedValue({
      status: 'joined',
      classroom: CLASS_X,
      membershipId: 'mem-a',
      matchedRosterInvite: true,
    });
    mocks.joinGitOrganization.mockResolvedValue({
      ok: true,
      outcome: 'invited',
      message: 'sent',
      invitationUrl: 'https://github.com/orgs/cs10-org/invitation',
    });

    const result = await action(args('POST'));

    expect(mocks.joinByCode).toHaveBeenCalledWith({ userId: 'user-a', code: CODE });
    expect(mocks.auditCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: 'user-a',
        classroom_id: 'class-x',
        role: 'STUDENT',
        action: 'CREATE',
        resource_id: 'mem-a',
        data: { tool: 'web:roster.join_link', matched_roster_invite: true },
      }),
      { dedupe: false }
    );
    expect(mocks.joinGitOrganization).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-a',
        membership: { id: 'mem-a', role: 'STUDENT' },
        tool: 'web:roster.join_link',
      })
    );
    expect(location(result)).toBe('https://github.com/orgs/cs10-org/invitation');
  });

  it('reports a dead link without touching git', async () => {
    mocks.getAuthSession.mockResolvedValue({ userId: 'user-a' });
    mocks.joinByCode.mockResolvedValue({ status: 'inactive' });
    expect(status(await action(args('POST')))).toBe(404);
    expect(mocks.joinGitOrganization).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it('retries the git step for a pending student, without a second join row', async () => {
    mocks.getAuthSession.mockResolvedValue({ userId: 'user-b' });
    mocks.joinByCode.mockResolvedValue({
      status: 'already_member',
      classroom: CLASS_X,
      roles: ['STUDENT'],
    });
    mocks.membershipFindFirst.mockResolvedValue({ id: 'mem-b' });
    mocks.joinGitOrganization.mockResolvedValue({ ok: true, outcome: 'joined', message: 'in' });

    const result = await action(args('POST'));

    expect(mocks.auditCreate).not.toHaveBeenCalled();
    expect(mocks.joinGitOrganization).toHaveBeenCalledWith(
      expect.objectContaining({ membership: { id: 'mem-b', role: 'STUDENT' } })
    );
    expect(location(result)).toBe('/select-organization');
  });

  it('never runs the student git step for staff', async () => {
    mocks.getAuthSession.mockResolvedValue({ userId: 'teacher' });
    mocks.joinByCode.mockResolvedValue({
      status: 'already_member',
      classroom: CLASS_X,
      roles: ['TEACHER'],
    });
    mocks.membershipFindFirst.mockResolvedValue(null);
    expect(location(await action(args('POST')))).toBe('/select-organization');
    expect(mocks.joinGitOrganization).not.toHaveBeenCalled();
  });

  it('keeps the membership and asks to connect when the git account is missing', async () => {
    mocks.getAuthSession.mockResolvedValue({ userId: 'user-c' });
    mocks.joinByCode.mockResolvedValue({
      status: 'joined',
      classroom: CLASS_X,
      membershipId: 'mem-c',
      matchedRosterInvite: false,
    });
    mocks.joinGitOrganization.mockResolvedValue({
      ok: false,
      reason: 'needs_connect',
      provider: 'GITHUB',
      message: 'Connect your Github account before joining this classroom.',
    });
    const data = payload(await action(args('POST')));
    expect(data).toEqual({
      error: 'Connect your Github account before joining this classroom.',
      needsConnect: true,
    });
  });
});
