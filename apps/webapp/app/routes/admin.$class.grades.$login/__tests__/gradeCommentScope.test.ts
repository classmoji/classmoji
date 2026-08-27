/**
 * Unit tests for the grade-comment drawer — its loader's payload and its
 * comment write.
 *
 * LOADER. This drawer renders a name, an avatar and a comment box. It reads
 * them through ONE classroom-scoped, role-pinned, projected lookup, and these
 * tests pin the payload's key set exactly. The route has no entry.server.tsx
 * above it, so whatever a loader returns is turbo-stream-serialised into the
 * page as-is — a global user lookup here would put every other classroom that
 * student belongs to, and those classrooms' provider credentials, in the HTML.
 *
 * ACTION. Authorization binds to the classroom in the URL, but `membershipId`
 * arrives in the JSON body. The write is therefore bound to
 * `{ id, classroom_id }` and only counts when it matched exactly one row, so it
 * cannot land outside the classroom the caller was authorized for. Same
 * property the sibling pages and quizzes actions hold.
 *
 * The role list is asserted here too: this surface moved to OWNER + TEACHER,
 * and the test is what keeps the loader and the action from drifting apart.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  assertClassroomAccess: vi.fn(),
  assertClassroomMutationAllowed: vi.fn(),
  addClassroomAuditLog: vi.fn(),
  updateInClassroom: vi.fn(),
  findStudentByLoginInClassroom: vi.fn(),
}));

vi.mock('~/utils/helpers', () => ({
  assertClassroomAccess: (...a: unknown[]) => mocks.assertClassroomAccess(...a),
  assertClassroomMutationAllowed: (...a: unknown[]) => mocks.assertClassroomMutationAllowed(...a),
  addClassroomAuditLog: (...a: unknown[]) => mocks.addClassroomAuditLog(...a),
}));

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    classroomMembership: {
      updateInClassroom: (...a: unknown[]) => mocks.updateInClassroom(...a),
      findStudentByLoginInClassroom: (...a: unknown[]) => mocks.findStudentByLoginInClassroom(...a),
    },
  },
}));

// The action is what is under test; the view layer only needs to import.
vi.mock('antd', () => ({
  Modal: () => null,
  Input: Object.assign(() => null, { TextArea: () => null }),
}));
vi.mock('react-router', () => ({ useNavigate: () => vi.fn() }));
vi.mock('~/hooks', () => ({ useGlobalFetcher: () => ({ fetcher: null, notify: vi.fn() }) }));
vi.mock('~/components', () => ({ UserThumbnailView: () => null }));

const route = await import('../route.tsx');

const CLASS_SLUG = 'cs52-26f';
const CLASSROOM = { id: 'class-1', slug: CLASS_SLUG, status: 'ACTIVE' };
const OWN_MEMBERSHIP = 'membership-in-this-classroom';
const FOREIGN_MEMBERSHIP = 'membership-in-another-classroom';

const actionArgs = (body: unknown) =>
  ({
    params: { class: CLASS_SLUG, login: 'ada' },
    request: new Request(`http://localhost/admin/${CLASS_SLUG}/grades/ada`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  }) as unknown as Parameters<typeof route.action>[0];

/**
 * An enrollment as the service returns it: the membership's own comment plus
 * the four projected user fields. Nothing else is selectable through it.
 */
const ENROLLMENT = {
  id: OWN_MEMBERSHIP,
  comment: 'strong on recursion',
  letter_grade: 'A-',
  user: {
    id: 'student-1',
    name: 'Ada Lovelace',
    login: 'ada',
    image: 'https://example.test/ada.png',
  },
};

const loaderArgs = (prefix: 'admin' | 'teacher' = 'admin') =>
  ({
    params: { class: CLASS_SLUG, login: 'ada' },
    request: new Request(`http://localhost/${prefix}/${CLASS_SLUG}/grades/ada`),
  }) as unknown as Parameters<typeof route.loader>[0];

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.assertClassroomAccess.mockResolvedValue({
    userId: 'teacher-1',
    classroom: CLASSROOM,
    membership: { id: 'm-1', role: 'TEACHER' },
  });
  mocks.updateInClassroom.mockResolvedValue(true);
  mocks.findStudentByLoginInClassroom.mockResolvedValue(ENROLLMENT);
});

// ─── Loader: exactly what leaves the server ──────────────────────────────────

describe('grade-comment loader — the payload carries only what the drawer renders', () => {
  it('pins the student key set — id, name, login, avatar_url', async () => {
    const { student } = await route.loader(loaderArgs());

    expect(Object.keys(student as object).sort()).toEqual(
      ['avatar_url', 'id', 'login', 'name'].sort()
    );
    // The User column is `image`; UserThumbnailView reads `avatar_url`.
    expect(student.avatar_url).toBe('https://example.test/ada.png');
  });

  it('pins the membership key set — id and comment', async () => {
    const { membership } = await route.loader(loaderArgs());

    expect(Object.keys(membership as object).sort()).toEqual(['comment', 'id'].sort());
  });

  it('resolves the student inside the classroom, pinned to the STUDENT role', async () => {
    // Both halves matter: the classroom keeps other classrooms out of the
    // payload, and the role keeps a dual-role user's other membership from
    // becoming the row this drawer reads and writes.
    await route.loader(loaderArgs());

    expect(mocks.findStudentByLoginInClassroom).toHaveBeenCalledExactlyOnceWith('class-1', 'ada');
  });

  it('answers an unknown login with a 404 rather than a 500', async () => {
    mocks.findStudentByLoginInClassroom.mockResolvedValue(null);

    const thrown = await route.loader(loaderArgs()).catch((e: unknown) => e);

    expect(thrown).toBeInstanceOf(Response);
    expect((thrown as Response).status).toBe(404);
  });

  it('serialises no other classroom, and no provider credential', async () => {
    // What a global user lookup would have dragged in: the student's other
    // classrooms, each one's git_organization row (installation id and access
    // token) and those classrooms' owner memberships.
    const serialized = JSON.stringify(await route.loader(loaderArgs()));

    for (const leak of [
      'git_organization',
      'access_token',
      'github_installation_id',
      'memberships',
      'organization',
      'classroom_memberships',
    ]) {
      expect(serialized).not.toContain(leak);
    }
  });

  it('does not read the student before the authorization gate has passed', async () => {
    mocks.assertClassroomAccess.mockRejectedValue(new Response('Forbidden', { status: 403 }));

    await expect(route.loader(loaderArgs())).rejects.toBeInstanceOf(Response);
    expect(mocks.findStudentByLoginInClassroom).not.toHaveBeenCalled();
  });
});

describe('grade-comment action — the comment write is audited', () => {
  it('records the write against the membership it landed on', async () => {
    await route.action(actionArgs({ membershipId: OWN_MEMBERSHIP, comment: 'Strong finish.' }));

    expect(mocks.addClassroomAuditLog).toHaveBeenCalledExactlyOnceWith({
      classroomId: 'class-1',
      userId: 'teacher-1',
      role: 'TEACHER',
      action: 'UPDATE',
      resourceType: 'GRADES',
      resourceId: OWN_MEMBERSHIP,
      metadata: { tool: 'web:grades.update_comment', cleared: false },
    });
  });

  it('records that a comment was cleared without recording what it said', async () => {
    // The note is a private remark about a named student; the trail answers
    // who changed what and when, not its contents.
    await route.action(actionArgs({ membershipId: OWN_MEMBERSHIP, comment: '' }));

    const [row] = mocks.addClassroomAuditLog.mock.calls[0] as [Record<string, unknown>];
    expect(row.metadata).toEqual({ tool: 'web:grades.update_comment', cleared: true });
  });

  it('does not put the comment text in the audit row', async () => {
    await route.action(
      actionArgs({ membershipId: OWN_MEMBERSHIP, comment: 'struggling with recursion' })
    );

    const [row] = mocks.addClassroomAuditLog.mock.calls[0] as [Record<string, unknown>];
    expect(JSON.stringify(row)).not.toContain('struggling with recursion');
  });

  it('writes no row when the write did not land, or the body was refused', async () => {
    mocks.updateInClassroom.mockResolvedValue(false);
    await route.action(actionArgs({ membershipId: FOREIGN_MEMBERSHIP, comment: 'nope' }));
    expect(mocks.addClassroomAuditLog).not.toHaveBeenCalled();

    await route.action(actionArgs({ comment: 'orphan' }));
    expect(mocks.addClassroomAuditLog).not.toHaveBeenCalled();
  });
});

describe('grade-comment action — writes stay inside the authorized classroom', () => {
  it('binds the comment write to the classroom that was authorized', async () => {
    const result = await route.action(
      actionArgs({ membershipId: OWN_MEMBERSHIP, comment: 'Strong final project.' })
    );

    expect(result).toEqual({ action: 'ADD_GRADE_COMMENT', success: 'Saved comment.' });
    expect(mocks.updateInClassroom).toHaveBeenCalledExactlyOnceWith(OWN_MEMBERSHIP, 'class-1', {
      comment: 'Strong final project.',
    });
  });

  it('refuses a membership that belongs to another classroom', async () => {
    mocks.updateInClassroom.mockResolvedValue(false);

    const result = await route.action(
      actionArgs({ membershipId: FOREIGN_MEMBERSHIP, comment: 'nope' })
    );

    expect(result).toEqual({ action: 'ADD_GRADE_COMMENT', error: 'Student not found.' });
    expect(mocks.updateInClassroom).toHaveBeenCalledWith(FOREIGN_MEMBERSHIP, 'class-1', {
      comment: 'nope',
    });
  });

  it('does not write when the authorization gate throws', async () => {
    mocks.assertClassroomAccess.mockRejectedValue(new Response('Forbidden', { status: 403 }));

    await expect(
      route.action(actionArgs({ membershipId: OWN_MEMBERSHIP, comment: 'hi' }))
    ).rejects.toBeInstanceOf(Response);
    expect(mocks.updateInClassroom).not.toHaveBeenCalled();
  });
});

describe('grade-comment action — role list', () => {
  it('admits OWNER and TEACHER, and no other role', async () => {
    await route.action(actionArgs({ membershipId: OWN_MEMBERSHIP, comment: 'ok' }));

    expect(mocks.assertClassroomAccess).toHaveBeenCalledWith(
      expect.objectContaining({ allowedRoles: ['OWNER', 'TEACHER'] })
    );
  });

  it.each([['admin'], ['teacher']] as const)(
    'reads with the same role list it writes with, on the /%s prefix',
    async prefix => {
      // The drawer is served under both prefixes a TEACHER's gradebook is, so
      // the /teacher path is exercised rather than assumed.
      await route.loader(loaderArgs(prefix));

      expect(mocks.assertClassroomAccess).toHaveBeenCalledWith(
        expect.objectContaining({ allowedRoles: ['OWNER', 'TEACHER'] })
      );
    }
  );
});

describe('grade-comment action — body validation', () => {
  it('accepts an empty comment, which clears the note', async () => {
    await route.action(actionArgs({ membershipId: OWN_MEMBERSHIP, comment: '' }));

    expect(mocks.updateInClassroom).toHaveBeenCalledWith(OWN_MEMBERSHIP, 'class-1', {
      comment: '',
    });
  });

  it('refuses a missing membership id rather than writing with it', async () => {
    const result = await route.action(actionArgs({ comment: 'orphan' }));

    expect(result).toEqual({ action: 'ADD_GRADE_COMMENT', error: 'Invalid request.' });
    expect(mocks.updateInClassroom).not.toHaveBeenCalled();
  });

  it('refuses a comment that is not a string', async () => {
    const result = await route.action(
      actionArgs({ membershipId: OWN_MEMBERSHIP, comment: { toString: 'x' } })
    );

    expect(result).toEqual({ action: 'ADD_GRADE_COMMENT', error: 'Invalid request.' });
    expect(mocks.updateInClassroom).not.toHaveBeenCalled();
  });
});
