/**
 * Unit tests for the gradebook route — the loader's payload and the
 * letter-grade write.
 *
 * LOADER. Everything this loader returns is serialised into the page, and the
 * services behind it hand back whole `User` and `ClassroomMembership` rows. So
 * the loader projects each source down to the fields the table renders, and
 * these tests pin the resulting key set EXACTLY — the table's row type cannot
 * do it for them, and this surface is served to a TEACHER as well as an OWNER.
 * The contact trio is OWNER-only, matching the roster route it shares
 * `pickOwnerOnlyContactFields` with.
 *
 * ACTION. Authorization binds to the classroom in the URL, but `membership_id`
 * arrives in the JSON body. The write is therefore bound to
 * `{ id, classroom_id }` and only counts when it matched exactly one row, so it
 * cannot land outside the classroom the caller was authorized for. Same
 * property the sibling pages and quizzes actions hold.
 *
 * The body fields are also read as types rather than passed through, so a
 * malformed submission is refused instead of reaching the database.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireClassroomStaff: vi.fn(),
  assertClassroomMutationAllowed: vi.fn(),
  addAuditLog: vi.fn(),
  addClassroomAuditLog: vi.fn(),
  updateInClassroom: vi.fn(),
  findByClassroomId: vi.fn(),
  findEmojiMappings: vi.fn(),
  findByClassroomSlug: vi.fn(),
  findRepositoriesPerStudent: vi.fn(),
  getClassroomSettingsForServer: vi.fn(),
  findLetterGradeMappings: vi.fn(),
}));

vi.mock('~/utils/routeAuth.server', () => ({
  requireClassroomStaff: (...a: unknown[]) => mocks.requireClassroomStaff(...a),
  assertClassroomMutationAllowed: (...a: unknown[]) => mocks.assertClassroomMutationAllowed(...a),
}));

vi.mock('~/utils/helpers', () => ({
  addAuditLog: (...a: unknown[]) => mocks.addAuditLog(...a),
  addClassroomAuditLog: (...a: unknown[]) => mocks.addClassroomAuditLog(...a),
}));

// The `~/` specifiers are resolved by these mock registrations (vitest.config
// declares no alias), so every one the route imports needs an entry. This one
// hands back the REAL module by its relative path — the field split is the
// thing under test here, so a stand-in would only pin the stand-in.
vi.mock(
  '~/utils/studentFields.server',
  async () => await import('../../../utils/studentFields.server.ts')
);

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    classroomMembership: {
      updateInClassroom: (...a: unknown[]) => mocks.updateInClassroom(...a),
      findByClassroomId: (...a: unknown[]) => mocks.findByClassroomId(...a),
    },
    emojiMapping: { findByClassroomId: (...a: unknown[]) => mocks.findEmojiMappings(...a) },
    repository: { findByClassroomSlug: (...a: unknown[]) => mocks.findByClassroomSlug(...a) },
    user: {
      findRepositoriesPerStudent: (...a: unknown[]) => mocks.findRepositoriesPerStudent(...a),
    },
    classroom: {
      getClassroomSettingsForServer: (...a: unknown[]) => mocks.getClassroomSettingsForServer(...a),
    },
    letterGradeMapping: {
      findByClassroomId: (...a: unknown[]) => mocks.findLetterGradeMappings(...a),
    },
  },
}));

// The loader and action are what is under test; the view layer only needs to
// be importable.
vi.mock('../GradesTable', () => ({ default: () => null }));
vi.mock('antd', () => ({ Skeleton: () => null }));
vi.mock('react-router', () => ({ Await: () => null, Outlet: () => null }));

const route = await import('../route.tsx');

const CLASS_SLUG = 'cs52-26f';
const CLASSROOM = { id: 'class-1', slug: CLASS_SLUG, status: 'ACTIVE' };
const OWN_MEMBERSHIP = 'membership-in-this-classroom';
const FOREIGN_MEMBERSHIP = 'membership-in-another-classroom';

/**
 * A student as `findRepositoriesPerStudent` returns it: the whole `User` row
 * plus the classroom's repos. Everything past `git_repos` is what must NOT
 * reach the browser.
 */
const STUDENT_ROW = {
  id: 'student-1',
  name: 'Ada Lovelace',
  login: 'ada',
  image: 'https://example.test/ada.png',
  git_repos: [{ id: 'repo-1', assignments: [] }],
  email: 'ada@school.test',
  provider_email: 'ada@github.test',
  school_id: 'F00123',
  role: 'user',
  banned: false,
  ban_reason: null,
  ban_expires_at: null,
  stripe_customer_id: 'cus_123',
};

/** A membership as `findByClassroomId` returns it: the row plus the user. */
const MEMBERSHIP_ROW = {
  id: OWN_MEMBERSHIP,
  user_id: 'student-1',
  classroom_id: 'class-1',
  role: 'STUDENT',
  comment: 'strong on recursion',
  letter_grade: 'A-',
  is_grader: false,
  user: STUDENT_ROW,
};

const CONTACT_FIELDS = ['email', 'provider_email', 'school_id'] as const;

const actionArgs = (body: unknown) =>
  ({
    params: { class: CLASS_SLUG },
    request: new Request(`http://localhost/admin/${CLASS_SLUG}/grades`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  }) as unknown as Parameters<typeof route.action>[0];

const loaderArgs = (prefix: 'admin' | 'teacher' = 'admin') =>
  ({
    params: { class: CLASS_SLUG },
    request: new Request(`http://localhost/${prefix}/${CLASS_SLUG}/grades`),
  }) as unknown as Parameters<typeof route.loader>[0];

/**
 * Resolve the loader's deferred payload into the positional array the
 * component destructures. The loader hands back one `Promise.all`, so the
 * order here is the order of `promises` in the route.
 */
const resolveLoader = async (prefix: 'admin' | 'teacher' = 'admin') => {
  const { allData } = await route.loader(loaderArgs(prefix));
  const [emojiMappings, repositories, students, settings, letterGradeMappings, memberships] =
    (await allData) as unknown[];
  return { emojiMappings, repositories, students, settings, letterGradeMappings, memberships };
};

function grantLoader(role: 'OWNER' | 'TEACHER') {
  mocks.requireClassroomStaff.mockResolvedValue({
    userId: `${role.toLowerCase()}-1`,
    classroom: CLASSROOM,
    membership: { id: 'm-1', role },
  });
}

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.requireClassroomStaff.mockResolvedValue({
    userId: 'teacher-1',
    classroom: CLASSROOM,
    membership: { id: 'm-1', role: 'TEACHER' },
  });
  mocks.updateInClassroom.mockResolvedValue(true);
  mocks.findRepositoriesPerStudent.mockResolvedValue([STUDENT_ROW]);
  mocks.findByClassroomId.mockResolvedValue([MEMBERSHIP_ROW]);
  mocks.findEmojiMappings.mockResolvedValue({});
  mocks.findByClassroomSlug.mockResolvedValue([]);
  mocks.getClassroomSettingsForServer.mockResolvedValue({
    late_penalty_points_per_hour: 2,
    show_grades_to_students: true,
    quizzes_enabled: true,
  });
  mocks.findLetterGradeMappings.mockResolvedValue([]);
});

// ─── Loader: exactly what leaves the server ──────────────────────────────────

describe('grades loader — the payload carries only what the table renders', () => {
  it.each([['OWNER'], ['TEACHER']] as const)('sends %s a closed student key set', async role => {
    grantLoader(role);

    const { students } = await resolveLoader();
    const student = (students as Record<string, unknown>[])[0];

    const expected = ['id', 'name', 'login', 'avatar_url', 'git_repos'];
    if (role === 'OWNER') expected.push(...CONTACT_FIELDS);

    expect(Object.keys(student).sort()).toEqual(expected.sort());
  });

  it('pins the membership key set — id, user_id, comment, letter_grade', async () => {
    grantLoader('TEACHER');

    const { memberships } = await resolveLoader();
    const membership = (memberships as Record<string, unknown>[])[0];

    // Notably no nested `user`: the table joins these to students by `user_id`.
    expect(Object.keys(membership).sort()).toEqual(
      ['comment', 'id', 'letter_grade', 'user_id'].sort()
    );
  });

  it('asks for the STUDENT memberships alone', async () => {
    // ClassroomMembership is unique on (classroom_id, user_id, role), so a
    // dual-role user holds several rows. The table joins by `user_id` with a
    // `find` — handed every role it could pick a teaching-staff row and send
    // that row's id back as the write target.
    grantLoader('OWNER');

    await resolveLoader();

    expect(mocks.findByClassroomId).toHaveBeenCalledWith('class-1', 'STUDENT');
  });

  it('maps the stored image onto avatar_url, which the thumbnail reads', async () => {
    grantLoader('OWNER');

    const { students } = await resolveLoader();

    expect((students as { avatar_url: string }[])[0].avatar_url).toBe(
      'https://example.test/ada.png'
    );
  });

  it('passes git_repos through untouched — the grade maths walks it', async () => {
    grantLoader('TEACHER');

    const { students } = await resolveLoader();

    expect((students as { git_repos: unknown }[])[0].git_repos).toEqual(STUDENT_ROW.git_repos);
  });

  it('narrows the settings row to the one field the table reads', async () => {
    grantLoader('OWNER');

    const { settings } = await resolveLoader();

    expect(settings).toEqual({ late_penalty_points_per_hour: 2 });
  });
});

describe('grades loader — the contact fields are OWNER-only', () => {
  it('sends an OWNER the contact trio', async () => {
    grantLoader('OWNER');

    const { students } = await resolveLoader();

    expect((students as Record<string, unknown>[])[0]).toMatchObject({
      email: 'ada@school.test',
      provider_email: 'ada@github.test',
      school_id: 'F00123',
    });
  });

  it.each([['admin'], ['teacher']] as const)(
    'omits them entirely for a TEACHER on the /%s prefix',
    async prefix => {
      grantLoader('TEACHER');

      const { students } = await resolveLoader(prefix);
      const student = (students as Record<string, unknown>[])[0];

      // The keys are ABSENT, not null: nothing to un-hide on the client.
      for (const field of CONTACT_FIELDS) {
        expect(field in student).toBe(false);
      }
    }
  );

  it.each([['OWNER'], ['TEACHER']] as const)(
    'never serialises the rest of the User row for %s',
    async role => {
      grantLoader(role);

      const resolved = await resolveLoader();
      const serialized = JSON.stringify(resolved);

      // The global better-auth role, ban state, billing id and the membership's
      // nested user all live on the rows the services return.
      expect(serialized).not.toContain('cus_123');
      expect(serialized).not.toContain('ban_reason');
      expect(serialized).not.toContain('ban_expires_at');
      expect(serialized).not.toContain('stripe_customer_id');
      if (role === 'TEACHER') {
        expect(serialized).not.toContain('ada@school.test');
        expect(serialized).not.toContain('ada@github.test');
        expect(serialized).not.toContain('F00123');
      }
    }
  );
});

// ─── Action: the audit row ───────────────────────────────────────────────────

describe('grades action — the letter-grade write is audited', () => {
  it('records the write against the membership it landed on', async () => {
    await route.action(actionArgs({ membership_id: OWN_MEMBERSHIP, letter_grade: 'A-' }));

    expect(mocks.addClassroomAuditLog).toHaveBeenCalledExactlyOnceWith({
      classroomId: 'class-1',
      userId: 'teacher-1',
      role: 'TEACHER',
      action: 'UPDATE',
      resourceType: 'GRADES',
      resourceId: OWN_MEMBERSHIP,
      metadata: { tool: 'web:grades.update_letter_grade', letter_grade: 'A-' },
    });
  });

  it('records a cleared grade as cleared', async () => {
    await route.action(actionArgs({ membership_id: OWN_MEMBERSHIP, letter_grade: '' }));

    expect(mocks.addClassroomAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining({ letter_grade: null }) })
    );
  });

  it('writes no row when the write did not land', async () => {
    // A row naming this classroom must describe a change that happened in it.
    mocks.updateInClassroom.mockResolvedValue(false);

    await route.action(actionArgs({ membership_id: FOREIGN_MEMBERSHIP, letter_grade: 'A' }));

    expect(mocks.addClassroomAuditLog).not.toHaveBeenCalled();
  });

  it('writes no row when the body was refused', async () => {
    await route.action(actionArgs({ letter_grade: 'A' }));

    expect(mocks.addClassroomAuditLog).not.toHaveBeenCalled();
  });
});

describe('grades action — writes stay inside the authorized classroom', () => {
  it('binds the letter-grade write to the classroom that was authorized', async () => {
    const result = await route.action(
      actionArgs({ membership_id: OWN_MEMBERSHIP, letter_grade: 'A-' })
    );

    expect(result).toEqual({ success: true });
    expect(mocks.updateInClassroom).toHaveBeenCalledExactlyOnceWith(OWN_MEMBERSHIP, 'class-1', {
      letter_grade: 'A-',
    });
  });

  it('refuses a membership that belongs to another classroom', async () => {
    mocks.updateInClassroom.mockResolvedValue(false);

    const result = await route.action(
      actionArgs({ membership_id: FOREIGN_MEMBERSHIP, letter_grade: 'A' })
    );

    expect(result).toEqual({ error: 'Student not found.' });
    // The classroom went into the query, so the refusal came from the write
    // itself rather than from a separate check that could drift out of step.
    expect(mocks.updateInClassroom).toHaveBeenCalledWith(FOREIGN_MEMBERSHIP, 'class-1', {
      letter_grade: 'A',
    });
  });

  it('does not write when the authorization gate throws', async () => {
    mocks.requireClassroomStaff.mockRejectedValue(new Response('Forbidden', { status: 403 }));

    await expect(
      route.action(actionArgs({ membership_id: OWN_MEMBERSHIP, letter_grade: 'A' }))
    ).rejects.toBeInstanceOf(Response);
    expect(mocks.updateInClassroom).not.toHaveBeenCalled();
  });

  it('asks for OWNER or TEACHER, and no other role', async () => {
    await route.action(actionArgs({ membership_id: OWN_MEMBERSHIP, letter_grade: 'B' }));

    // requireClassroomStaff is ['OWNER', 'TEACHER'] — assistants no longer
    // reach this surface.
    expect(mocks.requireClassroomStaff).toHaveBeenCalledWith(
      expect.anything(),
      CLASS_SLUG,
      expect.objectContaining({ resourceType: 'GRADES' })
    );
  });
});

describe('grades action — body validation', () => {
  it('clears the grade when an empty value is submitted', async () => {
    await route.action(actionArgs({ membership_id: OWN_MEMBERSHIP, letter_grade: '' }));

    expect(mocks.updateInClassroom).toHaveBeenCalledWith(OWN_MEMBERSHIP, 'class-1', {
      letter_grade: null,
    });
  });

  it('refuses a missing membership id rather than writing with it', async () => {
    const result = await route.action(actionArgs({ letter_grade: 'A' }));

    expect(result).toEqual({ error: 'Invalid request.' });
    expect(mocks.updateInClassroom).not.toHaveBeenCalled();
  });

  it('refuses a membership id that is not a string', async () => {
    const result = await route.action(
      actionArgs({ membership_id: { id: 'x' }, letter_grade: 'A' })
    );

    expect(result).toEqual({ error: 'Invalid request.' });
    expect(mocks.updateInClassroom).not.toHaveBeenCalled();
  });

  it('refuses a letter grade that is not a string', async () => {
    const result = await route.action(
      actionArgs({ membership_id: OWN_MEMBERSHIP, letter_grade: { $ne: null } })
    );

    expect(result).toEqual({ error: 'Invalid request.' });
    expect(mocks.updateInClassroom).not.toHaveBeenCalled();
  });
});
