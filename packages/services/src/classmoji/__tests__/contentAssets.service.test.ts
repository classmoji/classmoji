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
const classroomFindFirst = vi.fn();
const classroomUpdate = vi.fn();
const classroomUpdateMany = vi.fn();
const contentAssetFindMany = vi.fn();
const transaction = vi.fn();

vi.mock('@classmoji/database', () => ({
  default: () => ({
    classroom: {
      findUnique: classroomFindUnique,
      findFirst: classroomFindFirst,
      update: classroomUpdate,
      updateMany: classroomUpdateMany,
    },
    contentAsset: {
      upsert: contentAssetUpsert,
      deleteMany: contentAssetDeleteMany,
      findFirst: contentAssetFindFirst,
      findMany: contentAssetFindMany,
      findUnique: contentAssetFindUnique,
    },
    $transaction: transaction,
  }),
}));

const getTree = vi.fn();
const getDefaultBranch = vi.fn();
const getLatestCommitSHA = vi.fn();
const getGitProvider = vi.fn(() => ({ getTree, getDefaultBranch, getLatestCommitSHA }));
vi.mock('../../git/index.ts', () => ({
  getGitProvider: (...a: unknown[]) => getGitProvider(...(a as [])),
}));

const getMeta = vi.fn();
vi.mock('../../content/ContentService.ts', () => ({
  ContentService: { getMeta: (...a: unknown[]) => getMeta(...a) },
}));

const {
  syncContentAssets,
  syncContentAssetsForRepo,
  lookupContentAssetsBySha,
  ensureContentAssets,
  recordContentAsset,
  lookupContentAsset,
  lookupContentTree,
  lookupContentAssetBySha,
} = await import('../contentAssets.service.ts');

/** The default branch head every full sync in this file reads the tree at. */
const HEAD_COMMIT = 'f'.repeat(40);

const CLASSROOM = {
  id: 'class-1',
  content_repo: 'content-cs101',
  // Freshness lives HERE, not on the newest row — see ensureContentAssets.
  content_assets_synced_at: null as Date | null,
  // The commit the map is level with; null = never synced, no chain to gap.
  content_assets_synced_commit: null as string | null,
  git_organization: { id: 'org-1', provider: 'GITHUB', login: 'dartmouth-cs' },
};

/** A classroom whose last FULL sync finished `ms` ago. */
const syncedAgo = (ms: number) => ({
  ...CLASSROOM,
  content_assets_synced_at: new Date(Date.now() - ms),
});

/**
 * The upsert/deleteMany mocks return tagged markers so ops stay identifiable.
 * `casCount` models the compare-and-swap: 1 when it lands, 0 when another run
 * moved the classroom's commit first.
 */
const setupTransaction = (deletedCount = 0, casCount = 1) => {
  contentAssetUpsert.mockImplementation(args => ({ op: 'upsert', args }));
  contentAssetDeleteMany.mockImplementation(args => ({ op: 'deleteMany', args }));
  classroomUpdate.mockImplementation(args => ({ op: 'classroomUpdate', args }));
  classroomUpdateMany.mockImplementation(args => ({ op: 'classroomUpdateMany', args }));
  transaction.mockImplementation((ops: { op: string }[]) =>
    Promise.resolve(
      ops.map(op => {
        if (op.op === 'deleteMany') return { count: deletedCount };
        if (op.op === 'classroomUpdateMany') return { count: casCount };
        return op;
      })
    )
  );
};

describe('contentAssets.service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    classroomFindUnique.mockResolvedValue(CLASSROOM);
    classroomFindFirst.mockResolvedValue({ id: 'class-1' });
    getDefaultBranch.mockResolvedValue('main');
    getLatestCommitSHA.mockResolvedValue(HEAD_COMMIT);
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
      // Read AT the head commit, not at the moving branch — so the commit the
      // run records describes exactly the entries it stored.
      expect(getDefaultBranch).toHaveBeenCalledWith('dartmouth-cs', 'content-cs101');
      expect(getLatestCommitSHA).toHaveBeenCalledWith('dartmouth-cs', 'content-cs101', 'main');
      expect(getTree).toHaveBeenCalledWith('dartmouth-cs', 'content-cs101', HEAD_COMMIT, true);
      expect(contentAssetUpsert).toHaveBeenCalledTimes(3);

      // Directories are rows too — theme folders are addressed by tree SHA, so
      // dropping them would make themes unresolvable.
      const upsertedPaths = contentAssetUpsert.mock.calls.map(([args]) => args.create.path);
      expect(upsertedPaths).toEqual(['images', 'images/a.png', 'images/b.png']);

      // The sweep is what deletes paths removed from the repo. Every row
      // written this run carries the same stamp, so `lt` matches only rows an
      // earlier run wrote and this one did not refresh — and the stamp is taken
      // BEFORE the tree read, so a row written while it was in flight is above
      // it rather than below. See the ordering test below.
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

    it('takes its stamp BEFORE the tree read, so a row written during it survives', async () => {
      // THE race this guards. Reading a repo's tree is a network round trip,
      // and `recordContentAsset` writes a row for a just-uploaded file stamped
      // `now`. Stamping AFTER the read puts the run's stamp ahead of that row,
      // and the sweep's `synced_at < stamp` deletes it — a file that IS in the
      // repo, simply newer than the snapshot this run read, and the teacher who
      // just uploaded it watches it render as a dangling URL.
      vi.useFakeTimers();
      try {
        let midRead = 0;
        getTree.mockImplementation(async () => {
          // The read takes time; a concurrent upload's row stamps in here.
          vi.advanceTimersByTime(5_000);
          midRead = Date.now();
          return { sha: 'r', truncated: false, entries: [] };
        });

        await syncContentAssets('class-1');

        const [sweep] = contentAssetDeleteMany.mock.calls[0];
        expect(sweep.where.synced_at.lt.getTime()).toBeLessThan(midRead);
      } finally {
        getTree.mockReset();
        vi.useRealTimers();
      }
    });

    it('reads the tree at the repo default branch, not a hardcoded main', async () => {
      // A course imported from an older org is on `master`. Against `main` the
      // tree call 404s, the sync throws, and the classroom keeps an EMPTY map —
      // every asset falls back to the legacy path forever.
      getDefaultBranch.mockResolvedValue('master');
      getTree.mockResolvedValue({
        sha: 'r',
        truncated: false,
        entries: [{ path: 'images/a.png', sha: 'sha-a', type: 'blob', size: 1 }],
      });

      await syncContentAssets('class-1');

      expect(getLatestCommitSHA).toHaveBeenCalledWith('dartmouth-cs', 'content-cs101', 'master');
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

    it('stamps the classroom with the run, inside the same transaction', async () => {
      // A run that read the whole tree is the ONLY thing entitled to say the
      // map matches the repo, and the stamp is what `ensureContentAssets`
      // measures against. In the transaction so a sync that fails leaves the
      // classroom looking exactly as unsynced as it is.
      getTree.mockResolvedValue({
        sha: 'r',
        truncated: false,
        entries: [{ path: 'images/a.png', sha: 'sha-a', type: 'blob', size: 1 }],
      });

      await syncContentAssets('class-1');

      expect(classroomUpdate).toHaveBeenCalledTimes(1);
      const [stamp] = classroomUpdate.mock.calls[0];
      expect(stamp.where).toEqual({ id: 'class-1' });
      // The commit the tree was read at rides along with the timestamp: it is
      // the state the map is now level with, and the next push's `before` is
      // measured against it.
      expect(stamp.data.content_assets_synced_commit).toBe(HEAD_COMMIT);
      // The run's one stamp — the same instant every row it wrote carries.
      const rowStamp = contentAssetUpsert.mock.calls[0][0].create.synced_at;
      expect(stamp.data.content_assets_synced_at).toEqual(rowStamp);

      const ops = transaction.mock.calls[0][0] as { op: string }[];
      expect(ops).toContainEqual({ op: 'classroomUpdate', args: stamp });
      // Ahead of the sweep, which the result's delete count is read off the
      // tail of — see fullSync.
      expect(ops[0].op).toBe('classroomUpdate');
      expect(ops.at(-1)?.op).toBe('deleteMany');
    });

    it('stamps even when the tree came back truncated', async () => {
      // It read the tree and applied everything that arrived, which is as
      // current as this classroom can get. Refusing to stamp would put a repo
      // that is simply too big into a permanent re-sync loop.
      getTree.mockResolvedValue({
        sha: 'r',
        truncated: true,
        entries: [{ path: 'images/a.png', sha: 'sha-a', type: 'blob', size: 1 }],
      });

      await syncContentAssets('class-1');

      expect(classroomUpdate).toHaveBeenCalledTimes(1);
      const ops = transaction.mock.calls[0][0] as { op: string }[];
      expect(ops[0].op).toBe('classroomUpdate');
    });
  });

  describe('incremental sync', () => {
    /** The commit the map is level with. */
    const LEVEL = 'a'.repeat(40);

    beforeEach(() => {
      // An incremental sync only ever happens for a classroom whose tree has
      // already been read once — a null commit escalates to full, deliberately,
      // because a diff cannot build a map out of nothing.
      classroomFindUnique.mockResolvedValue({
        ...CLASSROOM,
        content_assets_synced_commit: LEVEL,
      });
    });

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

    it('does NOT stamp the classroom as fully synced', async () => {
      // It applied the paths one push named and knows nothing about the rest of
      // the repo. Stamping the TIMESTAMP here would let a steady trickle of
      // webhooks suppress the daily full refresh — which exists to repair the
      // webhooks that never arrive at all.
      getMeta.mockResolvedValue({ sha: 'sha-a', size: 10 });

      const result = await syncContentAssets('class-1', {
        changes: { added: ['images/a.png'], modified: [], removed: [] },
      });

      expect(result.mode).toBe('incremental');
      expect(classroomUpdate).not.toHaveBeenCalled();
    });

    it('records the push it landed as the commit the map is level with', async () => {
      // The other half of dropped-delivery detection: without this, every push
      // would look like a gap against a commit only full syncs ever move.
      // Commit only — the freshness timestamp stays untouched, so the daily
      // full refresh still fires.
      getMeta.mockResolvedValue({ sha: 'sha-a', size: 10 });

      await syncContentAssets('class-1', {
        changes: { added: ['images/a.png'], modified: [], removed: [] },
        before: null,
        after: 'b'.repeat(40),
      });

      // A COMPARE-AND-SWAP: matched on the commit this run read, so a slower
      // concurrent run cannot move the map's commit backwards.
      expect(classroomUpdateMany).toHaveBeenCalledTimes(1);
      const [update] = classroomUpdateMany.mock.calls[0];
      expect(update).toEqual({
        where: { id: 'class-1', content_assets_synced_commit: LEVEL },
        data: { content_assets_synced_commit: 'b'.repeat(40) },
      });
      // The freshness timestamp is untouched, so the daily full refresh fires.
      expect(classroomUpdate).not.toHaveBeenCalled();
      // In the transaction, so a failed apply cannot claim a commit it never
      // applied — and ahead of the sweep, whose count is read off the tail.
      const ops = transaction.mock.calls[0][0] as { op: string }[];
      expect(ops[0].op).toBe('classroomUpdateMany');
      expect(ops.at(-1)?.op).toBe('deleteMany');
    });

    it('drops the commit claim when a concurrent run got there first', async () => {
      // The CAS matched nothing: something moved the classroom past the commit
      // this run read. The ROWS it wrote stay — they are content-addressed and
      // idempotent — but it must not claim a level it cannot vouch for. The
      // winner's commit will not match the next push's `before`, which
      // escalates, and that is the repair.
      classroomFindUnique.mockResolvedValue({
        ...CLASSROOM,
        content_assets_synced_commit: LEVEL,
      });
      setupTransaction(0, /* casCount */ 0);
      getMeta.mockResolvedValue({ sha: 'sha-a', size: 10 });
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const result = await syncContentAssets('class-1', {
        changes: { added: ['images/a.png'], modified: [], removed: [] },
        before: LEVEL,
        after: 'b'.repeat(40),
      });

      expect(result.mode).toBe('incremental');
      expect(result.upserted).toBe(1);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('Concurrent sync for class-1'));
      warn.mockRestore();
    });

    it('does NOT record a commit when the listing came back truncated', async () => {
      // It could not apply the deletions it inferred, so the map is not level
      // with `after` and must not say it is. Recording would make the next
      // push look clean against a map that is missing rows.
      classroomFindUnique.mockResolvedValue({
        ...CLASSROOM,
        content_assets_synced_commit: LEVEL,
      });
      const many = Array.from({ length: 31 }, (_unused, i) => `images/f${i}.png`);
      getTree.mockResolvedValue({
        sha: 'r',
        truncated: true,
        entries: [{ path: many[0], sha: 'sha-0', type: 'blob', size: 1 }],
      });

      const result = await syncContentAssets('class-1', {
        changes: { added: many, modified: [], removed: [] },
        before: LEVEL,
        after: 'b'.repeat(40),
      });

      expect(result.truncated).toBe(true);
      expect(classroomUpdateMany).not.toHaveBeenCalled();
    });
  });

  describe('dropped-delivery detection', () => {
    const LEVEL = 'a'.repeat(40);
    const changes = { added: ['images/a.png'], modified: [], removed: [] };

    beforeEach(() => {
      getMeta.mockResolvedValue({ sha: 'sha-a', size: 10 });
      getTree.mockResolvedValue({ sha: 'r', truncated: false, entries: [] });
    });

    it('escalates to a full sync when the push does not build on the stored commit', async () => {
      // THE regression this guards. A dropped delivery used to be invisible:
      // the next push applies cleanly — its own lists are internally consistent
      // — so the map silently keeps rows for paths the missing push deleted and
      // never learns about the ones it added, and it all looks healthy until
      // the nightly sweep happens to run.
      classroomFindUnique.mockResolvedValue({
        ...CLASSROOM,
        content_assets_synced_commit: LEVEL,
      });
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const result = await syncContentAssets('class-1', {
        changes,
        before: 'c'.repeat(40),
        after: 'd'.repeat(40),
      });

      expect(result.mode).toBe('full');
      expect(getMeta).not.toHaveBeenCalled();
      // Silently escalating would hide a webhook that is permanently failing.
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('a delivery was missed'));
      warn.mockRestore();
    });

    it('stays incremental when the push builds on exactly the stored commit', async () => {
      classroomFindUnique.mockResolvedValue({
        ...CLASSROOM,
        content_assets_synced_commit: LEVEL,
      });

      const result = await syncContentAssets('class-1', {
        changes,
        before: LEVEL,
        after: 'd'.repeat(40),
      });

      expect(result.mode).toBe('incremental');
      expect(getTree).not.toHaveBeenCalled();
    });

    it('escalates a FIRST sync because there is no map, not because of a gap', async () => {
      // Null stored commit is not a gap in the chain — there is no chain — so
      // this is not reported as a missed delivery. It still goes full, and for
      // a different reason: a diff cannot build a map out of nothing. Applying
      // one push's paths would leave every untouched file missing and then
      // record that half-map as level with `after`, starting the chain from a
      // state that was never true.
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const result = await syncContentAssets('class-1', {
        changes,
        before: 'c'.repeat(40),
        after: 'd'.repeat(40),
      });

      expect(result.mode).toBe('full');
      expect(getMeta).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('a delivery was missed'));
      warn.mockRestore();
    });

    it('escalates a first sync even when the push carries no before at all', async () => {
      const result = await syncContentAssets('class-1', { changes, after: 'd'.repeat(40) });

      expect(result.mode).toBe('full');
    });

    it('escalates a branch-creation push, whose before is all zeros', async () => {
      // GitHub sends 40 zeros as `before` when a ref is created. It is not the
      // commit the map is level with, so it is a gap like any other.
      classroomFindUnique.mockResolvedValue({
        ...CLASSROOM,
        content_assets_synced_commit: LEVEL,
      });
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const result = await syncContentAssets('class-1', {
        changes,
        before: '0'.repeat(40),
        after: 'd'.repeat(40),
      });

      expect(result.mode).toBe('full');
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('a delivery was missed'));
      warn.mockRestore();
    });

    it('does not escalate a caller that cannot answer the question', async () => {
      // A manual or TTL run carries no `before`. Silence is not evidence.
      classroomFindUnique.mockResolvedValue({
        ...CLASSROOM,
        content_assets_synced_commit: LEVEL,
      });

      const result = await syncContentAssets('class-1', { changes });

      expect(result.mode).toBe('incremental');
    });
  });

  describe('syncContentAssetsForRepo', () => {
    it('full-syncs the classroom that owns the repo', async () => {
      // What a theme save needs. A theme is delivered by the SHA of its TREE,
      // so until the map is rebuilt every deck keeps signing the PREVIOUS tree
      // and the edge keeps serving the previous CSS — the author reloads and
      // their change has not taken. Full mode, because no per-file update can
      // produce a tree SHA.
      getTree.mockResolvedValue({ sha: 'r', truncated: false, entries: [] });

      const result = await syncContentAssetsForRepo('dartmouth-cs', 'content-cs101', 'theme-save');

      expect(classroomFindFirst).toHaveBeenCalledWith({
        where: { content_repo: 'content-cs101', git_organization: { login: 'dartmouth-cs' } },
        select: { id: true },
      });
      expect(result?.mode).toBe('full');
    });

    it('no-ops for a repo no classroom claims as its content repo', async () => {
      classroomFindFirst.mockResolvedValue(null);

      await expect(
        syncContentAssetsForRepo('someone-else', 'other-repo', 'theme-save')
      ).resolves.toBeNull();
      expect(getTree).not.toHaveBeenCalled();
    });

    it('resolves null instead of throwing when the sync fails', async () => {
      // It runs AFTER a commit that already reached GitHub. A save that
      // succeeded must never be reported as failed because a cache could not
      // be refreshed.
      getTree.mockRejectedValue(new Error('API rate limit exceeded'));
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

      await expect(
        syncContentAssetsForRepo('dartmouth-cs', 'content-cs101', 'theme-save')
      ).resolves.toBeNull();

      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('theme-save sync failed for dartmouth-cs/content-cs101'),
        expect.any(Error)
      );
      warn.mockRestore();
    });
  });

  describe('ensureContentAssets', () => {
    it('collapses a concurrent burst into ONE sync', async () => {
      // A staff landing page renders ~20 deck thumbnails at once, and each now
      // reads through the map. The freshness stamp is written at the END of a
      // sync, so without this guard all twenty read the same stale value and
      // all start their own — sixty GitHub calls to compute one answer, on
      // exactly the classroom that was already behind.
      classroomFindUnique.mockResolvedValue(syncedAgo(10 * 60_000));

      const results = await Promise.all(
        Array.from({ length: 20 }, () => ensureContentAssets('class-1', { maxAgeMs: 60_000 }))
      );

      expect(getTree).toHaveBeenCalledTimes(1);
      // Every caller still gets the answer — they waited on the one sync.
      for (const result of results) expect(result).toEqual(results[0]);
    });

    it('does not hold the in-flight entry past the sync', async () => {
      // A stampede guard, not a cache: the next stale read must sync again.
      classroomFindUnique.mockResolvedValue(syncedAgo(10 * 60_000));

      await ensureContentAssets('class-1', { maxAgeMs: 60_000 });
      await ensureContentAssets('class-1', { maxAgeMs: 60_000 });

      expect(getTree).toHaveBeenCalledTimes(2);
    });

    it('no-ops when the last FULL sync is fresher than maxAgeMs', async () => {
      classroomFindUnique.mockResolvedValue(syncedAgo(1000));

      const result = await ensureContentAssets('class-1', { maxAgeMs: 60_000 });

      expect(result).toBeNull();
      expect(getTree).not.toHaveBeenCalled();
    });

    it('syncs when the last full sync is older than maxAgeMs', async () => {
      classroomFindUnique.mockResolvedValue(syncedAgo(120_000));
      getTree.mockResolvedValue({ sha: 'r', truncated: false, entries: [] });

      const result = await ensureContentAssets('class-1', { maxAgeMs: 60_000 });

      expect(result?.mode).toBe('full');
    });

    it('still refreshes a stale map that a fresh UPLOAD row just touched', async () => {
      // THE regression this guards. `recordContentAsset` stamps its row `now`,
      // so reading freshness off the newest row let one teacher uploading one
      // image make a week-old map look fresh for another 24 hours — on exactly
      // the classrooms that need the repair, the ones whose push webhook is not
      // arriving. Pushed files stay dangling and deleted files never get swept
      // for as long as anyone keeps uploading.
      const DAY = 24 * 60 * 60 * 1000;
      classroomFindUnique.mockResolvedValue(syncedAgo(7 * DAY));
      getTree.mockResolvedValue({ sha: 'r', truncated: false, entries: [] });

      await recordContentAsset('class-1', { path: 'pages/home/assets/x.png', sha: 'sha-x' });
      expect(contentAssetUpsert).toHaveBeenCalled();

      // What the upload leaves behind: a row stamped NOW on a map whose last
      // real sync was a week ago. Seeded explicitly, because the old probe read
      // exactly this and would answer "fresh" — the bug.
      contentAssetFindFirst.mockResolvedValue({ synced_at: new Date() });

      const result = await ensureContentAssets('class-1', { maxAgeMs: DAY });

      // The classroom stamp is untouched, so the daily repair still fires.
      expect(getTree).toHaveBeenCalledTimes(1);
      expect(result?.mode).toBe('full');
    });

    it('syncs when the classroom has never fully synced', async () => {
      // Null stamp, whatever the rows say.
      classroomFindUnique.mockResolvedValue({ ...CLASSROOM, content_assets_synced_at: null });
      getTree.mockResolvedValue({ sha: 'r', truncated: false, entries: [] });

      const result = await ensureContentAssets('class-1', { maxAgeMs: 60_000 });

      expect(result?.mode).toBe('full');
      expect(getTree).toHaveBeenCalledTimes(1);
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
    });

    it('no-ops for a classroom with no content repo', async () => {
      classroomFindUnique.mockResolvedValue({ ...CLASSROOM, content_repo: null });

      await expect(ensureContentAssets('class-1', { maxAgeMs: 60_000 })).resolves.toBeNull();
      expect(getTree).not.toHaveBeenCalled();
    });

    it('resolves null instead of throwing when the sync itself fails', async () => {
      // The render-path contract. A GitHub 403 rate limit or a 5xx must cost
      // staleness, not a broken page — the previous map is still in the table
      // and still usable.
      getTree.mockRejectedValue(
        Object.assign(new Error('API rate limit exceeded'), {
          status: 403,
        })
      );
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

      await expect(ensureContentAssets('class-1', { maxAgeMs: 60_000 })).resolves.toBeNull();

      // Silently swallowing it would make a permanently failing sync invisible.
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('sync failed for class-1'),
        expect.any(Error)
      );
      warn.mockRestore();
    });

    it('still throws from syncContentAssets, which is called deliberately', async () => {
      // The other half of the contract: only the render-path entry swallows.
      getTree.mockRejectedValue(new Error('API rate limit exceeded'));

      await expect(syncContentAssets('class-1')).rejects.toThrow(/rate limit/);
    });

    it('reads the classroom once, not once per guard', async () => {
      getTree.mockResolvedValue({ sha: 'r', truncated: false, entries: [] });

      await ensureContentAssets('class-1', { maxAgeMs: 60_000 });

      expect(classroomFindUnique).toHaveBeenCalledTimes(1);
    });
  });

  describe('recordContentAsset', () => {
    it('upserts one blob row with the same shape a sync would write', async () => {
      // The point of the whole helper: the row exists before any webhook or
      // 24-hour refresh, so the very next render resolves the path instead of
      // signing a dangling URL for it.
      await expect(
        recordContentAsset('class-1', { path: 'pages/home/assets/x.png', sha: 'sha-x', size: 512 })
      ).resolves.toBe(true);

      expect(contentAssetUpsert).toHaveBeenCalledTimes(1);
      const [args] = contentAssetUpsert.mock.calls[0];
      expect(args.where).toEqual({
        classroom_id_path: { classroom_id: 'class-1', path: 'pages/home/assets/x.png' },
      });
      // An upload writes a file, never a tree.
      expect(args.create).toMatchObject({
        classroom_id: 'class-1',
        path: 'pages/home/assets/x.png',
        sha: 'sha-x',
        type: 'blob',
        size: 512,
      });
      expect(args.update).toMatchObject({ sha: 'sha-x', type: 'blob', size: 512 });
      // Stamped now, so the next full sync's sweep keeps it rather than
      // deleting a row for a file that is genuinely in the repo.
      expect(args.create.synced_at).toBeInstanceOf(Date);
      expect(args.update.synced_at).toEqual(args.create.synced_at);
    });

    it('defaults a missing size to 0, as the tree entries do', async () => {
      await recordContentAsset('class-1', { path: 'images/a.png', sha: 'sha-a' });

      expect(contentAssetUpsert.mock.calls[0][0].create.size).toBe(0);
    });

    it('no-ops for a classroom the delivery layer cannot serve', async () => {
      // GitLab-backed, the mock org behind an example classroom, or no content
      // repo. The upload itself still succeeded, so this must not throw.
      classroomFindUnique.mockResolvedValue({
        ...CLASSROOM,
        git_organization: { ...CLASSROOM.git_organization, provider: 'GITLAB' },
      });

      await expect(
        recordContentAsset('class-1', { path: 'images/a.png', sha: 'sha-a' })
      ).resolves.toBe(false);
      expect(contentAssetUpsert).not.toHaveBeenCalled();
    });

    it('no-ops for a classroom with no content repo', async () => {
      classroomFindUnique.mockResolvedValue({ ...CLASSROOM, content_repo: null });

      await expect(
        recordContentAsset('class-1', { path: 'images/a.png', sha: 'sha-a' })
      ).resolves.toBe(false);
      expect(contentAssetUpsert).not.toHaveBeenCalled();
    });

    it('does NOT stamp the classroom as fully synced', async () => {
      // One file is not the repo. This is the whole reason freshness moved off
      // the rows — see the ensureContentAssets suite.
      await recordContentAsset('class-1', { path: 'images/a.png', sha: 'sha-a' });

      expect(classroomUpdate).not.toHaveBeenCalled();
    });

    it('resolves false instead of throwing when the write fails', async () => {
      // It sits on an upload path. A file that reached the repo must never be
      // reported as a failed upload because a cache row could not be written.
      contentAssetUpsert.mockImplementation(() => {
        throw new Error('connection terminated');
      });
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

      await expect(
        recordContentAsset('class-1', { path: 'images/a.png', sha: 'sha-a' })
      ).resolves.toBe(false);

      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('Could not record images/a.png for class-1'),
        expect.any(Error)
      );
      warn.mockRestore();
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

    it('resolves many shas in ONE query, lowest path winning a tie', async () => {
      // An import rewrites a course's worth of content at once; per-sha lookups
      // were a round trip per image per page.
      contentAssetFindMany.mockResolvedValue([
        { path: 'pages/lab-1/a.png', sha: 'sha-a' },
        { path: 'pages/lab-9/copy-of-a.png', sha: 'sha-a' },
        { path: 'pages/lab-2/b.png', sha: 'sha-b' },
      ]);

      const found = await lookupContentAssetsBySha('class-1', ['sha-a', 'sha-b', 'sha-a']);

      expect(contentAssetFindMany).toHaveBeenCalledTimes(1);
      expect(contentAssetFindMany).toHaveBeenCalledWith({
        where: { classroom_id: 'class-1', sha: { in: ['sha-a', 'sha-b'] } },
        select: { path: true, sha: true },
        orderBy: { path: 'asc' },
      });
      // Two paths at one sha are byte-identical, so either is correct — the
      // order is pinned so repeated imports produce the same output.
      expect(found.get('sha-a')).toBe('pages/lab-1/a.png');
      expect(found.get('sha-b')).toBe('pages/lab-2/b.png');
      // A sha the map has never heard of is simply absent.
      expect(found.has('sha-z')).toBe(false);
    });

    it('does not query at all for an empty sha list', async () => {
      await expect(lookupContentAssetsBySha('class-1', [])).resolves.toEqual(new Map());
      expect(contentAssetFindMany).not.toHaveBeenCalled();
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
