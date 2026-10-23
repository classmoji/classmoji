import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The asset map is a CACHE of the content repo, so what matters is not that a
 * sync writes rows — it is that a sync converges: every push leaves the map
 * level with the branch head (folder tree rows included), rows for paths that
 * left the repo go away, and a truncated listing is not mistaken for a repo
 * that shrank.
 *
 * Prisma and the git provider are both mocked; what the SQL statements DO
 * against a real Postgres is `contentAssets.integration.test.ts`. The
 * transaction is modelled as "run the ops, return their results in order".
 */

const contentAssetUpsert = vi.fn();
const contentAssetDeleteMany = vi.fn();
const contentAssetFindFirst = vi.fn();
const contentAssetFindUnique = vi.fn();
const classroomFindUnique = vi.fn();
const classroomFindFirst = vi.fn();
const classroomUpdateMany = vi.fn();
const contentAssetFindMany = vi.fn();
const executeRaw = vi.fn();
const transaction = vi.fn();

vi.mock('@classmoji/database', () => ({
  default: () => ({
    classroom: {
      findUnique: classroomFindUnique,
      findFirst: classroomFindFirst,
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
    $executeRaw: executeRaw,
  }),
}));

/**
 * The sync's statements are tagged templates, so the mock receives
 * `(strings, ...params)`. These read them back out positionally, in the order
 * the statements interpolate them — a reordering these did not notice would be
 * a silent column swap in production.
 */
type RawCall = [TemplateStringsArray, ...unknown[]];
const rawCalls = () => executeRaw.mock.calls as RawCall[];
const sqlOf = (call: RawCall) => call[0].join('?');
const upsertCall = () => rawCalls().find(call => sqlOf(call).includes('INSERT'));
const deleteCall = () => rawCalls().find(call => sqlOf(call).includes('DELETE'));
// INSERT params: classroomId, stamp, paths, shas, types, sizes.
const upsertedPathsOf = () => upsertCall()![3] as string[];
const upsertedShasOf = () => upsertCall()![4] as string[];
const upsertedTypesOf = () => upsertCall()![5] as string[];
const upsertedSizesOf = () => upsertCall()![6] as number[];
const upsertStampOf = () => upsertCall()![2] as Date;
// DELETE params: classroomId, stamp, paths still in the tree.
const deleteStampOf = () => deleteCall()![2] as Date;
const keptPathsOf = () => deleteCall()![3] as string[];

const getTree = vi.fn();
const getDefaultBranch = vi.fn();
const getLatestCommitSHA = vi.fn();
const getGitProvider = vi.fn(() => ({ getTree, getDefaultBranch, getLatestCommitSHA }));
vi.mock('../../git/index.ts', () => ({
  getGitProvider: (...a: unknown[]) => getGitProvider(...(a as [])),
}));

const {
  syncContentAssets,
  syncContentAssetsForRepo,
  recordFolderTreesAfterCommit,
  lookupContentAssetsBySha,
  ensureContentAssets,
  ensureContentAssetsOutcome,
  recordContentAsset,
  removeContentAssets,
  removeContentAssetFolder,
  lookupContentAsset,
  lookupContentTree,
  lookupContentAssetBySha,
  listContentAssetPaths,
} = await import('../contentAssets.service.ts');

/** The default branch head every sync in this file reads the tree at. */
const HEAD_COMMIT = 'f'.repeat(40);

const CLASSROOM = {
  id: 'class-1',
  content_repo: 'content-cs101',
  // Freshness lives HERE, not on the newest row — see ensureContentAssets.
  content_assets_synced_at: null as Date | null,
  // The commit the map is level with; null = never synced.
  content_assets_synced_commit: null as string | null,
  git_organization: {
    id: 'org-1',
    provider: 'GITHUB',
    login: 'dartmouth-cs',
    // Part of `isDeliverable`: with no installation the App cannot mint a token,
    // so a sync could only ever fail. See the null-installation cases below.
    github_installation_id: '12345678' as string | null,
    gitlab_connection_id: null as string | null,
  },
};

const GITLAB_CLASSROOM = {
  ...CLASSROOM,
  git_organization: {
    id: 'org-gl',
    provider: 'GITLAB',
    login: 'dartmouth',
    github_installation_id: null,
    gitlab_connection_id: 'conn-1',
  },
};

/** A classroom whose last tree sync finished `ms` ago. */
const syncedAgo = (ms: number) => ({
  ...CLASSROOM,
  content_assets_synced_at: new Date(Date.now() - ms),
});

/**
 * Ops are tagged markers so they stay identifiable inside the transaction; the
 * transaction answers each with what Postgres would: a row count for raw
 * statements, `{ count }` for `updateMany`.
 */
const setupTransaction = ({ upserted = 0, deleted = 0 } = {}) => {
  contentAssetUpsert.mockImplementation(args => ({ op: 'upsert', args }));
  executeRaw.mockImplementation((strings: TemplateStringsArray) => ({
    op: strings.join('?').includes('DELETE') ? 'rawDelete' : 'rawUpsert',
  }));
  contentAssetDeleteMany.mockImplementation(args => ({ op: 'deleteMany', args }));
  classroomUpdateMany.mockImplementation(args => ({ op: 'stamp', args }));
  transaction.mockImplementation((ops: { op: string }[]) =>
    Promise.resolve(
      ops.map(op => {
        if (op.op === 'rawDelete') return deleted;
        if (op.op === 'rawUpsert') return upserted;
        if (op.op === 'stamp') return { count: 1 };
        return op;
      })
    )
  );
};

const tree = (entries: Array<{ path: string; sha: string; type: string; size?: number }>) => ({
  sha: 'root',
  truncated: false,
  entries,
});

describe('contentAssets.service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    classroomFindUnique.mockResolvedValue(CLASSROOM);
    classroomFindFirst.mockResolvedValue({ id: 'class-1' });
    getDefaultBranch.mockResolvedValue('main');
    getLatestCommitSHA.mockResolvedValue(HEAD_COMMIT);
    setupTransaction();
  });

  describe('tree sync', () => {
    it('reads the whole tree at the head and writes blob AND tree rows in one statement', async () => {
      getTree.mockResolvedValue(
        tree([
          { path: 'images', sha: 'sha-dir', type: 'tree' },
          { path: 'images/a.png', sha: 'sha-a', type: 'blob', size: 120 },
          { path: 'images/b.png', sha: 'sha-b', type: 'blob', size: 240 },
        ])
      );
      setupTransaction({ upserted: 2, deleted: 4 });

      const result = await syncContentAssets('class-1');

      // The counts are Postgres's: rows actually changed, rows actually gone.
      expect(result).toEqual({ mode: 'full', upserted: 2, deleted: 4, truncated: false });
      // Read AT the head commit, not at the moving branch — so the commit the
      // run records describes exactly the entries it stored.
      expect(getDefaultBranch).toHaveBeenCalledWith('dartmouth-cs', 'content-cs101');
      expect(getLatestCommitSHA).toHaveBeenCalledWith('dartmouth-cs', 'content-cs101', 'main');
      expect(getTree).toHaveBeenCalledWith('dartmouth-cs', 'content-cs101', HEAD_COMMIT, true);
      expect(upsertedPathsOf()).toEqual(['images', 'images/a.png', 'images/b.png']);
      expect(upsertedTypesOf()).toEqual(['tree', 'blob', 'blob']);
      expect(upsertedShasOf()).toEqual(['sha-dir', 'sha-a', 'sha-b']);
      expect(upsertedSizesOf()).toEqual([0, 120, 240]);
    });

    it('updates the trees above a changed file on an ordinary push', async () => {
      // Editing slides/intro/blocks/a.html moves the tree sha of
      // slides/intro/blocks, slides/intro and slides — the folder versions a
      // frame grant is signed with. The whole-tree read hands all of them to
      // the upsert, which writes exactly the ones that changed.
      getTree.mockResolvedValue(
        tree([
          { path: 'slides', sha: 'slides-v2', type: 'tree' },
          { path: 'slides/intro', sha: 'intro-v2', type: 'tree' },
          { path: 'slides/intro/blocks', sha: 'blocks-v2', type: 'tree' },
          { path: 'slides/intro/blocks/a.html', sha: 'a-v2', type: 'blob', size: 10 },
          { path: 'slides/intro/deck.json', sha: 'deck-v1', type: 'blob', size: 5 },
        ])
      );

      await syncContentAssets('class-1');

      expect(upsertedPathsOf()).toEqual(
        expect.arrayContaining(['slides', 'slides/intro', 'slides/intro/blocks'])
      );
      expect(upsertedShasOf()).toEqual(expect.arrayContaining(['slides-v2', 'intro-v2']));
    });

    it('rewrites only changed rows and never moves a row backwards', async () => {
      getTree.mockResolvedValue(tree([{ path: 'a.png', sha: 'sha-a', type: 'blob', size: 1 }]));

      await syncContentAssets('class-1');

      const sql = upsertCall()![0].join('?');
      expect(sql).toContain('ON CONFLICT (classroom_id, path) DO UPDATE');
      // A row stamped at or after this run (a newer write-through) keeps what it has.
      expect(sql).toContain('WHERE content_assets.synced_at < EXCLUDED.synced_at');
      // An unchanged row is not rewritten — not even its stamp. Size is not compared.
      expect(sql).toContain(
        '(content_assets.sha, content_assets.type) IS DISTINCT FROM (EXCLUDED.sha, EXCLUDED.type)'
      );
    });

    it('deletes by the path set, not by the stamp alone', async () => {
      // Unchanged rows are not restamped, so "older than this run" no longer
      // means "gone from the repo". The delete keeps every path the tree holds
      // and only considers rows stamped before the run.
      getTree.mockResolvedValue(
        tree([
          { path: 'images', sha: 'd', type: 'tree' },
          { path: 'images/a.png', sha: 'a', type: 'blob', size: 1 },
        ])
      );

      await syncContentAssets('class-1');

      const sql = deleteCall()![0].join('?');
      expect(sql).toContain('synced_at < ?');
      expect(sql).toContain('NOT (path = ANY(?::text[]))');
      expect(deleteCall()![1]).toBe('class-1');
      expect(keptPathsOf()).toEqual(['images', 'images/a.png']);
      // The one run stamp, shared by the upsert and the delete.
      expect(deleteStampOf().getTime()).toBe(upsertStampOf().getTime());
    });

    it('deletes everything older for an emptied repo, and writes nothing', async () => {
      getTree.mockResolvedValue(tree([]));

      await syncContentAssets('class-1');

      expect(upsertCall()).toBeUndefined();
      expect(keptPathsOf()).toEqual([]);
      expect(classroomUpdateMany).toHaveBeenCalledTimes(1);
    });

    it('does NOT delete when the tree came back truncated, but still records the commit', async () => {
      // The missing entries are not absent from the repo, so deleting their
      // rows would strand files that still exist. Recording the commit keeps a
      // too-big repo from re-reading its tree on every push for nothing.
      getTree.mockResolvedValue({
        sha: 'root',
        truncated: true,
        entries: [{ path: 'images/a.png', sha: 'sha-a', type: 'blob', size: 1 }],
      });
      setupTransaction({ upserted: 1 });
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const result = await syncContentAssets('class-1');

      expect(result).toEqual({ mode: 'full', upserted: 1, deleted: 0, truncated: true });
      expect(deleteCall()).toBeUndefined();
      expect(contentAssetDeleteMany).not.toHaveBeenCalled();
      expect(classroomUpdateMany.mock.calls[0][0].data.content_assets_synced_commit).toBe(
        HEAD_COMMIT
      );
      warn.mockRestore();
    });

    it('takes its stamp BEFORE the head read, so a row written during the read survives', async () => {
      // A row a save writes while the tree read is in flight is stamped above
      // the run: the upsert skips it and the delete never considers it.
      vi.useFakeTimers();
      try {
        let midRead = 0;
        getTree.mockImplementation(async () => {
          vi.advanceTimersByTime(5_000);
          midRead = Date.now();
          return tree([]);
        });

        await syncContentAssets('class-1');

        expect(deleteStampOf().getTime()).toBeLessThan(midRead);
      } finally {
        getTree.mockReset();
        vi.useRealTimers();
      }
    });

    it('stamps the classroom inside the same transaction, moving the stamp only forward', async () => {
      getTree.mockResolvedValue(tree([{ path: 'a.png', sha: 'a', type: 'blob', size: 1 }]));

      await syncContentAssets('class-1');

      const [stamp] = classroomUpdateMany.mock.calls[0];
      // An older run finishing late cannot record its older commit over a
      // newer run's: the stamp lands only on a classroom stamped before it.
      expect(stamp.where).toEqual({
        id: 'class-1',
        OR: [
          { content_assets_synced_at: null },
          { content_assets_synced_at: { lt: upsertStampOf() } },
        ],
      });
      expect(stamp.data).toEqual({
        content_assets_synced_at: upsertStampOf(),
        content_assets_synced_commit: HEAD_COMMIT,
      });

      const ops = transaction.mock.calls[0][0] as { op: string }[];
      expect(ops.map(op => op.op)).toEqual(['stamp', 'rawUpsert', 'rawDelete']);
    });

    it('reads the tree at the repo default branch, not a hardcoded main', async () => {
      getDefaultBranch.mockResolvedValue('master');
      getTree.mockResolvedValue(tree([]));

      await syncContentAssets('class-1');

      expect(getLatestCommitSHA).toHaveBeenCalledWith('dartmouth-cs', 'content-cs101', 'master');
    });

    it('skips without reading the tree when the head is the commit the map is level with', async () => {
      classroomFindUnique.mockResolvedValue({
        ...CLASSROOM,
        content_assets_synced_commit: HEAD_COMMIT,
      });

      const result = await syncContentAssets('class-1');

      expect(result).toEqual({ mode: 'skipped', upserted: 0, deleted: 0, truncated: false });
      expect(getLatestCommitSHA).toHaveBeenCalledTimes(1);
      expect(getTree).not.toHaveBeenCalled();
      expect(transaction).not.toHaveBeenCalled();
    });

    it('reads the tree anyway when forced', async () => {
      classroomFindUnique.mockResolvedValue({
        ...CLASSROOM,
        content_assets_synced_commit: HEAD_COMMIT,
      });
      getTree.mockResolvedValue(tree([]));

      const result = await syncContentAssets('class-1', { force: true });

      expect(result.mode).toBe('full');
      expect(getTree).toHaveBeenCalledTimes(1);
    });

    it('reads a GitLab content project in its class subgroup and keeps its tree rows', async () => {
      classroomFindUnique.mockResolvedValue(GITLAB_CLASSROOM);
      classroomFindFirst.mockResolvedValue({ git_namespace: 'dartmouth/cs101' });
      getTree.mockResolvedValue({
        sha: HEAD_COMMIT,
        truncated: false,
        // GitLab's listing has no sizes.
        entries: [
          { path: 'slides', sha: 'slides-t', type: 'tree' },
          { path: 'slides/intro', sha: 'intro-t', type: 'tree' },
          { path: 'slides/intro/deck.json', sha: 'deck-b', type: 'blob' },
        ],
      });

      await syncContentAssets('class-1');

      expect(getLatestCommitSHA).toHaveBeenCalledWith('dartmouth/cs101', 'content-cs101', 'main');
      expect(getTree).toHaveBeenCalledWith('dartmouth/cs101', 'content-cs101', HEAD_COMMIT, true);
      expect(upsertedTypesOf()).toEqual(['tree', 'tree', 'blob']);
      expect(upsertedSizesOf()).toEqual([0, 0, 0]);
    });
  });

  describe('recordFolderTreesAfterCommit', () => {
    const COMMIT = 'c'.repeat(40);

    it('walks down from the root tree by sha and writes every folder walked', async () => {
      // GitHub: non-recursive reads by tree sha; names are relative.
      const trees: Record<string, { path: string; sha: string; type: string }[]> = {
        'root-t': [
          { path: 'slides', sha: 'slides-t', type: 'tree' },
          { path: 'README.md', sha: 'r', type: 'blob' },
        ],
        'slides-t': [{ path: 'intro', sha: 'intro-t', type: 'tree' }],
        'intro-t': [
          { path: 'blocks', sha: 'blocks-t', type: 'tree' },
          { path: 'deck.json', sha: 'd', type: 'blob' },
        ],
      };
      getTree.mockImplementation(async (_o: string, _r: string, sha: string) =>
        tree(trees[sha] ?? [])
      );
      executeRaw.mockResolvedValue(3);

      const found = await recordFolderTreesAfterCommit({
        classroomId: 'class-1',
        commit: COMMIT,
        rootTreeSha: 'root-t',
        folders: ['slides/intro', 'slides/intro/blocks/'],
      });

      expect(found).toEqual(
        new Map([
          ['slides/intro', 'intro-t'],
          ['slides/intro/blocks', 'blocks-t'],
        ])
      );
      // One read per level, shared between the two folders, never recursive.
      expect(getTree.mock.calls.map(call => [call[2], call[3]])).toEqual([
        ['root-t', false],
        ['slides-t', false],
        ['intro-t', false],
      ]);
      // Ancestors too: their tree shas moved with the commit. One stamp.
      expect(executeRaw).toHaveBeenCalledTimes(1);
      const [strings, classroomId, stamp, paths, shas] = executeRaw.mock.calls[0];
      expect(classroomId).toBe('class-1');
      expect(stamp).toBeInstanceOf(Date);
      expect(paths).toEqual(['slides', 'slides/intro', 'slides/intro/blocks']);
      expect(shas).toEqual(['slides-t', 'intro-t', 'blocks-t']);
      const sql = (strings as TemplateStringsArray).join('?');
      expect(sql).toContain("'tree'");
      expect(sql).toContain('WHERE content_assets.synced_at < EXCLUDED.synced_at');
    });

    it('starts at the commit when no root tree sha is given', async () => {
      getTree.mockResolvedValue(tree([{ path: 'slides', sha: 'slides-t', type: 'tree' }]));
      executeRaw.mockResolvedValue(1);

      const found = await recordFolderTreesAfterCommit({
        classroomId: 'class-1',
        commit: COMMIT,
        folders: ['slides'],
      });

      expect(getTree).toHaveBeenCalledWith('dartmouth-cs', 'content-cs101', COMMIT, false);
      expect(found.get('slides')).toBe('slides-t');
    });

    it('lists GitLab folders by path at the commit', async () => {
      classroomFindUnique.mockResolvedValue(GITLAB_CLASSROOM);
      classroomFindFirst.mockResolvedValue({ git_namespace: 'dartmouth/cs101' });
      const byPath: Record<string, { path: string; sha: string; type: string }[]> = {
        '': [{ path: 'slides', sha: 'slides-t', type: 'tree' }],
        slides: [{ path: 'slides/intro', sha: 'intro-t', type: 'tree' }],
      };
      getTree.mockImplementation(
        async (_o: string, _r: string, _ref: string, _rec: boolean, opts?: { path?: string }) =>
          tree(byPath[opts?.path ?? ''] ?? [])
      );
      executeRaw.mockResolvedValue(2);

      const found = await recordFolderTreesAfterCommit({
        classroomId: 'class-1',
        commit: COMMIT,
        folders: ['slides/intro'],
      });

      expect(found).toEqual(new Map([['slides/intro', 'intro-t']]));
      expect(getTree.mock.calls).toEqual([
        ['dartmouth/cs101', 'content-cs101', COMMIT, false, { path: undefined }],
        ['dartmouth/cs101', 'content-cs101', COMMIT, false, { path: 'slides' }],
      ]);
    });

    it('retries a 404 once, then succeeds', async () => {
      vi.useFakeTimers();
      try {
        getTree
          .mockRejectedValueOnce(Object.assign(new Error('Not Found'), { status: 404 }))
          .mockResolvedValueOnce(tree([{ path: 'slides', sha: 'slides-t', type: 'tree' }]));
        executeRaw.mockResolvedValue(1);

        const pending = recordFolderTreesAfterCommit({
          classroomId: 'class-1',
          commit: COMMIT,
          rootTreeSha: 'root-t',
          folders: ['slides'],
        });
        await vi.runAllTimersAsync();

        expect((await pending).get('slides')).toBe('slides-t');
        expect(getTree).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it('gives up after the one retry without throwing, and writes nothing', async () => {
      vi.useFakeTimers();
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        getTree.mockRejectedValue(Object.assign(new Error('Not Found'), { status: 404 }));

        const pending = recordFolderTreesAfterCommit({
          classroomId: 'class-1',
          commit: COMMIT,
          rootTreeSha: 'root-t',
          folders: ['slides'],
        });
        await vi.runAllTimersAsync();

        expect((await pending).size).toBe(0);
        expect(getTree).toHaveBeenCalledTimes(2);
        expect(executeRaw).not.toHaveBeenCalled();
      } finally {
        warn.mockRestore();
        vi.useRealTimers();
      }
    });

    it('leaves out a folder that is not in the tree, still recording its walked ancestors', async () => {
      getTree.mockImplementation(async (_o: string, _r: string, sha: string) =>
        tree(sha === 'root-t' ? [{ path: 'slides', sha: 'slides-t', type: 'tree' }] : [])
      );
      executeRaw.mockResolvedValue(1);

      const found = await recordFolderTreesAfterCommit({
        classroomId: 'class-1',
        commit: COMMIT,
        rootTreeSha: 'root-t',
        folders: ['slides/missing'],
      });

      expect(found.size).toBe(0);
      expect(executeRaw.mock.calls[0][3]).toEqual(['slides']);
    });

    it('refuses the repo root and dot segments without reading anything', async () => {
      const found = await recordFolderTreesAfterCommit({
        classroomId: 'class-1',
        commit: COMMIT,
        folders: ['', '/', 'slides/../pages', './slides'],
      });

      expect(found.size).toBe(0);
      expect(classroomFindUnique).not.toHaveBeenCalled();
      expect(getTree).not.toHaveBeenCalled();
    });

    it('does nothing for a classroom the delivery layer cannot serve', async () => {
      classroomFindUnique.mockResolvedValue({
        ...CLASSROOM,
        git_organization: { ...CLASSROOM.git_organization, github_installation_id: null },
      });

      const found = await recordFolderTreesAfterCommit({
        classroomId: 'class-1',
        commit: COMMIT,
        folders: ['slides/intro'],
      });

      expect(found.size).toBe(0);
      expect(getTree).not.toHaveBeenCalled();
    });
  });

  describe('syncContentAssetsForRepo', () => {
    it('syncs the classroom that owns the repo', async () => {
      // What a theme save needs. A theme is delivered by the SHA of its TREE,
      // so until the map is rebuilt every deck keeps signing the PREVIOUS tree
      // and the edge keeps serving the previous CSS — the author reloads and
      // their change has not taken.
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

    it('no-ops for a GitHub org with no App installation, without calling GitHub', async () => {
      // The shape `content_delivery_enabled @default(true)` made ordinary: a
      // GitHub Classroom import leaves `github_installation_id` null, and every
      // example classroom is backed by a mock org that has none BY DESIGN. The
      // App cannot mint a token for such an org, so `getGitProvider` throws
      // before a byte is read — three doomed API calls per render if this were
      // caught rather than checked.
      classroomFindUnique.mockResolvedValue({
        ...CLASSROOM,
        git_organization: { ...CLASSROOM.git_organization, github_installation_id: null },
      });

      await expect(ensureContentAssets('class-1', { maxAgeMs: 60_000 })).resolves.toBeNull();
      expect(getTree).not.toHaveBeenCalled();
    });
  });

  describe('ensureContentAssetsOutcome', () => {
    const DAY = 24 * 60 * 60 * 1000;

    // `mapIsTrustworthy` is what the resolvers read to decide whether a MISSING
    // row means "the repo does not have this file" (serve a /missing/
    // placeholder) or "we do not know" (serve the stored legacy reference).
    // Getting it wrong on an empty map turns every image on the page into a 404.

    it('does not trust an empty map when the org has no App installation', async () => {
      classroomFindUnique.mockResolvedValue({
        ...CLASSROOM,
        git_organization: { ...CLASSROOM.git_organization, github_installation_id: null },
      });

      await expect(ensureContentAssetsOutcome('class-1', { maxAgeMs: 60_000 })).resolves.toEqual({
        result: null,
        mapIsTrustworthy: false,
      });
    });

    it('does not trust the map of a classroom the layer cannot serve at all', async () => {
      classroomFindUnique.mockResolvedValue({
        ...CLASSROOM,
        git_organization: { ...CLASSROOM.git_organization, provider: 'GITLAB' },
      });

      await expect(ensureContentAssetsOutcome('class-1', { maxAgeMs: 60_000 })).resolves.toEqual({
        result: null,
        mapIsTrustworthy: false,
      });
    });

    it('trusts the map after a full sync completes', async () => {
      getTree.mockResolvedValue({ sha: 'r', truncated: false, entries: [] });

      const outcome = await ensureContentAssetsOutcome('class-1', { maxAgeMs: 60_000 });

      expect(outcome.mapIsTrustworthy).toBe(true);
      expect(outcome.result?.mode).toBe('full');
    });

    it('trusts a fresh map that needed no sync', async () => {
      classroomFindUnique.mockResolvedValue(syncedAgo(1_000));

      await expect(ensureContentAssetsOutcome('class-1', { maxAgeMs: DAY })).resolves.toEqual({
        result: null,
        mapIsTrustworthy: true,
      });
      expect(getTree).not.toHaveBeenCalled();
    });

    it('still trusts a STALE map whose refresh failed — stale is not fictional', async () => {
      classroomFindUnique.mockResolvedValue(syncedAgo(2 * DAY));
      getTree.mockRejectedValue(new Error('API rate limit exceeded'));
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

      await expect(ensureContentAssetsOutcome('class-1', { maxAgeMs: DAY })).resolves.toEqual({
        result: null,
        mapIsTrustworthy: true,
      });
      warn.mockRestore();
    });

    it('does NOT trust a never-synced map whose first sync failed', async () => {
      // The asymmetry with the case above is the whole point: there is no
      // previous map to be stale, so every reference on the page would miss.
      classroomFindUnique.mockResolvedValue({ ...CLASSROOM, content_assets_synced_at: null });
      getTree.mockRejectedValue(new Error('API rate limit exceeded'));
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

      await expect(ensureContentAssetsOutcome('class-1', { maxAgeMs: DAY })).resolves.toEqual({
        result: null,
        mapIsTrustworthy: false,
      });
      warn.mockRestore();
    });
  });

  describe('removeContentAssets', () => {
    it('forgets exactly the paths it is given', async () => {
      // Blobs are content-addressed and immutable, so a row that outlives its
      // file keeps serving that file's last bytes out of R2 — a deleted page
      // that still renders.
      contentAssetDeleteMany.mockResolvedValue({ count: 2 });

      await expect(
        removeContentAssets('class-1', ['pages/gone/content.json', 'pages/gone/index.html'])
      ).resolves.toBe(true);

      expect(contentAssetDeleteMany).toHaveBeenCalledWith({
        where: {
          classroom_id: 'class-1',
          path: { in: ['pages/gone/content.json', 'pages/gone/index.html'] },
        },
      });
    });

    it('sends nothing for an empty list', async () => {
      await expect(removeContentAssets('class-1', [])).resolves.toBe(true);
      expect(contentAssetDeleteMany).not.toHaveBeenCalled();
    });

    it('never throws — the sweep is the backstop', async () => {
      contentAssetDeleteMany.mockRejectedValue(new Error('connection terminated'));
      await expect(removeContentAssets('class-1', ['a.png'])).resolves.toBe(false);
    });
  });

  describe('removeContentAssetFolder', () => {
    it('matches the folder itself and everything under it', async () => {
      // The folder row matters: theme folders are addressed by their TREE sha,
      // so leaving one keeps a deleted theme resolvable.
      contentAssetDeleteMany.mockResolvedValue({ count: 5 });

      await removeContentAssetFolder('class-1', 'slides/lecture-1');

      expect(contentAssetDeleteMany).toHaveBeenCalledWith({
        where: {
          classroom_id: 'class-1',
          OR: [{ path: 'slides/lecture-1' }, { path: { startsWith: 'slides/lecture-1/' } }],
        },
      });
    });

    it('refuses a prefix that would match the whole map', async () => {
      // The failure mode is not subtle: an empty prefix empties the classroom.
      for (const folder of ['', '/', '///']) {
        expect(await removeContentAssetFolder('class-1', folder)).toBe(false);
      }
      expect(contentAssetDeleteMany).not.toHaveBeenCalled();
    });

    it('does not let a trailing slash widen the match', async () => {
      contentAssetDeleteMany.mockResolvedValue({ count: 0 });

      await removeContentAssetFolder('class-1', 'pages/lab-1/');

      expect(contentAssetDeleteMany.mock.calls[0][0].where.OR).toEqual([
        { path: 'pages/lab-1' },
        { path: { startsWith: 'pages/lab-1/' } },
      ]);
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

      expect(classroomUpdateMany).not.toHaveBeenCalled();
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

/**
 * The path index the import and the deck duplicate ask "did this file come
 * along?" of, for everything the copy itself did not just write.
 */
describe('listContentAssetPaths', () => {
  beforeEach(() => {
    contentAssetFindMany.mockReset();
  });

  it('returns the classroom’s file paths as a set, excluding trees', async () => {
    contentAssetFindMany.mockResolvedValue([
      { path: 'pages/lab-1/content.json' },
      { path: 'slides/intro/index.html' },
    ]);

    const paths = await listContentAssetPaths('class-1');

    expect(paths).toBeInstanceOf(Set);
    expect([...paths].sort()).toEqual(['pages/lab-1/content.json', 'slides/intro/index.html']);
    // A directory is not a file a reference can resolve to: signing a tree sha
    // as a blob mints a URL the Worker cannot serve.
    const [args] = contentAssetFindMany.mock.calls[0] as [
      { where: { classroom_id: string; type: string }; select: Record<string, boolean> },
    ];
    expect(args.where).toEqual({ classroom_id: 'class-1', type: 'blob' });
    expect(args.select).toEqual({ path: true });
  });

  it('returns an empty set for a classroom with no rows', async () => {
    contentAssetFindMany.mockResolvedValue([]);
    await expect(listContentAssetPaths('class-empty')).resolves.toEqual(new Set());
  });
});
