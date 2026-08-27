/**
 * The import task's run-time re-check of source access.
 *
 * This is the third of three enforcement points (picker query, create-classroom
 * action, then here) and the only one that runs after the request is over: the
 * copy happens later, in another process, from data on a row, so the membership
 * it trusted at request time may since have been revoked.
 *
 * Two things are pinned. That it admits OWNER *and* TEACHER — the widening this
 * file exists to protect, and which lives on the far side of a package boundary
 * from the webapp's `SOURCE_ROLES`, so nothing but a test keeps the two lists
 * agreeing. And that it refuses when no row comes back, rather than falling
 * through to copy anyway.
 *
 * `@trigger.dev/sdk` and the service/db modules are mocked — no network, no DB.
 * Prisma is a hand-written stub so the `where` clause itself can be asserted;
 * the point is what is ASKED of the database, which a fixture-returning mock
 * would hide.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@trigger.dev/sdk', () => ({
  task: (config: unknown) => config,
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

vi.mock('@classmoji/database', () => ({ default: () => ({}) }));
vi.mock('@classmoji/services', () => ({ ClassmojiService: {} }));
vi.mock('@classmoji/services/import-progress', async importOriginal => importOriginal());

const { assertSourceAccess } = await import('../classroomImport.ts');

const findFirst = vi.fn();
const prisma = { classroomMembership: { findFirst } } as never;

const job = {
  id: 'job-1',
  source_classroom_id: 'source-classroom',
  requested_by: 'user-1',
} as never;

beforeEach(() => {
  findFirst.mockReset();
});

describe('assertSourceAccess', () => {
  it('passes when a membership row comes back', async () => {
    findFirst.mockResolvedValue({ id: 'membership-1' });
    await expect(assertSourceAccess(prisma, job)).resolves.toBeUndefined();
  });

  it('refuses when the requester no longer has one', async () => {
    findFirst.mockResolvedValue(null);
    await expect(assertSourceAccess(prisma, job)).rejects.toThrow(
      'Requester no longer has access to the source classroom — import refused'
    );
  });

  // The load-bearing assertion. A teacher must still be admitted here, or the
  // copy dies at run time for exactly the people the widening was for — and the
  // failure would surface as a failed background job, not a refused request.
  it('asks for OWNER or TEACHER, scoped to this job’s source and requester', async () => {
    findFirst.mockResolvedValue({ id: 'membership-1' });
    await assertSourceAccess(prisma, job);

    expect(findFirst).toHaveBeenCalledTimes(1);
    const { where } = findFirst.mock.calls[0][0];
    expect(where.classroom_id).toBe('source-classroom');
    expect(where.user_id).toBe('user-1');
    expect([...where.role.in].sort()).toEqual(['OWNER', 'TEACHER']);
  });

  // Guards the obvious regression in the other direction: quietly re-narrowing
  // to owners, or widening to the whole teaching team.
  it('does not admit assistants or students', async () => {
    findFirst.mockResolvedValue({ id: 'membership-1' });
    await assertSourceAccess(prisma, job);

    const { where } = findFirst.mock.calls[0][0];
    expect(where.role.in).not.toContain('ASSISTANT');
    expect(where.role.in).not.toContain('STUDENT');
  });
});
