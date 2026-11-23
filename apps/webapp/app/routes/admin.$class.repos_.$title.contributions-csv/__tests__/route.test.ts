/**
 * The team repo commits CSV: owner-gated, the repository looked up inside the
 * classroom the gate resolved (so classroom X's owner never gets classroom
 * Y's), team repositories only, and every download audited.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireClassroomAdmin: vi.fn(),
  addClassroomAuditLog: vi.fn(),
  findByClassroomAndTitle: vi.fn(),
  listCommits: vi.fn(),
  commitsToCsv: vi.fn(),
}));

vi.mock('~/utils/routeAuth.server', () => ({
  requireClassroomAdmin: (...a: unknown[]) => mocks.requireClassroomAdmin(...a),
}));
vi.mock('~/utils/helpers', () => ({
  addClassroomAuditLog: (...a: unknown[]) => mocks.addClassroomAuditLog(...a),
}));
vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    repository: {
      findByClassroomAndTitle: (...a: unknown[]) => mocks.findByClassroomAndTitle(...a),
    },
    repoContributions: {
      listCommits: (...a: unknown[]) => mocks.listCommits(...a),
      commitsToCsv: (...a: unknown[]) => mocks.commitsToCsv(...a),
    },
  },
}));

const { loader } = await import('../route');

const CLASSROOM_X = { id: 'class-x', slug: 'cse-x' };
const REPOS = [
  { id: 'repo-x', classroom_id: 'class-x', title: 'project1', slug: 'project1', type: 'GROUP' },
  { id: 'repo-y', classroom_id: 'class-y', title: 'project9', slug: 'project9', type: 'GROUP' },
  { id: 'repo-solo', classroom_id: 'class-x', title: 'hw1', slug: 'hw1', type: 'INDIVIDUAL' },
];

const call = (title: string) =>
  loader({
    request: new Request(`http://localhost/admin/cse-x/repos/${title}/contributions-csv`),
    params: { class: 'cse-x', title },
    context: {},
  } as never) as Promise<Response>;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireClassroomAdmin.mockResolvedValue({
    userId: 'owner-a',
    classroom: CLASSROOM_X,
    membership: { role: 'OWNER' },
  });
  mocks.findByClassroomAndTitle.mockImplementation(
    async (classroomId: string, title: string) =>
      REPOS.find(r => r.classroom_id === classroomId && r.title === title) ?? null
  );
  mocks.listCommits.mockResolvedValue({
    rows: [{ sha: 'a' }],
    repoCount: 3,
    notCalculated: 0,
    truncatedRepos: [],
    oldestCalculatedAt: null,
  });
  mocks.commitsToCsv.mockReturnValue('Team\r\nBest team');
});

describe('admin.$class.repos_.$title.contributions-csv', () => {
  it('serves the CSV for the repository inside the gated classroom, and audits it', async () => {
    const res = await call('project1');

    expect(mocks.requireClassroomAdmin).toHaveBeenCalledWith(
      expect.any(Request),
      'cse-x',
      expect.objectContaining({ resourceType: 'REPOSITORIES' })
    );
    expect(mocks.listCommits).toHaveBeenCalledWith({
      classroomId: 'class-x',
      repositoryId: 'repo-x',
    });
    expect(res.headers.get('Content-Type')).toBe('text/csv; charset=utf-8');
    expect(res.headers.get('Content-Disposition')).toMatch(
      /^attachment; filename="cse-x-project1-commits-\d{4}-\d{2}-\d{2}\.csv"$/
    );
    // Raw bytes: text() would strip the BOM while decoding.
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(new TextDecoder().decode(bytes)).toBe('Team\r\nBest team');
    expect(mocks.addClassroomAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        classroomId: 'class-x',
        userId: 'owner-a',
        action: 'VIEW',
        resourceId: 'repo-x',
        metadata: expect.objectContaining({
          tool: 'web:repos.contributions.export_csv',
          commits: 1,
        }),
      })
    );
  });

  it("answers 404 for classroom Y's repository and reads nothing", async () => {
    await expect(call('project9')).rejects.toMatchObject({ status: 404 });
    expect(mocks.listCommits).not.toHaveBeenCalled();
    expect(mocks.addClassroomAuditLog).not.toHaveBeenCalled();
  });

  it('refuses an individual repository', async () => {
    await expect(call('hw1')).rejects.toMatchObject({ status: 400 });
    expect(mocks.listCommits).not.toHaveBeenCalled();
  });

  it('stops at the gate', async () => {
    mocks.requireClassroomAdmin.mockRejectedValue(new Response('Forbidden', { status: 403 }));
    await expect(call('project1')).rejects.toMatchObject({ status: 403 });
    expect(mocks.findByClassroomAndTitle).not.toHaveBeenCalled();
  });
});
