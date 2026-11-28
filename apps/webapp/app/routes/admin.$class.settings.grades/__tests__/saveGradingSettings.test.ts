import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requestImpersonator: vi.fn(),
  requireClassroomAdmin: vi.fn(),
  updateSettings: vi.fn(),
}));

vi.mock('@classmoji/auth/request-impersonator', () => ({
  requestImpersonator: (...a: unknown[]) => mocks.requestImpersonator(...a),
}));

vi.mock('~/utils/routeAuth.server', () => ({
  requireClassroomAdmin: (...a: unknown[]) => mocks.requireClassroomAdmin(...a),
  assertClassroomMutationAllowed: vi.fn(),
}));

// `@classmoji/auth/server` imports these services from their own subpaths:
// each is the same member of the ClassmojiService fake below.
const { fromServicesFake } = await vi.hoisted(() => import('~/__tests__/support/servicesFake.ts'));
vi.mock('@classmoji/services/audit', () => fromServicesFake('audit'));
vi.mock('@classmoji/services/auth-email', () => fromServicesFake('authEmail'));
vi.mock('@classmoji/services/classroom', () => fromServicesFake('classroom'));
vi.mock('@classmoji/services/classroom-membership', () => fromServicesFake('classroomMembership'));
vi.mock('@classmoji/services/github-user-token', () => fromServicesFake('githubUserToken'));
vi.mock('@classmoji/services/subscription', () => fromServicesFake('subscription'));
vi.mock('@classmoji/services/gitlab-instance', () => fromServicesFake('gitlabInstance'));
vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    classroom: { updateSettings: (...a: unknown[]) => mocks.updateSettings(...a) },
  },
}));

const { action } = await import('../action');

const save = (body: unknown) =>
  action({
    params: { class: 'cs52' },
    request: new Request('http://localhost/admin/cs52/settings/grades?/saveGradingSettings', {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
    }),
  } as unknown as Parameters<typeof action>[0]);

/** The actor the route hands the settings service. */
const ACTOR = {
  userId: 'owner-1',
  role: 'OWNER',
  tool: 'web:settings.grades.grading',
  impersonatedBy: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requestImpersonator.mockResolvedValue(null);
  mocks.requireClassroomAdmin.mockResolvedValue({
    userId: 'owner-1',
    classroom: { id: 'class-1', status: 'ACTIVE' },
    membership: { role: 'OWNER' },
  });
  mocks.updateSettings.mockResolvedValue({});
});

describe('saveGradingSettings', () => {
  it('stores the late penalty and the estimate switch', async () => {
    await save({ late_penalty_points_per_hour: 2, show_grades_to_students: true });

    expect(mocks.updateSettings).toHaveBeenCalledWith(
      'class-1',
      {
        late_penalty_points_per_hour: 2,
        show_grades_to_students: true,
      },
      ACTOR
    );
  });

  it('stores the switch as a real boolean', async () => {
    await save({ late_penalty_points_per_hour: 0, show_grades_to_students: 'true' });

    expect(mocks.updateSettings).toHaveBeenCalledWith(
      'class-1',
      {
        late_penalty_points_per_hour: 0,
        show_grades_to_students: false,
      },
      ACTOR
    );
  });

  it('keeps the stored late penalty when the box is cleared', async () => {
    await save({ late_penalty_points_per_hour: null, show_grades_to_students: true });

    expect(mocks.updateSettings).toHaveBeenCalledWith(
      'class-1',
      {
        show_grades_to_students: true,
      },
      ACTOR
    );
  });

  it('writes no other settings field', async () => {
    await save({ late_penalty_points_per_hour: 1, syllabus_bot_enabled: true });

    expect(mocks.updateSettings).toHaveBeenCalledWith(
      'class-1',
      {
        late_penalty_points_per_hour: 1,
      },
      ACTOR
    );
  });
});
