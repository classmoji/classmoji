/**
 * Owner actions that take a row or user id from the request body act only on
 * rows of the URL's classroom (the one the gate authorized):
 *
 *   - settings.team ?/deleteTag deletes a tag only where it belongs to this
 *     classroom, and audits the delete;
 *   - tokens.new ?/assignTokens grants tokens only to this classroom's
 *     students, naming each from the classroom's own records.
 *
 * The service-side rules (the classroom-scoped delete, the student lookup) run
 * against a real database in packages/services
 * (classmoji/__tests__/classroomScopedIds.integration.test.ts).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireClassroomAdmin: vi.fn(),
  assertClassroomMutationAllowed: vi.fn(),
  deleteInClassroom: vi.fn(),
  auditCreate: vi.fn(),
  studentsInClassroomByIds: vi.fn(),
  batchTrigger: vi.fn(),
}));

vi.mock('~/utils/routeAuth.server', () => ({
  requireClassroomAdmin: (...a: unknown[]) => mocks.requireClassroomAdmin(...a),
  assertClassroomMutationAllowed: (...a: unknown[]) => mocks.assertClassroomMutationAllowed(...a),
}));

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    organizationTag: {
      deleteInClassroom: (...a: unknown[]) => mocks.deleteInClassroom(...a),
      findByClassroomId: vi.fn(),
    },
    audit: {
      create: (...a: unknown[]) => mocks.auditCreate(...a),
      record: (row: unknown) =>
        import('../../__tests__/support/auditRecord.ts').then(m =>
          m.recordThrough(r => mocks.auditCreate(r))(row)
        ),
    },
    classroomMembership: {
      studentsInClassroomByIds: (...a: unknown[]) => mocks.studentsInClassroomByIds(...a),
      findUsersByRole: vi.fn(),
    },
  },
}));

// The audit funnel reads the session for who is viewing as the user: none here.
vi.mock('@classmoji/auth/server', () => ({
  getAuthSession: async () => ({ userId: 'owner-1', session: { session: {} } }),
  resolveHighestMembership: vi.fn(),
  assertClassroomAccess: vi.fn(),
  assertClassroomMutationAllowed: vi.fn(),
  formMutationBlocked: vi.fn(),
  requireStudentAccess: vi.fn(),
  assertProTier: vi.fn(),
}));

vi.mock('@classmoji/tasks', () => ({
  default: {
    assignTokensToStudentTask: { batchTrigger: (...a: unknown[]) => mocks.batchTrigger(...a) },
  },
}));

vi.mock('@trigger.dev/sdk', () => ({
  auth: { createPublicToken: async () => 'public-token' },
}));

vi.mock('~/hooks', () => ({
  useGlobalFetcher: () => ({ fetcher: null, notify: vi.fn() }),
  useRouteDrawer: () => ({ open: true, close: vi.fn() }),
}));

const teamSettings = await import('../admin.$class.settings.team/route.tsx');
const tokensNew = await import('../admin.$class.tokens.new/route.tsx');

const CLASS_X = { id: 'class-x', slug: 'class-x', status: 'ACTIVE' };

const post = <A extends (args: never) => unknown>(
  action: A,
  path: string,
  intent: string,
  body: Record<string, unknown>
) =>
  action({
    params: { class: CLASS_X.slug },
    request: new Request(`http://localhost/admin/${CLASS_X.slug}/${path}?/${intent}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  } as never) as Promise<Record<string, unknown>>;

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.requireClassroomAdmin.mockResolvedValue({
    userId: 'owner-x',
    classroom: CLASS_X,
    membership: { id: 'm-1', role: 'OWNER' },
  });
  mocks.auditCreate.mockResolvedValue(undefined);
  mocks.batchTrigger.mockResolvedValue(undefined);
});

describe('settings.team — deleteTag', () => {
  it('deletes a tag of this classroom and audits it', async () => {
    mocks.deleteInClassroom.mockResolvedValue({ id: 'tag-x', name: 'Section A' });

    const result = await post(teamSettings.action, 'settings/team', 'deleteTag', {
      tagId: 'tag-x',
    });

    expect(mocks.deleteInClassroom).toHaveBeenCalledWith(CLASS_X.id, 'tag-x');
    expect(result).toEqual({ deleted: 'tag-x' });
    expect(mocks.auditCreate).toHaveBeenCalledTimes(1);
    expect(mocks.auditCreate.mock.calls[0][0]).toMatchObject({
      user_id: 'owner-x',
      classroom_id: CLASS_X.id,
      role: 'OWNER',
      action: 'DELETE',
      resource_id: 'tag-x',
      data: { tool: 'web:settings.team.delete_tag', name: 'Section A' },
    });
  });

  it('reports a delete that happened even when its audit row cannot be written', async () => {
    mocks.deleteInClassroom.mockResolvedValue({ id: 'tag-x', name: 'Section A' });
    mocks.auditCreate.mockRejectedValue(new Error('audit down'));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await post(teamSettings.action, 'settings/team', 'deleteTag', {
      tagId: 'tag-x',
    });

    expect(result).toEqual({ deleted: 'tag-x' });
  });

  it("answers another classroom's tag id as not found and audits nothing", async () => {
    // The service deletes only where the tag's classroom matches.
    mocks.deleteInClassroom.mockResolvedValue(null);

    const result = await post(teamSettings.action, 'settings/team', 'deleteTag', {
      tagId: 'tag-of-class-y',
    });

    expect(mocks.deleteInClassroom).toHaveBeenCalledWith(CLASS_X.id, 'tag-of-class-y');
    expect(result).toMatchObject({ error: expect.any(String) });
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });
});

describe('tokens.new — assignTokens', () => {
  it("grants only to this classroom's students, named from the classroom's records", async () => {
    mocks.studentsInClassroomByIds.mockResolvedValue([
      { id: 'student-x', name: 'Ada', login: 'ada' },
    ]);

    const result = await post(tokensNew.action, 'tokens/new', 'assignTokens', {
      num_tokens: '3',
      description: 'bonus',
      students: [
        JSON.stringify({ id: 'student-x', name: 'Ada (as sent)', email: 'a@example.test' }),
        JSON.stringify({ id: 'student-of-class-y', name: 'Grace' }),
        { id: 'user-in-no-class' },
        'not json',
      ],
    });

    expect(mocks.studentsInClassroomByIds).toHaveBeenCalledWith(CLASS_X.id, [
      'student-x',
      'student-of-class-y',
      'user-in-no-class',
      null,
    ]);
    expect(mocks.batchTrigger).toHaveBeenCalledTimes(1);
    const payloads = mocks.batchTrigger.mock.calls[0][0] as { payload: Record<string, unknown> }[];
    expect(payloads.map(p => p.payload)).toEqual([
      {
        student: { id: 'student-x', name: 'Ada', login: 'ada' },
        classroomId: CLASS_X.id,
        amount: 3,
        description: 'bonus',
      },
    ]);
    expect(result).toMatchObject({ triggerSession: { numStudentsToAssignTokens: 1 } });
  });

  it('triggers nothing when no selected id is a student of this classroom', async () => {
    mocks.studentsInClassroomByIds.mockResolvedValue([]);

    await expect(
      post(tokensNew.action, 'tokens/new', 'assignTokens', {
        num_tokens: '3',
        students: [JSON.stringify({ id: 'student-of-class-y' })],
      })
    ).rejects.toThrow();
    expect(mocks.batchTrigger).not.toHaveBeenCalled();
  });
});
