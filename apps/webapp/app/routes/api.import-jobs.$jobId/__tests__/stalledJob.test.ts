/**
 * A classroom import whose run died without recording FAILED (a crash, a killed
 * process) used to stay RUNNING forever: the banner polled it and the retry
 * endpoint refused it. Two quiet hours now make it read as FAILED and retryable,
 * and the retry redoes the phases that were mid-run.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  findUniqueOrThrow: vi.fn(),
  updateMany: vi.fn(),
  update: vi.fn(),
  trigger: vi.fn(),
}));

vi.mock('@classmoji/database', () => ({
  default: () => ({
    importJob: {
      findUnique: (...a: unknown[]) => mocks.findUnique(...a),
      findUniqueOrThrow: (...a: unknown[]) => mocks.findUniqueOrThrow(...a),
      updateMany: (...a: unknown[]) => mocks.updateMany(...a),
      update: (...a: unknown[]) => mocks.update(...a),
    },
  }),
}));
vi.mock('@classmoji/tasks', () => ({
  default: { classroomImportTask: { trigger: (...a: unknown[]) => mocks.trigger(...a) } },
}));
vi.mock('~/utils/routeAuth.server', () => ({ assertClassroomAccess: vi.fn() }));

const { action, loader, isStalled, STALLED_AFTER_MS } = await import('../route');

const HOUR = 60 * 60 * 1000;
const job = (status: string, quietFor: number) => ({
  id: 'job-1',
  classroom_id: 'class-1',
  status,
  phase: 'content',
  progress: {
    phases: {
      config: { status: 'done' },
      pages: { status: 'running', done: 3, total: 10 },
      modules: { status: 'pending' },
    },
  },
  warnings: [],
  error: null,
  updated_at: new Date(Date.now() - quietFor),
});

const args = (method: string) =>
  ({
    params: { jobId: 'job-1' },
    request: new Request('http://test/api/import-jobs/job-1', { method }),
  }) as never;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.updateMany.mockResolvedValue({ count: 1 });
});

describe('isStalled', () => {
  it('only counts a live status that has been quiet past the limit', () => {
    expect(isStalled(job('RUNNING', STALLED_AFTER_MS + 1000))).toBe(true);
    expect(isStalled(job('PENDING', STALLED_AFTER_MS + 1000))).toBe(true);
    expect(isStalled(job('RUNNING', HOUR))).toBe(false);
    expect(isStalled(job('FAILED', 10 * HOUR))).toBe(false);
    expect(isStalled(job('COMPLETED', 10 * HOUR))).toBe(false);
  });
});

describe('a stalled import', () => {
  it('reads as FAILED so the banner offers Retry', async () => {
    mocks.findUnique.mockResolvedValue(job('RUNNING', 3 * HOUR));
    const body = await (loader(args('GET')) as Promise<Response>).then(r => r.json());
    expect(body.status).toBe('FAILED');
    expect(body.error).toMatch(/stopped responding/);
  });

  it('can be retried, claimed on the row it read, and redoes the phase that was running', async () => {
    const stalled = job('RUNNING', 3 * HOUR);
    mocks.findUnique.mockResolvedValue(stalled);
    mocks.findUniqueOrThrow.mockResolvedValue({ ...stalled, status: 'PENDING' });

    const res = (await action(args('POST'))) as Response;

    expect(res.status).toBe(200);
    const claim = mocks.updateMany.mock.calls[0][0];
    expect(claim.where).toEqual({
      id: 'job-1',
      status: 'RUNNING',
      updated_at: stalled.updated_at,
    });
    expect(claim.data.progress.phases.pages.status).toBe('pending');
    expect(claim.data.progress.phases.config.status).toBe('done');
    expect(mocks.trigger).toHaveBeenCalledWith({ importJobId: 'job-1' });
  });

  it('still refuses a job that is running and recently active', async () => {
    mocks.findUnique.mockResolvedValue(job('RUNNING', HOUR));
    const res = (await action(args('POST'))) as Response;
    expect(res.status).toBe(409);
    expect(mocks.trigger).not.toHaveBeenCalled();
  });
});
