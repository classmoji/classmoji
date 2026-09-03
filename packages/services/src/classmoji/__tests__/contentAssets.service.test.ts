import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The asset map is a CACHE of the content repo, so what matters is not that a
 * sync writes rows — it is that a sync converges: rows for paths that left the
 * repo have to go away, a theme change has to escalate past the incremental
 * path that cannot see it, and a truncated listing must not be mistaken for a
 * repo that shrank.
 *
 * Prisma and the git provider are both mocked. The transaction is modelled as
 * "run the ops, return their results in order", which is what the sync relies
 * on when it reads the delete count off the tail of the array.
 */

const contentAssetUpsert = vi.fn();
const contentAssetDeleteMany = vi.fn();
const contentAssetFindFirst = vi.fn();
const contentAssetFindUnique = vi.fn();
const classroomFindUnique = vi.fn();
const transaction = vi.fn();

vi.mock('@classmoji/database', () => ({
  default: () => ({
    classroom: { findUnique: classroomFindUnique },
    contentAsset: {
      upsert: contentAssetUpsert,
      deleteMany: contentAssetDeleteMany,
      findFirst: contentAssetFindFirst,
      findUnique: contentAssetFindUnique,
    },
    $transaction: transaction,
  }),
}));

const getTree = vi.fn();
const getGitProvider = vi.fn(() => ({ getTree }));
vi.mock('../../git/index.ts', () => ({
  getGitProvider: (...a: unknown[]) => getGitProvider(...(a as [])),
}));

const getMeta = vi.fn();
vi.mock('../../content/ContentService.ts', () => ({
  ContentService: { getMeta: (...a: unknown[]) => getMeta(...a) },
}));

const {
  syncContentAssets,
  ensureContentAssets,
  lookupContentAsset,
  lookupContentTree,
  lookupContentAssetBySha,
} = await import('../contentAssets.service.ts');

const CLASSROOM = {
  id: 'class-1',
  content_repo: 'content-cs101',
  git_organization: { id: 'org-1', provider: 'GITHUB', login: 'dartmouth-cs' },
};

/** The upsert/deleteMany mocks return tagged markers so ops stay identifiable. */
const setupTransaction = (deletedCount = 0) => {
  contentAssetUpsert.mockImplementation(args => ({ op: 'upsert', args }));
  contentAssetDeleteMany.mockImplementation(args => ({ op: 'deleteMany', args }));
  transaction.mockImplementation((ops: { op: string }[]) =>
    Promise.resolve(ops.map(op => (op.op === 'deleteMany' ? { count: deletedCount } : op)))
  );
};

describe('contentAssets.service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    classroomFindUnique.mockResolvedValue(CLASSROOM);
    setupTransaction();
  });

  describe('full sync', () => {
    it('upserts every entry and sweeps rows the run did not touch', async () => {
      getTree.mockResolvedValue({
        sha: 'tree-root',
        truncated: false,
        entries: [
          { path: 'images', sha: 'sha-dir', type: 'tree' },
          { path: 'images/a.png', sha: 'sha-a', type: 'blob', size: 120 },
          { path: 'images/b.png', sha: 'sha-b', type: 'blob', size: 240 },
        ],
      });
      setupTransaction(4);

      const result = await syncContentAssets('class-1');

      expect(result).toEqual({ mode: 'full', upserted: 3, deleted: 4, truncated: false });
      expect(getTree).toHaveBeenCalledWith('dartmouth-cs', 'content-cs101', 'main', true);
      expect(contentAssetUpsert).toHaveBeenCalledTimes(3);

      // Directories are rows too — theme folders are addressed by tree SHA, so
      // dropping them would make themes unresolvable.
      const upsertedPaths = contentAssetUpsert.mock.calls.map(([args]) => args.create.path);
      expect(upsertedPaths).toEqual(['images', 'images/a.png', 'images/b.png']);

      // The sweep is what deletes paths removed from the repo. Every row
      // written this run carries the same stamp, so `lt` matches only rows an
      // earlier run wrote and this one did not refresh.
      const [sweep] = contentAssetDeleteMany.mock.calls[0];
      expect(sweep.where.classroom_id).toBe('class-1');
      expect(sweep.where.synced_at.lt).toBeInstanceOf(Date);

      const stamps = contentAssetUpsert.mock.calls.map(([args]) => args.create.synced_at.getTime());
      expect(new Set(stamps).size).toBe(1);
      expect(stamps[0]).toBe(sweep.where.synced_at.lt.getTime());
    });

    it('does NOT sweep when GitHub truncated the tree', async () => {
      // The missing entries are not absent from the repo, so sweeping them
      // would delete rows for files that still exist. A map that is too large
      // costs a stale row; one that is too small costs a broken image.
      getTree.mockResolvedValue({
        sha: 'tree-root',
        truncated: true,
        entries: [{ path: 'images/a.png', sha: 'sha-a', type: 'blob', size: 1 }],
      });

      const result = await syncContentAssets('class-1');

      expect(result).toEqual({ mode: 'full', upserted: 1, deleted: 0, truncated: true });
      expect(contentAssetDeleteMany).not.toHaveBeenCalled();
    });

    it('defaults a missing size to 0 rather than writing undefined', async () => {
      getTree.mockResolvedValue({
        sha: 'r',
        truncated: false,
        entries: [{ path: 'themes', sha: 'sha-t', type: 'tree' }],
      });

      await syncContentAssets('class-1');

      expect(contentAssetUpsert.mock.calls[0][0].create.size).toBe(0);
    });
  });

  describe('incremental sync', () => {
    it('re-reads changed paths uncached, upserts them, and deletes removed ones', async () => {
      getMeta.mockImplementation(({ path }: { path: string }) =>
        Promise.resolve({ sha: `sha-${path}`, size: 10 })
      );
      setupTransaction(1);

      const result = await syncContentAssets('class-1', {
        changes: {
          added: ['images/new.png'],
          modified: ['images/a.png'],
          removed: ['images/x.png'],
        },
      });

      expect(result).toEqual({ mode: 'incremental', upserted: 2, deleted: 1, truncated: false });
      expect(getTree).not.toHaveBeenCalled();

      // skipCache is load-bearing: this runs off a push webhook, and
      // ContentService's meta cache is very likely still holding the PRE-push
      // SHA — the one value that must never be written here.
      expect(getMeta).toHaveBeenCalledTimes(2);
      for (const [args] of getMeta.mock.calls) {
        expect(args.skipCache).toBe(true);
        expect(args.repo).toBe('content-cs101');
      }

      const [del] = contentAssetDeleteMany.mock.calls[0];
      expect(del.where).toEqual({ classroom_id: 'class-1', path: { in: ['images/x.png'] } });
    });

    it('treats a path that no longer resolves as removed', async () => {
      // The ordinary race: a later push deleted what this one added. No row is
      // the safe answer — the renderer falls back, where a row at a vanished
      // SHA is a signed URL that 404s at the edge.
      getMeta.mockResolvedValue(null);

      const result = await syncContentAssets('class-1', {
        changes: { added: ['images/ghost.png'], modified: [], removed: [] },
      });

      expect(result.upserted).toBe(0);
      expect(contentAssetDeleteMany.mock.calls[0][0].where.path.in).toEqual(['images/ghost.png']);
    });

    it('uses one tree call instead of N reads past the threshold', async () => {
      const many = Array.from({ length: 31 }, (_, i) => `images/f${i}.png`);
      getTree.mockResolvedValue({
        sha: 'r',
        truncated: false,
        entries: [
          ...many.map(path => ({ path, sha: `sha-${path}`, type: 'blob', size: 1 })),
          // Not in the change set, so it must not be upserted by this run.
          { path: 'images/untouched.png', sha: 'sha-u', type: 'blob', size: 1 },
        ],
      });

      const result = await syncContentAssets('class-1', {
        changes: { added: many, modified: [], removed: [] },
      });

      expect(getMeta).not.toHaveBeenCalled();
      expect(getTree).toHaveBeenCalledTimes(1);
      expect(result.mode).toBe('incremental');
      expect(result.upserted).toBe(31);

      // Still incremental: the tree is only the source of SHAs here, so the
      // untouched path must not be rewritten and nothing must be swept.
      const upsertedPaths = contentAssetUpsert.mock.calls.map(([args]) => args.create.path);
      expect(upsertedPaths).not.toContain('images/untouched.png');
      expect(contentAssetDeleteMany.mock.calls[0][0].where.path).toEqual({ in: [] });
    });

    it('does NOT delete unresolved paths when the tree branch came back truncated', async () => {
      // The regression this guards: a truncated listing means an absent path is
      // MISSING FROM THE RESPONSE, not deleted from the repo. Inferring deletion
      // from that absence strands live files behind signed URLs that 404.
      const many = Array.from({ length: 31 }, (_, i) => `images/f${i}.png`);
      getTree.mockResolvedValue({
        sha: 'r',
        truncated: true,
        // Only one of the 31 arrived; the other 30 were cut off.
        entries: [{ path: many[0], sha: 'sha-0', type: 'blob', size: 1 }],
      });

      const result = await syncContentAssets('class-1', {
        changes: { added: many, modified: [], removed: ['images/gone.png'] },
      });

      // The webhook's own `removed` is still trustworthy and still applied —
      // only the INFERRED deletions are suppressed.
      expect(contentAssetDeleteMany.mock.calls[0][0].where.path).toEqual({
        in: ['images/gone.png'],
      });
      // And the caller is told, so a truncated run is never mistaken for a clean one.
      expect(result.truncated).toBe(true);
    });

    it('escalates to a full sync when a .slidesthemes path changed', async () => {
      // A theme is served by the SHA of its TREE, and no per-file update can
      // produce one — the push webhook reports the file, not the folder.
      getTree.mockResolvedValue({ sha: 'r', truncated: false, entries: [] });

      const result = await syncContentAssets('class-1', {
        changes: { added: [], modified: ['.slidesthemes/midnight/theme.css'], removed: [] },
      });

      expect(result.mode).toBe('full');
      expect(getTree).toHaveBeenCalledTimes(1);
      expect(getMeta).not.toHaveBeenCalled();
    });

    it('escalates when a theme file was REMOVED, not only when one changed', async () => {
      getTree.mockResolvedValue({ sha: 'r', truncated: false, entries: [] });

      const result = await syncContentAssets('class-1', {
        changes: { added: [], modified: [], removed: ['.slidesthemes/midnight/theme.css'] },
      });

      expect(result.mode).toBe('full');
    });

    it('honours full: true even when changes are supplied', async () => {
      getTree.mockResolvedValue({ sha: 'r', truncated: false, entries: [] });

      const result = await syncContentAssets('class-1', {
        full: true,
        changes: { added: ['images/a.png'], modified: [], removed: [] },
      });

      expect(result.mode).toBe('full');
    });
  });

  describe('ensureContentAssets', () => {
    it('no-ops when the map is fresher than maxAgeMs', async () => {
      contentAssetFindFirst.mockResolvedValue({ synced_at: new Date(Date.now() - 1000) });

      const result = await ensureContentAssets('class-1', { maxAgeMs: 60_000 });

      expect(result).toBeNull();
      expect(getTree).not.toHaveBeenCalled();
    });

    it('syncs when the map is stale', async () => {
      contentAssetFindFirst.mockResolvedValue({ synced_at: new Date(Date.now() - 120_000) });
      getTree.mockResolvedValue({ sha: 'r', truncated: false, entries: [] });

      const result = await ensureContentAssets('class-1', { maxAgeMs: 60_000 });

      expect(result?.mode).toBe('full');
    });

    it('no-ops instead of throwing for a classroom the delivery layer cannot serve', async () => {
      // This sits on a render path. A GitLab-backed or example classroom must
      // fall back quietly to the legacy path, not throw on every page load.
      classroomFindUnique.mockResolvedValue({
        ...CLASSROOM,
        git_organization: { ...CLASSROOM.git_organization, provider: 'GITLAB' },
      });

      await expect(ensureContentAssets('class-1', { maxAgeMs: 60_000 })).resolves.toBeNull();
      expect(getTree).not.toHaveBeenCalled();
      expect(contentAssetFindFirst).not.toHaveBeenCalled();
    });

    it('no-ops for a classroom with no content repo', async () => {
      classroomFindUnique.mockResolvedValue({ ...CLASSROOM, content_repo: null });

      await expect(ensureContentAssets('class-1', { maxAgeMs: 60_000 })).resolves.toBeNull();
      expect(getTree).not.toHaveBeenCalled();
    });

    it('syncs when the classroom has never synced', async () => {
      // Self-bootstrapping: no backfill job, no migration. The first render of
      // a classroom that has no map builds one.
      contentAssetFindFirst.mockResolvedValue(null);
      getTree.mockResolvedValue({ sha: 'r', truncated: false, entries: [] });

      const result = await ensureContentAssets('class-1', { maxAgeMs: 60_000 });

      expect(result?.mode).toBe('full');
      expect(getTree).toHaveBeenCalledTimes(1);
    });
  });

  describe('lookups', () => {
    it('resolves a path to its git object', async () => {
      contentAssetFindUnique.mockResolvedValue({ sha: 'sha-a', type: 'blob', size: 120 });

      await expect(lookupContentAsset('class-1', 'images/a.png')).resolves.toEqual({
        sha: 'sha-a',
        type: 'blob',
        size: 120,
      });
      expect(contentAssetFindUnique).toHaveBeenCalledWith({
        where: { classroom_id_path: { classroom_id: 'class-1', path: 'images/a.png' } },
        select: { sha: true, type: true, size: true },
      });
    });

    it('resolves a directory only against tree rows, and tolerates a trailing slash', async () => {
      contentAssetFindFirst.mockResolvedValue({ sha: 'sha-t', type: 'tree', size: 0 });

      await lookupContentTree('class-1', '.slidesthemes/midnight/');

      // A FILE sitting at the same path would otherwise be handed back as a
      // folder, and the caller would address a blob SHA as a tree.
      expect(contentAssetFindFirst).toHaveBeenCalledWith({
        where: { classroom_id: 'class-1', path: '.slidesthemes/midnight', type: 'tree' },
        select: { sha: true, type: true, size: true },
      });
    });

    it('resolves a sha back to a path, deterministically', async () => {
      contentAssetFindFirst.mockResolvedValue({ path: 'images/a.png', type: 'blob', size: 120 });

      await expect(lookupContentAssetBySha('class-1', 'sha-a')).resolves.toEqual({
        path: 'images/a.png',
        type: 'blob',
        size: 120,
      });
      // Any row matching the sha is correct — content-addressed means they are
      // byte-identical — but the ORDER is pinned so the editor gets the same
      // answer on every save rather than one that varies with row layout.
      expect(contentAssetFindFirst).toHaveBeenCalledWith({
        where: { classroom_id: 'class-1', sha: 'sha-a' },
        orderBy: { path: 'asc' },
        select: { path: true, type: true, size: true },
      });
    });
  });

  describe('preconditions', () => {
    it('refuses a classroom with no git organization', async () => {
      classroomFindUnique.mockResolvedValue({ ...CLASSROOM, git_organization: null });

      await expect(syncContentAssets('class-1')).rejects.toThrow(/no git organization/i);
    });

    it('refuses an unknown classroom', async () => {
      classroomFindUnique.mockResolvedValue(null);

      await expect(syncContentAssets('nope')).rejects.toThrow(/No such classroom/i);
    });
  });
});
