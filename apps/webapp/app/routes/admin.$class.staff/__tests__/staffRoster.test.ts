/**
 * Unit tests for the Teaching Staff loader and its payload.
 *
 * This screen used to be OWNER-only, and its loader built each row with
 * `{ ...user, role }` — a raw spread of the whole User record. That shipped
 * email, provider_email, school_id, stripe_customer_id, banned, ban_reason and
 * ban_expires_at to the browser, plus the membership's letter_grade and comment.
 * It was contained only by the gate.
 *
 * The gate is now the teaching-team one, so the containment has to come from the
 * payload itself. These tests pin that: an explicit allowlist, keys ABSENT
 * rather than nulled, and a serialized sweep so a future field added to the User
 * model cannot ride along unnoticed.
 *
 * They also pin the OTHER half of the widening — that it widened the READ only.
 * `canManage` is derived server-side from role AND path, never from the client
 * role store, and the mutations keep their own OWNER gate in ./action.ts.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireClassroomTeachingTeam: vi.fn(),
  requireClassroomAdmin: vi.fn(),
  assertClassroomMutationAllowed: vi.fn(),
  findUsersByRole: vi.fn(),
  addStaff: vi.fn(),
  updateStaff: vi.fn(),
  removeStaff: vi.fn(),
  waitForRunCompletion: vi.fn(),
}));

vi.mock('~/utils/routeAuth.server', () => ({
  requireClassroomTeachingTeam: (...a: unknown[]) => mocks.requireClassroomTeachingTeam(...a),
  requireClassroomAdmin: (...a: unknown[]) => mocks.requireClassroomAdmin(...a),
  assertClassroomMutationAllowed: (...a: unknown[]) => mocks.assertClassroomMutationAllowed(...a),
}));

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    classroomMembership: { findUsersByRole: (...a: unknown[]) => mocks.findUsersByRole(...a) },
    staff: {
      addStaff: (...a: unknown[]) => mocks.addStaff(...a),
      updateStaff: (...a: unknown[]) => mocks.updateStaff(...a),
      removeStaff: (...a: unknown[]) => mocks.removeStaff(...a),
    },
  },
  StaffServiceError: class StaffServiceError extends Error {},
}));

vi.mock('~/utils/helpers', () => ({
  waitForRunCompletion: (...a: unknown[]) => mocks.waitForRunCompletion(...a),
}));

vi.mock('~/constants', () => ({
  ActionTypes: { SAVE_USER: 'save-user', REMOVE_USER: 'remove-user' },
}));

// The loader is what is under test; the view layer only needs to be importable.
vi.mock('~/components', () => ({
  ButtonNew: () => null,
  UserThumbnailView: () => null,
  SearchInput: () => null,
  TableActionButtons: () => null,
}));
vi.mock('~/hooks', () => ({
  useGlobalFetcher: () => ({ fetcher: null, notify: () => {} }),
  useDisclosure: () => ({ show: () => {}, close: () => {}, visible: false }),
}));
vi.mock('@classmoji/ui-components', () => ({ useCallout: () => ({ show: () => {} }) }));
vi.mock('@classmoji/auth/client', () => ({
  authClient: { admin: { impersonateUser: () => {} } },
}));
vi.mock('../FormStaff', () => ({ default: () => null }));

const adminRoute = await import('../route.tsx');
const assistantRoute = await import('../../assistant.$class_.staff/route.tsx');
const teacherRoute = await import('../../teacher.$class_.staff/route.tsx');

const CLASS_SLUG = 'cs52-26f';
const CLASSROOM = { id: 'class-1', slug: CLASS_SLUG, status: 'ACTIVE' };

/**
 * A row exactly as `findUsersByRole` returns it: the whole User record with the
 * membership's is_grader / has_accepted_invite / letter_grade / comment merged
 * on top. Every sensitive field the old raw spread leaked is present here on
 * purpose — that is what the allowlist is being tested against.
 */
const RAW_STAFF_ROW = {
  id: 'user-1',
  name: 'Ada Lovelace',
  login: 'ada',
  // `image` and `avatar_url` are deliberately DIFFERENT urls: they are two
  // different fields (the sign-in column and the result extension's computed
  // one) and the loader must be seen to read the computed one.
  image: 'https://example.test/ada.png',
  avatar_url: 'https://avatars.githubusercontent.com/u/424242?v=4',
  email: 'ada@school.test',
  provider_email: 'ada@github.test',
  school_id: 'F00123',
  stripe_customer_id: 'cus_deadbeef',
  banned: true,
  ban_reason: 'spamming the syllabus bot',
  ban_expires_at: '2027-01-01T00:00:00.000Z',
  provider: 'GITHUB',
  provider_id: '424242',
  is_grader: true,
  has_accepted_invite: true,
  letter_grade: 'A-',
  comment: 'strong on recursion',
};

/** Keys that must never appear on a staff row, for ANY viewer. */
const FORBIDDEN_FIELDS = [
  'email',
  'provider_email',
  'school_id',
  'stripe_customer_id',
  'banned',
  'ban_reason',
  'ban_expires_at',
  'letter_grade',
  'comment',
] as const;

const loaderArgs = (pathname: string) =>
  ({
    params: { class: CLASS_SLUG },
    request: new Request(`http://localhost${pathname}`),
  }) as unknown as Parameters<typeof adminRoute.loader>[0];

const asOwner = () =>
  mocks.requireClassroomTeachingTeam.mockResolvedValue({
    userId: 'owner-1',
    classroom: CLASSROOM,
    membership: { id: 'm-1', role: 'OWNER' },
  });

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  // One call per role; the loader queries OWNER, TEACHER and ASSISTANT in turn.
  mocks.findUsersByRole.mockResolvedValue([RAW_STAFF_ROW]);
  mocks.requireClassroomTeachingTeam.mockResolvedValue({
    userId: 'ta-1',
    classroom: CLASSROOM,
    membership: { id: 'm-1', role: 'ASSISTANT' },
  });
});

// ─── Who may read the list ───────────────────────────────────────────────────

describe('staff loader — access', () => {
  it('reads at the teaching-team tier, not the admin one', async () => {
    await adminRoute.loader(loaderArgs(`/admin/${CLASS_SLUG}/staff`));

    expect(mocks.requireClassroomTeachingTeam).toHaveBeenCalledWith(
      expect.any(Request),
      CLASS_SLUG,
      { resourceType: 'TEACHING_STAFF', action: 'view_staff' }
    );
    expect(mocks.requireClassroomAdmin).not.toHaveBeenCalled();
  });

  it('lets an ASSISTANT see the whole team, one row per role held', async () => {
    const data = await adminRoute.loader(loaderArgs(`/assistant/${CLASS_SLUG}/staff`));

    // OWNER, TEACHER and ASSISTANT are each queried separately, so the mocked
    // single row comes back three times — once per role, tagged with it.
    expect(data.staff.map(row => row.role)).toEqual(['OWNER', 'TEACHER', 'ASSISTANT']);
  });

  it('propagates a refusal from the gate instead of returning a payload', async () => {
    mocks.requireClassroomTeachingTeam.mockRejectedValue(
      new Response('Forbidden', { status: 403 })
    );

    await expect(
      adminRoute.loader(loaderArgs(`/admin/${CLASS_SLUG}/staff`))
    ).rejects.toBeInstanceOf(Response);
  });
});

// ─── The field allowlist ─────────────────────────────────────────────────────

describe('staff loader — payload allowlist', () => {
  it('emits exactly the allowlisted keys and nothing else', async () => {
    asOwner();
    const data = await adminRoute.loader(loaderArgs(`/admin/${CLASS_SLUG}/staff`));

    expect(Object.keys(data.staff[0]).sort()).toEqual([
      'avatar_url',
      'has_accepted_invite',
      'id',
      'is_grader',
      'login',
      'name',
      'role',
    ]);
  });

  it('withholds every sensitive field from an OWNER too, not just from staff', async () => {
    // Unlike the roster there is no owner-only branch here: no column on this
    // screen needs a contact field, so shipping one to anybody would be dead
    // payload. The keys are ABSENT, not null — nothing for a client to un-hide.
    asOwner();
    const data = await adminRoute.loader(loaderArgs(`/admin/${CLASS_SLUG}/staff`));
    const row = data.staff[0] as unknown as Record<string, unknown>;

    for (const field of FORBIDDEN_FIELDS) {
      expect(field in row).toBe(false);
    }
  });

  it('withholds them from a non-owner as well', async () => {
    const data = await adminRoute.loader(loaderArgs(`/assistant/${CLASS_SLUG}/staff`));
    const row = data.staff[0] as unknown as Record<string, unknown>;

    for (const field of FORBIDDEN_FIELDS) {
      expect(field in row).toBe(false);
    }
  });

  it('serializes none of the sensitive VALUES anywhere in the response', async () => {
    // Belt and braces over the key check: a value smuggled in under a different
    // key, or nested somewhere new, fails here.
    asOwner();
    const serialized = JSON.stringify(
      await adminRoute.loader(loaderArgs(`/admin/${CLASS_SLUG}/staff`))
    );

    expect(serialized).not.toContain('ada@school.test');
    expect(serialized).not.toContain('ada@github.test');
    expect(serialized).not.toContain('F00123');
    expect(serialized).not.toContain('cus_deadbeef');
    expect(serialized).not.toContain('spamming the syllabus bot');
    expect(serialized).not.toContain('strong on recursion');
    expect(serialized).not.toContain('A-');
  });

  it('no longer ships the requester GitHub token to the browser', async () => {
    // The loader used to return `token: authData?.token` purely so the add form
    // could run its own octokit lookup. The server resolves the profile itself,
    // so the token has no business in the page.
    asOwner();
    const data = (await adminRoute.loader(
      loaderArgs(`/admin/${CLASS_SLUG}/staff`)
    )) as unknown as Record<string, unknown>;

    expect('token' in data).toBe(false);
  });

  it('reads the COMPUTED avatar_url, not the raw image column', async () => {
    // UserThumbnailView renders its <img> only when `avatar_url` is truthy and
    // has no fallback, and `image` is written at sign-in — so reading `image`
    // here left every freshly invited staff member with a blank thumbnail until
    // their first OAuth round trip. The Prisma result extension in
    // packages/database computes `avatar_url` from provider_id instead, which is
    // never null (a GitHub avatar, else a default icon).
    asOwner();
    const data = await adminRoute.loader(loaderArgs(`/admin/${CLASS_SLUG}/staff`));

    expect(data.staff[0].avatar_url).toBe('https://avatars.githubusercontent.com/u/424242?v=4');
  });

  it('still has an avatar for a staff member who has never signed in', async () => {
    // The regression this pins: `image` is null right up until the invited
    // person first signs in, which is exactly when an owner is looking at the
    // row they just created.
    asOwner();
    mocks.findUsersByRole.mockResolvedValue([{ ...RAW_STAFF_ROW, image: null }]);

    const data = await adminRoute.loader(loaderArgs(`/admin/${CLASS_SLUG}/staff`));

    expect(data.staff[0].avatar_url).toBe('https://avatars.githubusercontent.com/u/424242?v=4');
  });

  it('does not ship the raw image column at all — nothing reads it', async () => {
    asOwner();
    const data = await adminRoute.loader(loaderArgs(`/admin/${CLASS_SLUG}/staff`));
    const row = data.staff[0] as unknown as Record<string, unknown>;

    expect('image' in row).toBe(false);
  });
});

// ─── Management authority ────────────────────────────────────────────────────

describe('staff loader — canManage', () => {
  it('is true for an OWNER on the /admin prefix', async () => {
    asOwner();
    expect((await adminRoute.loader(loaderArgs(`/admin/${CLASS_SLUG}/staff`))).canManage).toBe(
      true
    );
  });

  it('is false for an ASSISTANT even on the /admin prefix', async () => {
    // The /admin layout's OWNER check is client-side and its loader degrades
    // rather than throwing, so a non-owner does reach this loader at /admin.
    expect((await adminRoute.loader(loaderArgs(`/admin/${CLASS_SLUG}/staff`))).canManage).toBe(
      false
    );
  });

  it('is false for a TEACHER', async () => {
    mocks.requireClassroomTeachingTeam.mockResolvedValue({
      userId: 'teacher-1',
      classroom: CLASSROOM,
      membership: { id: 'm-1', role: 'TEACHER' },
    });

    expect((await adminRoute.loader(loaderArgs(`/teacher/${CLASS_SLUG}/staff`))).canManage).toBe(
      false
    );
  });

  it('is false for an OWNER who hand-types a non-admin prefix', async () => {
    // Those prefixes export no action and have no detail child, so a control
    // shown there would post to a 405 or open a 404.
    asOwner();

    expect((await adminRoute.loader(loaderArgs(`/assistant/${CLASS_SLUG}/staff`))).canManage).toBe(
      false
    );
    expect((await adminRoute.loader(loaderArgs(`/teacher/${CLASS_SLUG}/staff`))).canManage).toBe(
      false
    );
  });

  it('is not a path check alone — the prefix can only subtract', async () => {
    // Narrowing only. An assistant on /admin is still not an owner.
    const data = await adminRoute.loader(loaderArgs(`/admin/${CLASS_SLUG}/staff`));
    expect(data.canManage).toBe(false);
  });
});

// ─── The non-owner prefixes ──────────────────────────────────────────────────

describe('staff route — the assistant and teacher prefixes', () => {
  it('serve the admin loader itself, so the allowlist cannot drift', () => {
    expect(assistantRoute.loader).toBe(adminRoute.loader);
    expect(teacherRoute.loader).toBe(adminRoute.loader);
  });

  it('serve the admin component, not a copy', () => {
    expect(assistantRoute.default).toBe(adminRoute.default);
    expect(teacherRoute.default).toBe(adminRoute.default);
  });

  it('export no action, so those prefixes have no POST target at all', () => {
    expect('action' in assistantRoute).toBe(false);
    expect((assistantRoute as Record<string, unknown>).action).toBeUndefined();
    expect('action' in teacherRoute).toBe(false);
    expect((teacherRoute as Record<string, unknown>).action).toBeUndefined();
  });

  it('leave the OWNER-only mutations behind on the admin route', () => {
    expect(typeof adminRoute.action).toBe('function');
  });
});
