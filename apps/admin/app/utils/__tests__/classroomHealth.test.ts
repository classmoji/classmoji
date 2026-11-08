import { describe, it, expect, vi } from 'vitest';

vi.mock('~/utils/db.server', () => ({ prisma: {} }));
const { healthOf } = await import('../classroomHealth.server.ts');

const base = {
  id: 'c',
  provider: 'GITHUB',
  hasInstallation: true,
  githubClassroomImport: false,
  importFailed: false,
  checkpointErrors: 0,
  accepted: 20,
  pending: 0,
  staff: 2,
  lastActivity: null,
};

describe('healthOf', () => {
  it('is ok by default', () => {
    expect(healthOf(base).health).toBe('ok');
  });
  it('is critical when the Github App is missing, never for a Gitlab class', () => {
    expect(healthOf({ ...base, hasInstallation: false }).health).toBe('critical');
    expect(healthOf({ ...base, provider: 'GITLAB', hasInstallation: false }).health).toBe('ok');
  });
  it('does not flag a missing Github App on a class imported from Github Classroom', () => {
    expect(healthOf({ ...base, hasInstallation: false, githubClassroomImport: true }).health).toBe(
      'ok'
    );
    // Other problems still count for it.
    expect(
      healthOf({ ...base, hasInstallation: false, githubClassroomImport: true, importFailed: true })
        .reasons
    ).toEqual(['Import failed']);
  });
  it('warns on a pending backlog only past both thresholds', () => {
    expect(healthOf({ ...base, accepted: 20, pending: 5 }).health).toBe('ok'); // 20%
    expect(healthOf({ ...base, accepted: 10, pending: 5 }).health).toBe('warning'); // 33%
    expect(healthOf({ ...base, accepted: 2, pending: 4 }).health).toBe('ok'); // < 5
  });
});
