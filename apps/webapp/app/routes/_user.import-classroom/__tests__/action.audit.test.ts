/**
 * The import's audit row says what happened to each classroom: CREATE for one
 * the import made, UPDATE for a re-import onto one that was already there,
 * keyed on the classroom's id either way.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  importGithubClassrooms: vi.fn(),
  addClassroomAuditLog: vi.fn(),
}));

vi.mock('~/utils/helpers', () => ({
  checkAuth:
    (fn: (args: unknown) => unknown) =>
    ({ request }: { request: Request }) =>
      fn({ request, user: { id: 'owner-1' } }),
  addClassroomAuditLog: (...a: unknown[]) => mocks.addClassroomAuditLog(...a),
}));

vi.mock('~/constants', () => ({ ActionTypes: { IMPORT_CLASSROOM: 'import' } }));

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    githubClassroomImport: {
      importGithubClassrooms: (...a: unknown[]) => mocks.importGithubClassrooms(...a),
    },
    classroom: { getTimeZone: vi.fn(), updateSettings: vi.fn() },
    emojiMapping: { ensureDefaultScale: vi.fn().mockResolvedValue(undefined) },
  },
}));

const { action } = await import('../action.ts');

const result = (classroomId: string, reimported: boolean) => ({
  classroomId,
  classroomSlug: `${classroomId}-slug`,
  reimported,
  classroomName: classroomId,
  studentsEnrolled: 0,
});

const runImport = () =>
  (action as unknown as (args: { request: Request }) => Promise<unknown>)({
    request: new Request('http://localhost/import-classroom', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ classrooms: [{}, {}] }),
    }),
  });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.importGithubClassrooms.mockResolvedValue({
    results: [result('class-new', false), result('class-again', true)],
    errors: [],
  });
});

describe('import-classroom audit rows', () => {
  it('writes CREATE for a new classroom and UPDATE for a re-import, by classroom id', async () => {
    await runImport();

    expect(mocks.addClassroomAuditLog.mock.calls.map(([row]) => row)).toEqual([
      expect.objectContaining({
        classroomId: 'class-new',
        action: 'CREATE',
        resourceType: 'GITHUB_CLASSROOM_IMPORT',
        resourceId: 'class-new',
      }),
      expect.objectContaining({
        classroomId: 'class-again',
        action: 'UPDATE',
        resourceType: 'GITHUB_CLASSROOM_IMPORT',
        resourceId: 'class-again',
      }),
    ]);
  });
});
