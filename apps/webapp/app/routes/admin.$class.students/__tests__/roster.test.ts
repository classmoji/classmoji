/**
 * Unit tests for the students (roster) route.
 *
 * The policy this route implements has two halves that must not drift into
 * one another:
 *
 *   READ  — the whole teaching team (OWNER/TEACHER/ASSISTANT) may see who is
 *           in the class, but contact details (email, provider_email,
 *           school_id) and the membership grade fields (letter_grade, comment)
 *           are OWNER-only. The split happens in the LOADER, so the fields are
 *           never serialized into the page for other staff — there is nothing
 *           for the client to hide. The MCP roster resource applies the same
 *           split; the two are meant to stay in step.
 *   WRITE — removing a student and revoking an invite stay OWNER-only. The
 *           action carries its own gate, so widening the read can never widen
 *           the write. That is the case these tests pin hardest.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireClassroomTeachingTeam: vi.fn(),
  requireClassroomAdmin: vi.fn(),
  assertClassroomMutationAllowed: vi.fn(),
  findUsersByRole: vi.fn(),
  findInvitesByClassroomId: vi.fn(),
  deleteInvite: vi.fn(),
  taskTrigger: vi.fn(),
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
    classroomInvite: {
      findInvitesByClassroomId: (...a: unknown[]) => mocks.findInvitesByClassroomId(...a),
      deleteInvite: (...a: unknown[]) => mocks.deleteInvite(...a),
    },
  },
}));

vi.mock('@trigger.dev/sdk', () => ({
  tasks: { trigger: (...a: unknown[]) => mocks.taskTrigger(...a) },
}));

vi.mock('~/utils/helpers', () => ({
  waitForRunCompletion: (...a: unknown[]) => mocks.waitForRunCompletion(...a),
}));

// The REAL field-split helper, by its relative path — this file exists to pin
// which contact fields cross the boundary, so a stand-in would pin the
// stand-in. It is shared with the gradebook loader, which is what keeps the
// two screens' contact policy from drifting.
vi.mock(
  '~/utils/studentFields.server',
  async () => await import('../../../utils/studentFields.server.ts')
);

// Mirrors constants/actionTypes.ts — the `~/` specifiers are resolved by these
// mock registrations, so every one the route imports needs an entry.
vi.mock('~/constants', () => ({ ActionTypes: { REMOVE_USER: 'remove-user' } }));

// The loader/action are what is under test; the view layer only needs to be
// importable.
vi.mock('../StudentsTable', () => ({ default: () => null }));
vi.mock('~/components', () => ({ SearchInput: () => null }));
vi.mock('antd', () => ({ Button: () => null }));
vi.mock('@ant-design/icons', () => ({ PlusCircleOutlined: () => null }));

const { loader, action } = await import('../route.tsx');

const CLASS_SLUG = 'cs52-26f';
const CLASSROOM = { id: 'class-1', slug: CLASS_SLUG, status: 'ACTIVE' };

/** A roster row as the service returns it: the full User row + membership bits. */
const STUDENT_ROW = {
  id: 'student-1',
  name: 'Ada Lovelace',
  login: 'ada',
  image: 'https://example.test/ada.png',
  email: 'ada@school.test',
  provider_email: 'ada@github.test',
  school_id: 'F00123',
  stripe_customer_id: 'cus_123',
  banned: false,
  ban_reason: null,
  is_grader: false,
  has_accepted_invite: true,
  letter_grade: 'A-',
  comment: 'strong on recursion',
};

const INVITE_ROW = {
  id: 'invite-1',
  student_name: 'Grace Hopper',
  school_email: 'grace@school.test',
  classroom_id: 'class-1',
};

const OWNER_ONLY_FIELDS = [
  'email',
  'provider_email',
  'school_id',
  'letter_grade',
  'comment',
] as const;

const loaderArgs = (prefix: 'admin' | 'teacher' | 'assistant' = 'admin') =>
  ({
    params: { class: CLASS_SLUG },
    request: new Request(`http://localhost/${prefix}/${CLASS_SLUG}/students`),
  }) as unknown as Parameters<typeof loader>[0];

const actionArgs = (body: unknown, intent: string) =>
  ({
    params: { class: CLASS_SLUG },
    request: new Request(`http://localhost/admin/${CLASS_SLUG}/students?/${intent}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  }) as unknown as Parameters<typeof action>[0];

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.findUsersByRole.mockResolvedValue([STUDENT_ROW]);
  mocks.findInvitesByClassroomId.mockResolvedValue([INVITE_ROW]);
  mocks.taskTrigger.mockResolvedValue({ id: 'run-1' });
  mocks.waitForRunCompletion.mockResolvedValue(undefined);
  mocks.deleteInvite.mockResolvedValue(undefined);
});

function grantLoader(role: 'OWNER' | 'TEACHER' | 'ASSISTANT') {
  mocks.requireClassroomTeachingTeam.mockResolvedValue({
    userId: `${role.toLowerCase()}-1`,
    classroom: CLASSROOM,
    membership: { id: 'm-1', role },
  });
}

// ─── Loader: the teaching team may read the roster ───────────────────────────

describe('students loader — who may read the roster', () => {
  it.each([['OWNER'], ['TEACHER'], ['ASSISTANT']] as const)(
    'admits %s through the teaching-team gate',
    async role => {
      grantLoader(role);

      const data = await loader(loaderArgs());

      expect(mocks.requireClassroomTeachingTeam).toHaveBeenCalledWith(
        expect.any(Request),
        CLASS_SLUG,
        { resourceType: 'STUDENT_ROSTER', action: 'view_roster' }
      );
      // The OWNER-only gate is not what guards the read.
      expect(mocks.requireClassroomAdmin).not.toHaveBeenCalled();
      expect(data.students).toHaveLength(1);
      expect(data.students[0]).toMatchObject({ id: 'student-1', login: 'ada' });
    }
  );

  it('reports ownership to the view so owner-only fields can be withheld', async () => {
    grantLoader('ASSISTANT');
    expect((await loader(loaderArgs())).isOwner).toBe(false);

    grantLoader('OWNER');
    expect((await loader(loaderArgs())).isOwner).toBe(true);
  });

  it('maps the stored image onto avatar_url, which the thumbnail reads', async () => {
    // The User column is `image`; UserThumbnailView reads `avatar_url`. Without
    // the mapping the roster rendered no avatars at all.
    grantLoader('OWNER');

    const student = (await loader(loaderArgs())).students[0];

    expect(student.avatar_url).toBe('https://example.test/ada.png');
  });
});

// ─── Loader: what may be DONE from this page, per prefix ─────────────────────

/**
 * `isOwner` answers "may this viewer see the owner-only fields". `canManage`
 * answers a second, narrower question: "may this viewer act FROM THIS PAGE".
 *
 * They come apart because this loader also serves /assistant/:class/students,
 * which exports no `action` and has no nested per-student route. An owner who
 * hand-types that URL passes the role half and fails the prefix half — every
 * control there submits or navigates relative to the current route, so
 * rendering them would produce a 405 on submit and a 404 on View.
 */
describe('students loader — canManage follows the role AND the prefix', () => {
  it('is true for an OWNER on the /admin prefix', async () => {
    grantLoader('OWNER');

    expect((await loader(loaderArgs('admin'))).canManage).toBe(true);
  });

  it.each([['teacher'], ['assistant']] as const)(
    'is false for an OWNER who arrived on the /%s prefix',
    async prefix => {
      grantLoader('OWNER');

      const data = await loader(loaderArgs(prefix));

      expect(data.canManage).toBe(false);
    }
  );

  it.each([['TEACHER'], ['ASSISTANT']] as const)('is false for %s on either prefix', async role => {
    grantLoader(role);
    expect((await loader(loaderArgs('admin'))).canManage).toBe(false);

    grantLoader(role);
    expect((await loader(loaderArgs('assistant'))).canManage).toBe(false);
  });
});

/**
 * An owner using "Preview as" lands on this same loader under /teacher or
 * /assistant. The point of that control is to show what the role actually sees,
 * so the field split follows the prefix as well as the role — otherwise the
 * preview shows the owner their own view wearing another role's label.
 *
 * The direction is the whole safety property: this can only ever REMOVE fields.
 * A non-owner is not an owner on any prefix, so no prefix can turn one into the
 * other — which is what the last test here pins.
 */
describe('students loader — a preview shows what that role really sees', () => {
  it.each([['teacher'], ['assistant']] as const)(
    'withholds the owner-only fields from an owner previewing on /%s',
    async prefix => {
      grantLoader('OWNER');

      const data = await loader(loaderArgs(prefix));

      expect(data.isOwner).toBe(false);
      for (const field of OWNER_ONLY_FIELDS) {
        expect(data.students[0]).not.toHaveProperty(field);
      }
      expect(data.invitations[0]).not.toHaveProperty('school_email');
    }
  );

  it('still sends an owner everything on their own prefix', async () => {
    grantLoader('OWNER');

    const data = await loader(loaderArgs('admin'));

    expect(data.isOwner).toBe(true);
    expect(data.students[0]).toMatchObject({ email: 'ada@school.test' });
  });

  it('NEVER grants fields the role alone would not have — narrowing only', async () => {
    // The prefix is only allowed to subtract. If a prefix could ever add, this
    // is where it would show up: a non-owner on the owner's own prefix.
    for (const role of ['TEACHER', 'ASSISTANT'] as const) {
      for (const prefix of ['admin', 'teacher', 'assistant'] as const) {
        grantLoader(role);
        const data = await loader(loaderArgs(prefix));

        expect(data.isOwner).toBe(false);
        for (const field of OWNER_ONLY_FIELDS) {
          expect(data.students[0]).not.toHaveProperty(field);
        }
      }
    }
  });
});

// ─── Loader: the OWNER-only field split ──────────────────────────────────────

describe('students loader — field split', () => {
  it('sends an OWNER the contact and grade fields', async () => {
    grantLoader('OWNER');

    const data = await loader(loaderArgs());

    expect(data.students[0]).toMatchObject({
      email: 'ada@school.test',
      provider_email: 'ada@github.test',
      school_id: 'F00123',
      letter_grade: 'A-',
      comment: 'strong on recursion',
    });
    expect(data.invitations[0]).toMatchObject({ school_email: 'grace@school.test' });
  });

  it.each([['TEACHER'], ['ASSISTANT']] as const)(
    'omits the owner-only student fields entirely for %s',
    async role => {
      grantLoader(role);

      const data = await loader(loaderArgs());
      // Inspected as a bag of keys on purpose: the assertions below are about
      // which keys EXIST, which the declared row type deliberately hides.
      const student = data.students[0] as unknown as Record<string, unknown>;

      // Identity and status still come through — the roster stays useful.
      expect(student).toMatchObject({
        id: 'student-1',
        name: 'Ada Lovelace',
        login: 'ada',
        has_accepted_invite: true,
      });
      // The keys are ABSENT, not null: nothing to un-hide on the client.
      for (const field of OWNER_ONLY_FIELDS) {
        expect(field in student).toBe(false);
      }
      // The allowlist also keeps unrelated User columns off the wire.
      expect('stripe_customer_id' in student).toBe(false);
      expect('ban_reason' in student).toBe(false);

      const serialized = JSON.stringify(data);
      expect(serialized).not.toContain('ada@school.test');
      expect(serialized).not.toContain('ada@github.test');
      expect(serialized).not.toContain('F00123');
      expect(serialized).not.toContain('strong on recursion');
    }
  );

  it.each([['TEACHER'], ['ASSISTANT']] as const)(
    "omits a pending invite's contact email for %s",
    async role => {
      grantLoader(role);

      const data = await loader(loaderArgs());
      const invite = data.invitations[0] as Record<string, unknown>;

      expect(invite).toMatchObject({ id: 'invite-1', student_name: 'Grace Hopper' });
      expect('school_email' in invite).toBe(false);
      expect(JSON.stringify(data)).not.toContain('grace@school.test');
    }
  );
});

// ─── Action: mutations stay OWNER-only ───────────────────────────────────────

describe('students action — mutations stay owner-only', () => {
  it('guards every mutation with the OWNER gate, not the teaching-team gate', async () => {
    mocks.requireClassroomAdmin.mockResolvedValue({
      userId: 'owner-1',
      classroom: CLASSROOM,
      membership: { id: 'm-1', role: 'OWNER' },
    });

    await action(actionArgs({ user: { id: 'student-1', login: 'ada' } }, 'removeStudent'));

    expect(mocks.requireClassroomAdmin).toHaveBeenCalledWith(expect.any(Request), CLASS_SLUG, {
      resourceType: 'STUDENT_ROSTER',
      action: 'remove_student',
    });
    expect(mocks.requireClassroomTeachingTeam).not.toHaveBeenCalled();
    expect(mocks.taskTrigger).toHaveBeenCalledTimes(1);
  });

  it.each([['removeStudent'], ['revokeInvite']] as const)(
    '%s is refused for non-OWNER staff, before any work happens',
    async intent => {
      // What requireClassroomAdmin does to a TEACHER/ASSISTANT: it throws.
      mocks.requireClassroomAdmin.mockRejectedValue(new Response('Forbidden', { status: 403 }));

      await expect(
        action(actionArgs({ user: { id: 'student-1' }, inviteId: 'invite-1' }, intent))
      ).rejects.toMatchObject({ status: 403 });

      expect(mocks.taskTrigger).not.toHaveBeenCalled();
      expect(mocks.deleteInvite).not.toHaveBeenCalled();
    }
  );

  it('revokes an invite for an OWNER', async () => {
    mocks.requireClassroomAdmin.mockResolvedValue({
      userId: 'owner-1',
      classroom: CLASSROOM,
      membership: { id: 'm-1', role: 'OWNER' },
    });

    const result = await action(actionArgs({ inviteId: 'invite-1' }, 'revokeInvite'));

    expect(mocks.deleteInvite).toHaveBeenCalledWith('invite-1');
    expect(result).toMatchObject({ action: 'REVOKE_INVITE' });
  });
});
