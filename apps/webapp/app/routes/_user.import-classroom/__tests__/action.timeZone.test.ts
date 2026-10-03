/**
 * Import seeds the importer's browser zone onto a classroom ONLY when it has
 * none. A re-import returns the EXISTING classroom, whose owner may already have
 * chosen a zone; that choice must survive.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  importGithubClassrooms: vi.fn(),
  getTimeZone: vi.fn(),
  updateSettings: vi.fn(),
}));

vi.mock('~/utils/helpers', () => ({
  checkAuth:
    (fn: (args: unknown) => unknown) =>
    ({ request }: { request: Request }) =>
      fn({ request, user: { id: 'owner-1' } }),
}));

vi.mock('~/constants', () => ({ ActionTypes: { IMPORT_CLASSROOM: 'import' } }));

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    githubClassroomImport: {
      importGithubClassrooms: (...a: unknown[]) => mocks.importGithubClassrooms(...a),
    },
    classroom: {
      getTimeZone: (...a: unknown[]) => mocks.getTimeZone(...a),
      updateSettings: (...a: unknown[]) => mocks.updateSettings(...a),
    },
    emojiMapping: { ensureDefaultScale: vi.fn().mockResolvedValue(undefined) },
    audit: { create: vi.fn().mockResolvedValue(undefined) },
  },
}));

const { action } = await import('../action.ts');

const result = (classroomId: string) => ({
  classroomId,
  classroomSlug: classroomId,
  classroomName: classroomId,
  studentsEnrolled: 0,
});

const importWith = (timezone: unknown) =>
  (action as unknown as (args: { request: Request }) => Promise<unknown>)({
    request: new Request('http://localhost/import-classroom', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ classrooms: [{}], timezone }),
    }),
  });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.importGithubClassrooms.mockResolvedValue({
    results: [result('existing'), result('new')],
    errors: [],
  });
  // 'existing' is a re-import whose owner already chose Chicago.
  mocks.getTimeZone.mockImplementation(async (id: string) =>
    id === 'existing' ? 'America/Chicago' : null
  );
  mocks.updateSettings.mockResolvedValue({});
});

describe('import-classroom initial time zone', () => {
  it("keeps an existing classroom's zone and seeds the browser zone on a new one", async () => {
    await importWith('america/new_york');
    expect(mocks.updateSettings).toHaveBeenCalledTimes(1);
    expect(mocks.updateSettings).toHaveBeenCalledWith('new', { timezone: 'America/New_York' });
  });

  it('seeds nothing when the browser sent no zone, or an invalid one', async () => {
    await importWith(undefined);
    await importWith('Mars/Olympus');
    expect(mocks.updateSettings).not.toHaveBeenCalled();
  });
});
