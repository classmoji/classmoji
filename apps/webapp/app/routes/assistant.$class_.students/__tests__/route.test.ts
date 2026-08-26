/**
 * Unit tests for the roster under the ASSISTANT prefix.
 *
 * The admin roster loader already reads at the teaching-team tier, but until
 * this route existed an assistant had no way to reach it: the /admin layout
 * gates its outlet on OWNER, so the widened loader was unreachable in the
 * product. This route is the reachable half, and it must widen the READ only:
 *
 *   READ  — the same loader, so the OWNER-only field split travels with it.
 *   WRITE — absent. The route exports no `action`, so there is no POST target
 *           under /assistant at all. That is what these tests pin hardest: a
 *           future edit that re-exports the action would fail here.
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

vi.mock('~/constants', () => ({ ActionTypes: { REMOVE_USER: 'remove-user' } }));

// The loader is what is under test; the view layer only needs to be importable.
vi.mock('../../admin.$class.students/StudentsTable', () => ({ default: () => null }));
vi.mock('~/components', () => ({ SearchInput: () => null }));
vi.mock('antd', () => ({ Button: () => null }));
vi.mock('@ant-design/icons', () => ({ PlusCircleOutlined: () => null }));

const assistantRoute = await import('../route.tsx');
const adminRoute = await import('../../admin.$class.students/route.tsx');

const CLASS_SLUG = 'cs52-26f';
const CLASSROOM = { id: 'class-1', slug: CLASS_SLUG, status: 'ACTIVE' };

const STUDENT_ROW = {
  id: 'student-1',
  name: 'Ada Lovelace',
  login: 'ada',
  image: 'https://example.test/ada.png',
  email: 'ada@school.test',
  provider_email: 'ada@github.test',
  school_id: 'F00123',
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

const loaderArgs = () =>
  ({
    params: { class: CLASS_SLUG },
    request: new Request(`http://localhost/assistant/${CLASS_SLUG}/students`),
  }) as unknown as Parameters<typeof assistantRoute.loader>[0];

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.findUsersByRole.mockResolvedValue([STUDENT_ROW]);
  mocks.findInvitesByClassroomId.mockResolvedValue([INVITE_ROW]);
  mocks.requireClassroomTeachingTeam.mockResolvedValue({
    userId: 'assistant-1',
    classroom: CLASSROOM,
    membership: { id: 'm-1', role: 'ASSISTANT' },
  });
});

// ─── The route is the admin route, reached under a different prefix ──────────

describe('assistant students route — what it re-exports', () => {
  it('serves the admin loader itself, so the field split cannot drift', () => {
    expect(assistantRoute.loader).toBe(adminRoute.loader);
  });

  it('exports the admin component, not a copy', () => {
    expect(assistantRoute.default).toBe(adminRoute.default);
  });
});

// ─── The OWNER-only mutations are not reachable here ─────────────────────────

describe('assistant students route — mutations are unreachable', () => {
  it('exports no action, so the prefix has no POST target at all', () => {
    expect('action' in assistantRoute).toBe(false);
    expect((assistantRoute as Record<string, unknown>).action).toBeUndefined();
  });

  it('leaves the OWNER-only action behind on the admin route', () => {
    // The mutations still exist — just not under this prefix.
    expect(typeof adminRoute.action).toBe('function');
  });
});

// ─── Reading the roster as an ASSISTANT ──────────────────────────────────────

describe('assistant students route — loader payload', () => {
  it('admits an ASSISTANT through the teaching-team gate', async () => {
    const data = await assistantRoute.loader(loaderArgs());

    expect(mocks.requireClassroomTeachingTeam).toHaveBeenCalledWith(
      expect.any(Request),
      CLASS_SLUG,
      { resourceType: 'STUDENT_ROSTER', action: 'view_roster' }
    );
    expect(mocks.requireClassroomAdmin).not.toHaveBeenCalled();
    expect(data.students).toHaveLength(1);
    expect(data.students[0]).toMatchObject({ id: 'student-1', login: 'ada' });
  });

  it('withholds every owner-only field from the payload', async () => {
    const data = await assistantRoute.loader(loaderArgs());
    const student = data.students[0] as unknown as Record<string, unknown>;

    // The keys are ABSENT, not null: nothing for the client to un-hide.
    for (const field of OWNER_ONLY_FIELDS) {
      expect(field in student).toBe(false);
    }
    expect('school_email' in (data.invitations[0] as Record<string, unknown>)).toBe(false);

    const serialized = JSON.stringify(data);
    expect(serialized).not.toContain('ada@school.test');
    expect(serialized).not.toContain('ada@github.test');
    expect(serialized).not.toContain('F00123');
    expect(serialized).not.toContain('strong on recursion');
    expect(serialized).not.toContain('grace@school.test');
  });

  it('reports isOwner false, which is what suppresses the owner-only UI', async () => {
    // The add button, the contact columns and the whole actions cell hang off
    // this one flag — see StudentsTable.
    expect((await assistantRoute.loader(loaderArgs())).isOwner).toBe(false);
  });
});
