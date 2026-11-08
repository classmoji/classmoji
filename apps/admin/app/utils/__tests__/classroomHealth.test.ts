import { describe, it, expect, vi } from 'vitest';

vi.mock('~/utils/db.server', () => ({ prisma: {} }));
const { healthOf } = await import('../classroomHealth.server.ts');

const base = {
  id: 'c',
  provider: 'GITHUB',
  hasInstallation: true,
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
  it("is critical for the platform's problems: a failed import or checkpoint errors", () => {
    expect(healthOf({ ...base, importFailed: true })).toEqual({
      health: 'critical',
      reasons: ['Import failed'],
    });
    expect(healthOf({ ...base, checkpointErrors: 2 }).reasons).toEqual(['2 checkpoint error(s)']);
  });
  it("never flags the class's own choices: no Github App, students who haven't accepted", () => {
    expect(healthOf({ ...base, hasInstallation: false }).health).toBe('ok');
    expect(healthOf({ ...base, accepted: 2, pending: 18 }).health).toBe('ok');
  });
});
