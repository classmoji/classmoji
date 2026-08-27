/**
 * Unit tests for the Teaching Staff mutations.
 *
 * Two things are being pinned here.
 *
 * THE GATE. The route's loader reads at the teaching-team tier so an assistant
 * can see the team. These writes carry their OWN OWNER gate and must keep it:
 * React Router runs the matched leaf action first, so nothing about sitting
 * under /admin gates them, and the client-side confirmation on "add a co-owner"
 * is decoration — this gate is what actually stands behind it.
 *
 * THE MESSAGES. The route used to collapse every failure into one
 * "Failed to…" string, which hid the only useful part: each StaffServiceError
 * code is a different thing for the instructor to go and fix.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

class FakeStaffServiceError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'StaffServiceError';
    this.code = code;
  }
}

const mocks = vi.hoisted(() => ({
  requireClassroomAdmin: vi.fn(),
  requireClassroomTeachingTeam: vi.fn(),
  assertClassroomMutationAllowed: vi.fn(),
  findUsersByRole: vi.fn(),
  addStaff: vi.fn(),
  updateStaff: vi.fn(),
  removeStaff: vi.fn(),
  waitForRunCompletion: vi.fn(),
}));

vi.mock('~/utils/routeAuth.server', () => ({
  requireClassroomAdmin: (...a: unknown[]) => mocks.requireClassroomAdmin(...a),
  requireClassroomTeachingTeam: (...a: unknown[]) => mocks.requireClassroomTeachingTeam(...a),
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
  StaffServiceError: FakeStaffServiceError,
}));

vi.mock('~/utils/helpers', () => ({
  waitForRunCompletion: (...a: unknown[]) => mocks.waitForRunCompletion(...a),
}));

vi.mock('~/constants', () => ({
  ActionTypes: { SAVE_USER: 'save-user', REMOVE_USER: 'remove-user' },
}));

const { action } = await import('../action');

const CLASS_SLUG = 'cs52-26f';
const CLASSROOM = { id: 'class-1', slug: CLASS_SLUG, status: 'ACTIVE' };

/**
 * The fetcher posts JSON and names the branch in the query string
 * (`action: '?/createStaff'`), which is how remix-utils' namedAction routes it.
 */
const runRaw = (name: string, body: string, method = 'POST') =>
  action({
    params: { class: CLASS_SLUG },
    request: new Request(`http://localhost/admin/${CLASS_SLUG}/staff?/${name}`, {
      method,
      body,
      headers: { 'Content-Type': 'application/json' },
    }),
  } as unknown as Parameters<typeof action>[0]) as Promise<{
    error?: string;
    success?: string;
    action?: string;
  }>;

const run = (name: string, body: Record<string, unknown>, method = 'POST') =>
  runRaw(name, JSON.stringify(body), method);

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.requireClassroomAdmin.mockResolvedValue({
    userId: 'owner-1',
    classroom: CLASSROOM,
    membership: { id: 'm-1', role: 'OWNER' },
  });
  mocks.addStaff.mockResolvedValue({
    created: true,
    alreadyExists: false,
    userId: 'user-1',
    login: 'ada',
    name: 'Ada Lovelace',
    role: 'ASSISTANT',
    alreadyOrgMember: false,
  });
  mocks.removeStaff.mockResolvedValue({
    userId: 'user-1',
    login: 'ada',
    role: 'ASSISTANT',
    runId: 'run-1',
  });
});

// ─── The gate ───────────────────────────────────────────────────────────────

describe('staff action — authorization', () => {
  it('gates on OWNER itself rather than inheriting from the route', async () => {
    await run('createStaff', { login: 'ada', role: 'ASSISTANT' });

    expect(mocks.requireClassroomAdmin).toHaveBeenCalledWith(expect.any(Request), CLASS_SLUG, {
      resourceType: 'TEACHING_STAFF',
      action: 'manage_staff',
    });
    // The loader's wider gate must not be what admits a mutation.
    expect(mocks.requireClassroomTeachingTeam).not.toHaveBeenCalled();
  });

  it('refuses a non-owner before touching the service', async () => {
    mocks.requireClassroomAdmin.mockRejectedValue(new Response('Forbidden', { status: 403 }));

    await expect(run('createStaff', { login: 'ada', role: 'OWNER' })).rejects.toBeInstanceOf(
      Response
    );
    expect(mocks.addStaff).not.toHaveBeenCalled();
  });

  it('honours the classroom status guard', async () => {
    await run('createStaff', { login: 'ada', role: 'ASSISTANT' });

    expect(mocks.assertClassroomMutationAllowed).toHaveBeenCalledWith({
      status: 'ACTIVE',
      role: 'OWNER',
    });
  });
});

// ─── Adding at a role ───────────────────────────────────────────────────────

describe('staff action — createStaff', () => {
  it.each(['ASSISTANT', 'TEACHER', 'OWNER'] as const)('grants %s when asked for it', async role => {
    mocks.addStaff.mockResolvedValue({
      created: true,
      alreadyExists: false,
      userId: 'user-1',
      login: 'ada',
      name: 'Ada',
      role,
      alreadyOrgMember: false,
    });

    await run('createStaff', { login: 'ada', role, name: 'Ada', email: 'ada@school.test' });

    expect(mocks.addStaff).toHaveBeenCalledWith({
      classroomId: 'class-1',
      login: 'ada',
      role,
      name: 'Ada',
      email: 'ada@school.test',
    });
  });

  it('refuses a role the client made up, without calling the service', async () => {
    // The role is client input. The service asserts it too, but a request that
    // never had a valid role should not reach GitHub at all.
    const result = await run('createStaff', { login: 'ada', role: 'STUDENT' });

    expect(mocks.addStaff).not.toHaveBeenCalled();
    expect(result.error).toBe('Pick a role for this staff member.');
  });

  it('refuses a missing role', async () => {
    const result = await run('createStaff', { login: 'ada' });

    expect(mocks.addStaff).not.toHaveBeenCalled();
    expect(result.error).toBeTruthy();
  });

  it('names the role in the already-a-member message', async () => {
    mocks.addStaff.mockResolvedValue({
      created: false,
      alreadyExists: true,
      userId: 'user-1',
      login: 'ada',
      name: 'Ada',
      role: 'TEACHER',
      alreadyOrgMember: true,
    });

    const result = await run('createStaff', { login: 'ada', role: 'TEACHER' });

    expect(result.error).toBe('ada is already a teacher in this class.');
    expect(result.success).toBeUndefined();
  });

  it('names the role on success', async () => {
    mocks.addStaff.mockResolvedValue({
      created: true,
      alreadyExists: false,
      userId: 'user-1',
      login: 'ada',
      name: 'Ada',
      role: 'OWNER',
      alreadyOrgMember: false,
    });

    const result = await run('createStaff', { login: 'ada', role: 'OWNER' });

    expect(result.success).toBe('Added ada as a co-owner');
  });
});

// ─── Each failure gets its own sentence ─────────────────────────────────────

describe('staff action — service errors map to their own messages', () => {
  const cases: [string, string][] = [
    ['git_user_not_found', 'No GitHub user with that username. Check the spelling and try again.'],
    ['staff_not_found', 'That person no longer holds that role in this class — reload the page.'],
    [
      'no_org_configured',
      'This classroom has no linked GitHub organization, so staff cannot be managed yet.',
    ],
    [
      'login_conflict',
      'That username belongs to a different account than the one already on file for it — contact support.',
    ],
  ];

  it.each(cases)('createStaff maps %s', async (code, message) => {
    mocks.addStaff.mockRejectedValue(new FakeStaffServiceError(code, 'raw service text'));

    const result = await run('createStaff', { login: 'ada', role: 'ASSISTANT' });

    expect(result.error).toBe(message);
  });

  it('removeStaff explains that the last owner cannot be removed', async () => {
    // The service pre-checks the owner count before triggering the removal
    // task, so this arrives here rather than failing invisibly in the worker.
    mocks.removeStaff.mockRejectedValue(
      new FakeStaffServiceError('last_owner', '[staff] ada is the only owner')
    );

    const result = await run('removeStaff', { login: 'ada', role: 'OWNER' }, 'DELETE');

    expect(result.error).toBe(
      'This is the only owner of the classroom. Add another owner before removing this one.'
    );
  });

  it('updateStaff explains that the grader flag does not apply to owners', async () => {
    mocks.updateStaff.mockRejectedValue(
      new FakeStaffServiceError('grader_flag_invalid', '[staff] is_grader applies to...')
    );

    const result = await run('updateStaff', { login: 'ada', role: 'OWNER', isGrader: true }, 'PUT');

    expect(result.error).toBe(
      'The grader flag applies to assistants and teachers only — owners do not join the grading pool.'
    );
  });

  it('keeps the generic message for anything that is not a service error', async () => {
    // A crash or an outage is not a caller mistake, so it must not be dressed
    // up as one.
    mocks.addStaff.mockRejectedValue(new TypeError('socket hang up'));

    const result = await run('createStaff', { login: 'ada', role: 'ASSISTANT' });

    expect(result.error).toBe('Failed to add staff member. Please try again.');
  });
});

// ─── The role travels with the login ────────────────────────────────────────

describe('staff action — role-scoped update and removal', () => {
  it('updates the grader flag on the row role, not a guessed one', async () => {
    await run('updateStaff', { login: 'ada', role: 'TEACHER', isGrader: true }, 'PUT');

    expect(mocks.updateStaff).toHaveBeenCalledWith({
      classroomId: 'class-1',
      login: 'ada',
      role: 'TEACHER',
      isGrader: true,
    });
  });

  it('removes at the row role, and sends only the login and the role', async () => {
    // The client used to post the whole row; the service resolves the target
    // from the DB, so the row is not an input.
    await run('removeStaff', { login: 'ada', role: 'OWNER' }, 'DELETE');

    expect(mocks.removeStaff).toHaveBeenCalledWith({
      classroomId: 'class-1',
      login: 'ada',
      role: 'OWNER',
    });
    expect(mocks.waitForRunCompletion).toHaveBeenCalledWith('run-1');
  });

  it('refuses a made-up role on removal', async () => {
    const result = await run('removeStaff', { login: 'ada', role: 'STUDENT' }, 'DELETE');

    expect(mocks.removeStaff).not.toHaveBeenCalled();
    expect(result.error).toBe('That is not a teaching-staff role.');
  });
});

// ─── The rest of the body gets the same treatment as the role ───────────────

describe('staff action — the sibling body fields', () => {
  /**
   * `role` was validated and its siblings were not, so a login or a grader flag
   * of the wrong type reached the service and threw — a 500 through the route
   * error boundary rather than the inline callout the role branch produces. The
   * whole body is client input; all of it is checked the same way.
   */

  it('refuses a login that is not a string, without calling the service', async () => {
    const result = await run('createStaff', { login: { toString: 'nope' }, role: 'ASSISTANT' });

    expect(mocks.addStaff).not.toHaveBeenCalled();
    expect(result.error).toBe('Enter the GitHub username of the person to add.');
  });

  it('refuses a blank login', async () => {
    const result = await run('createStaff', { login: '   ', role: 'ASSISTANT' });

    expect(mocks.addStaff).not.toHaveBeenCalled();
    expect(result.error).toBeTruthy();
  });

  it('refuses a login with whitespace in it — that is never one account', async () => {
    const result = await run('createStaff', { login: 'ada lovelace', role: 'ASSISTANT' });

    expect(mocks.addStaff).not.toHaveBeenCalled();
    expect(result.error).toBeTruthy();
  });

  it('trims the login and drops a leading @, as the form does', async () => {
    await run('createStaff', { login: ' @ada ', role: 'ASSISTANT' });

    expect(mocks.addStaff).toHaveBeenCalledWith(expect.objectContaining({ login: 'ada' }));
  });

  it('treats an absent, blank or non-string override as no override', async () => {
    // The service falls back to the git profile on a null, which is the whole
    // point of the fields being optional. An empty string is not nullish, so it
    // would have been written to the user record as an empty name.
    await run('createStaff', { login: 'ada', role: 'ASSISTANT', name: '  ', email: 42 });

    expect(mocks.addStaff).toHaveBeenCalledWith(
      expect.objectContaining({ name: null, email: null })
    );
  });

  it('keeps a real override', async () => {
    await run('createStaff', {
      login: 'ada',
      role: 'ASSISTANT',
      name: ' Ada Lovelace ',
      email: 'ada@school.test',
    });

    expect(mocks.addStaff).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Ada Lovelace', email: 'ada@school.test' })
    );
  });

  it('refuses a grader flag that is not a boolean', async () => {
    // It lands in a Prisma boolean column, so anything else fails in the driver.
    const result = await run(
      'updateStaff',
      { login: 'ada', role: 'TEACHER', isGrader: 'yes' },
      'PUT'
    );

    expect(mocks.updateStaff).not.toHaveBeenCalled();
    expect(result.error).toBe('The grader flag has to be yes or no.');
  });

  it('refuses a missing grader flag rather than writing a guess', async () => {
    const result = await run('updateStaff', { login: 'ada', role: 'TEACHER' }, 'PUT');

    expect(mocks.updateStaff).not.toHaveBeenCalled();
    expect(result.error).toBeTruthy();
  });

  it('refuses a bad login on update and on removal too', async () => {
    const updated = await run('updateStaff', { role: 'TEACHER', isGrader: true }, 'PUT');
    const removed = await run('removeStaff', { role: 'TEACHER' }, 'DELETE');

    expect(mocks.updateStaff).not.toHaveBeenCalled();
    expect(mocks.removeStaff).not.toHaveBeenCalled();
    expect(updated.error).toBe('Could not tell which staff member that was — reload the page.');
    expect(removed.error).toBe('Could not tell which staff member that was — reload the page.');
  });
});

describe('staff action — an unreadable body', () => {
  it('answers a callout instead of throwing into the error boundary', async () => {
    const result = await runRaw('createStaff', 'not json at all');

    expect(mocks.addStaff).not.toHaveBeenCalled();
    expect(result.error).toBe('Could not read that request. Reload the page and try again.');
  });

  it('treats valid JSON that is not an object the same way', async () => {
    // `JSON.parse('5')` succeeds; reading `.role` off it does not throw, it just
    // yields undefined, and the branch would then have blamed the role.
    const result = await runRaw('createStaff', '5');

    expect(mocks.addStaff).not.toHaveBeenCalled();
    expect(result.error).toBe('Could not read that request. Reload the page and try again.');
  });

  it('names the branch the client is waiting on, so its callout resolves', async () => {
    // notify() opens a persistent progress callout keyed by ActionTypes and the
    // response closes it by the same key. A mismatch leaves it spinning.
    const created = await runRaw('createStaff', '{');
    const removed = await runRaw('removeStaff', '{', 'DELETE');

    expect(created.action).toBe('save-user');
    expect(removed.action).toBe('remove-user');
  });
});
