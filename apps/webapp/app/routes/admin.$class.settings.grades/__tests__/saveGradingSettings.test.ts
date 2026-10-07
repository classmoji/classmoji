import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireClassroomAdmin: vi.fn(),
  updateSettings: vi.fn(),
}));

vi.mock('~/utils/routeAuth.server', () => ({
  requireClassroomAdmin: (...a: unknown[]) => mocks.requireClassroomAdmin(...a),
  assertClassroomMutationAllowed: vi.fn(),
}));

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

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireClassroomAdmin.mockResolvedValue({
    classroom: { id: 'class-1', status: 'ACTIVE' },
    membership: { role: 'OWNER' },
  });
  mocks.updateSettings.mockResolvedValue({});
});

describe('saveGradingSettings', () => {
  it('stores the late penalty and the estimate switch', async () => {
    await save({ late_penalty_points_per_hour: 2, show_grades_to_students: true });

    expect(mocks.updateSettings).toHaveBeenCalledWith('class-1', {
      late_penalty_points_per_hour: 2,
      show_grades_to_students: true,
    });
  });

  it('stores the switch as a real boolean', async () => {
    await save({ late_penalty_points_per_hour: 0, show_grades_to_students: 'true' });

    expect(mocks.updateSettings).toHaveBeenCalledWith('class-1', {
      late_penalty_points_per_hour: 0,
      show_grades_to_students: false,
    });
  });

  it('keeps the stored late penalty when the box is cleared', async () => {
    await save({ late_penalty_points_per_hour: null, show_grades_to_students: true });

    expect(mocks.updateSettings).toHaveBeenCalledWith('class-1', {
      show_grades_to_students: true,
    });
  });

  it('writes no other settings field', async () => {
    await save({ late_penalty_points_per_hour: 1, syllabus_bot_enabled: true });

    expect(mocks.updateSettings).toHaveBeenCalledWith('class-1', {
      late_penalty_points_per_hour: 1,
    });
  });
});
