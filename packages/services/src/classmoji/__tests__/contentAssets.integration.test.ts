/**
 * The asset map's tree sync and folder write-through against a REAL Postgres.
 *
 * The unit suite checks what the statements SAY; this checks what they DO,
 * which is where the guarantees live: an unchanged row is not rewritten, the
 * trees above a changed file move, a row a newer writer holds is neither
 * overwritten nor deleted by an older run, a truncated listing deletes
 * nothing, and an older run finishing late cannot move the classroom's commit
 * backwards. The git provider is mocked; nothing reaches GitHub.
 *
 * SAFETY: every fixture is namespaced with a fresh uuid and torn down in
 * `afterAll` by deleting the git organization, which cascades classroom →
 * content_assets. Skipped unless DATABASE_URL names a LOCAL database other
 * than the shared dev one (see contentIndex.integration.test.ts);
 * `CONTENT_ASSETS_INTEGRATION=1` opts in there.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';

const DATABASE_URL = process.env.DATABASE_URL ?? '';
const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(DATABASE_URL);
const isSharedDevDb = /\/classmoji(\?|$)/.test(DATABASE_URL);
const optedIn = process.env.CONTENT_ASSETS_INTEGRATION === '1';
const RUN = Boolean(DATABASE_URL) && isLocal && (!isSharedDevDb || optedIn);

type Entry = { path: string; sha: string; type: string; size?: number };

const getTree = vi.fn();
const getLatestCommitSHA = vi.fn();
const getDefaultBranch = vi.fn(async () => 'main');
vi.mock('../../git/index.ts', () => ({
  getGitProvider: () => ({ getTree, getLatestCommitSHA, getDefaultBranch }),
}));

const getPrisma = (await import('@classmoji/database')).default;
const { syncContentAssets, recordFolderTreesAfterCommit } =
  await import('../contentAssets.service.ts');

const C1 = '1'.repeat(40);
const C2 = '2'.repeat(40);
const C3 = '3'.repeat(40);

/** A whole recursive listing at one commit. */
const listing = (entries: Entry[], truncated = false) => ({ sha: 'root', truncated, entries });

const BASE: Entry[] = [
  { path: 'slides', sha: 'slides-1', type: 'tree' },
  { path: 'slides/intro', sha: 'intro-1', type: 'tree' },
  { path: 'slides/intro/deck.json', sha: 'deck-1', type: 'blob', size: 10 },
  { path: 'slides/intro/blocks', sha: 'blocks-1', type: 'tree' },
  { path: 'slides/intro/blocks/a.html', sha: 'a-1', type: 'blob', size: 20 },
  { path: 'images', sha: 'images-1', type: 'tree' },
  { path: 'images/logo.png', sha: 'logo-1', type: 'blob', size: 30 },
];

describe.skipIf(!RUN)('contentAssets (integration)', () => {
  const suite = randomUUID().slice(0, 8);
  const prisma = getPrisma();
  let orgId: string;
  let classroomId: string;

  const rows = async () => {
    const found = await prisma.contentAsset.findMany({
      where: { classroom_id: classroomId },
      select: { path: true, sha: true, type: true, synced_at: true },
      orderBy: { path: 'asc' },
    });
    return new Map(found.map(row => [row.path, row]));
  };
  const classroomState = () =>
    prisma.classroom.findUniqueOrThrow({
      where: { id: classroomId },
      select: { content_assets_synced_at: true, content_assets_synced_commit: true },
    });

  /** Make the repo's head `commit` with this listing. */
  const repoAt = (commit: string, entries: Entry[], truncated = false) => {
    getLatestCommitSHA.mockResolvedValue(commit);
    getTree.mockResolvedValue(listing(entries, truncated));
  };

  beforeAll(async () => {
    const org = await prisma.gitOrganization.create({
      data: {
        provider: 'GITHUB',
        provider_id: `cassets-${suite}`,
        login: `cassets-org-${suite}`,
        github_installation_id: `inst-${suite}`,
      },
    });
    orgId = org.id;
    const classroom = await prisma.classroom.create({
      data: {
        slug: `cassets-${suite}`,
        git_org_id: orgId,
        name: `Content Assets ${suite}`,
        content_namespace: `cassets-${suite}`,
        content_repo: `content-cassets-${suite}`,
      },
    });
    classroomId = classroom.id;
  });

  afterAll(async () => {
    if (orgId) await prisma.gitOrganization.delete({ where: { id: orgId } }).catch(() => {});
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    getDefaultBranch.mockResolvedValue('main');
    await prisma.contentAsset.deleteMany({ where: { classroom_id: classroomId } });
    await prisma.classroom.update({
      where: { id: classroomId },
      data: { content_assets_synced_at: null, content_assets_synced_commit: null },
    });
  });

  it('updates the trees above a changed file and leaves unchanged rows alone', async () => {
    repoAt(C1, BASE);
    const first = await syncContentAssets(classroomId);
    expect(first).toMatchObject({ mode: 'full', upserted: BASE.length, deleted: 0 });
    const before = await rows();

    // An ordinary push editing one block file: that file and every tree above
    // it move; nothing else does.
    repoAt(
      C2,
      BASE.map(
        entry =>
          ({
            slides: { ...entry, sha: 'slides-2' },
            'slides/intro': { ...entry, sha: 'intro-2' },
            'slides/intro/blocks': { ...entry, sha: 'blocks-2' },
            'slides/intro/blocks/a.html': { ...entry, sha: 'a-2' },
          })[entry.path] ?? entry
      )
    );
    const second = await syncContentAssets(classroomId);
    const after = await rows();

    expect(second).toMatchObject({ mode: 'full', upserted: 4, deleted: 0 });
    expect(after.get('slides/intro/blocks')?.sha).toBe('blocks-2');
    expect(after.get('slides/intro')?.sha).toBe('intro-2');
    expect(after.get('slides')?.sha).toBe('slides-2');
    // Unchanged rows were not rewritten — not even their stamp.
    for (const path of ['slides/intro/deck.json', 'images', 'images/logo.png']) {
      expect(after.get(path)?.synced_at.getTime()).toBe(before.get(path)?.synced_at.getTime());
    }
    expect((await classroomState()).content_assets_synced_commit).toBe(C2);
  });

  it('deletes rows for paths that left the repo, by the path set', async () => {
    repoAt(C1, BASE);
    await syncContentAssets(classroomId);

    repoAt(
      C2,
      BASE.filter(entry => !entry.path.startsWith('images'))
    );
    const result = await syncContentAssets(classroomId);

    expect(result.deleted).toBe(2);
    const after = await rows();
    expect(after.has('images')).toBe(false);
    expect(after.has('images/logo.png')).toBe(false);
    // Unchanged, old-stamped rows still in the tree are kept.
    expect(after.has('slides/intro/deck.json')).toBe(true);
  });

  it('skips when the head is the recorded commit', async () => {
    repoAt(C1, BASE);
    await syncContentAssets(classroomId);
    getTree.mockClear();

    const result = await syncContentAssets(classroomId);

    expect(result.mode).toBe('skipped');
    expect(getTree).not.toHaveBeenCalled();
  });

  it('an older run can neither overwrite nor delete a newer write-through', async () => {
    repoAt(C1, BASE);
    await syncContentAssets(classroomId);

    // A run whose head read predates a block-file commit; the commit's
    // write-through lands while that run's tree read is in flight.
    getLatestCommitSHA.mockResolvedValue(C2);
    getTree.mockImplementationOnce(async () => {
      // The write-through: the block commit added blocks/b.html, so the folder
      // trees moved. GitHub non-recursive reads by sha.
      const trees: Record<string, Entry[]> = {
        'root-3': [{ path: 'slides', sha: 'slides-3', type: 'tree' }],
        'slides-3': [{ path: 'intro', sha: 'intro-3', type: 'tree' }],
        'intro-3': [{ path: 'blocks', sha: 'blocks-3', type: 'tree' }],
      };
      getTree.mockImplementation(async (_o: string, _r: string, sha: string) =>
        listing(trees[sha] ?? [])
      );
      await new Promise(resolve => setTimeout(resolve, 5));
      const found = await recordFolderTreesAfterCommit({
        classroomId,
        commit: C3,
        rootTreeSha: 'root-3',
        folders: ['slides/intro/blocks'],
      });
      expect(found.get('slides/intro/blocks')).toBe('blocks-3');
      await prisma.contentAsset.create({
        data: {
          classroom_id: classroomId,
          path: 'slides/intro/blocks/b.html',
          sha: 'b-3',
          type: 'blob',
          synced_at: new Date(),
        },
      });
      // ...and the older run's snapshot, which has neither.
      return listing(
        BASE.map(entry =>
          entry.path === 'slides/intro/blocks/a.html' ? { ...entry, sha: 'a-2' } : entry
        )
      );
    });

    await syncContentAssets(classroomId);
    const after = await rows();

    // Not overwritten back to the older snapshot's tree shas...
    expect(after.get('slides')?.sha).toBe('slides-3');
    expect(after.get('slides/intro')?.sha).toBe('intro-3');
    expect(after.get('slides/intro/blocks')?.sha).toBe('blocks-3');
    // ...not deleted though the older snapshot lacks it...
    expect(after.get('slides/intro/blocks/b.html')?.sha).toBe('b-3');
    // ...while what the snapshot did change still lands.
    expect(after.get('slides/intro/blocks/a.html')?.sha).toBe('a-2');
  });

  it('an older run finishing late does not move the classroom commit backwards', async () => {
    repoAt(C1, BASE);
    await syncContentAssets(classroomId);

    // Run A reads head C2, then stalls in its tree read while run B reads C3
    // and finishes.
    getLatestCommitSHA.mockResolvedValueOnce(C2);
    getTree.mockImplementationOnce(async () => {
      await new Promise(resolve => setTimeout(resolve, 5));
      getLatestCommitSHA.mockResolvedValueOnce(C3);
      getTree.mockResolvedValueOnce(listing(BASE));
      await syncContentAssets(classroomId);
      return listing(BASE);
    });

    await syncContentAssets(classroomId);

    expect((await classroomState()).content_assets_synced_commit).toBe(C3);
  });

  it('an older run that commits after a newer one writes no rows', async () => {
    // C1: the base, plus a file only C2 still has after C3 deletes it.
    const old = { path: 'images/old.png', sha: 'old-1', type: 'blob', size: 5 };
    repoAt(C1, [...BASE, old]);
    await syncContentAssets(classroomId);

    // C2 (run A's snapshot): logo.png removed, a.html changed.
    const atC2 = [...BASE, old]
      .filter(entry => entry.path !== 'images/logo.png')
      .map(entry =>
        entry.path === 'slides/intro/blocks/a.html' ? { ...entry, sha: 'a-2' } : entry
      );
    // C3 (run B's snapshot): old.png deleted, logo.png back exactly as at C1,
    // a.html changed again.
    const atC3 = BASE.map(entry =>
      entry.path === 'slides/intro/blocks/a.html' ? { ...entry, sha: 'a-3' } : entry
    );

    // Run A stamps first and reads C2; it stalls until run B has finished.
    let resultB: Awaited<ReturnType<typeof syncContentAssets>> | undefined;
    getLatestCommitSHA.mockResolvedValueOnce(C2);
    getTree.mockImplementationOnce(async () => {
      await new Promise(resolve => setTimeout(resolve, 5));
      getLatestCommitSHA.mockResolvedValueOnce(C3);
      getTree.mockResolvedValueOnce(listing(atC3));
      resultB = await syncContentAssets(classroomId);
      return listing(atC2);
    });

    const resultA = await syncContentAssets(classroomId);
    const after = await rows();

    expect(resultB).toMatchObject({ mode: 'full', deleted: 1 });
    expect(resultA).toMatchObject({ mode: 'full', upserted: 0, deleted: 0 });
    // B deleted it; A's older tree still had it, and does not bring it back.
    expect(after.has('images/old.png')).toBe(false);
    // Unchanged since C1 and absent from A's tree: A does not delete it.
    expect(after.get('images/logo.png')?.sha).toBe('logo-1');
    // Changed by both: B's.
    expect(after.get('slides/intro/blocks/a.html')?.sha).toBe('a-3');
    expect([...after.keys()].sort()).toEqual(atC3.map(entry => entry.path).sort());
    expect((await classroomState()).content_assets_synced_commit).toBe(C3);
  });

  it("a reader's fill adds missing folders without holding back a sync in flight", async () => {
    repoAt(C1, BASE);
    await syncContentAssets(classroomId);
    const synced = (await classroomState()).content_assets_synced_at;
    // A folder the map lost (or never had), and one it holds.
    await prisma.contentAsset.delete({
      where: { classroom_id_path: { classroom_id: classroomId, path: 'slides/intro/blocks' } },
    });
    const before = await rows();

    // A sync run takes its stamp, then a reader fills the folder at C1 while
    // that run's tree read is in flight; the run's snapshot moved the folder.
    getLatestCommitSHA.mockResolvedValue(C2);
    getTree.mockImplementationOnce(async () => {
      const trees: Record<string, Entry[]> = {
        root: [{ path: 'slides', sha: 'slides-1', type: 'tree' }],
        'slides-1': [{ path: 'intro', sha: 'intro-1', type: 'tree' }],
        'intro-1': [{ path: 'blocks', sha: 'blocks-1', type: 'tree' }],
      };
      getTree.mockImplementation(async (_o: string, _r: string, sha: string) =>
        listing(trees[sha] ?? [])
      );
      const found = await recordFolderTreesAfterCommit({
        classroomId,
        commit: C1,
        rootTreeSha: 'root',
        folders: ['slides/intro/blocks'],
        fill: true,
      });
      expect(found.get('slides/intro/blocks')).toBe('blocks-1');
      const filled = await rows();
      // Added with the sync's stamp; rows it already had are untouched.
      expect(filled.get('slides/intro/blocks')?.synced_at.getTime()).toBe(synced?.getTime());
      expect(filled.get('slides/intro')?.synced_at.getTime()).toBe(
        before.get('slides/intro')?.synced_at.getTime()
      );
      return listing(
        BASE.map(entry =>
          entry.path === 'slides/intro/blocks' ? { ...entry, sha: 'blocks-2' } : entry
        )
      );
    });

    await syncContentAssets(classroomId);

    expect((await rows()).get('slides/intro/blocks')?.sha).toBe('blocks-2');
  });

  it('deletes nothing when the listing came back truncated', async () => {
    repoAt(C1, BASE);
    await syncContentAssets(classroomId);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    repoAt(C2, BASE.slice(0, 2), /* truncated */ true);
    const result = await syncContentAssets(classroomId);

    expect(result).toMatchObject({ truncated: true, deleted: 0 });
    expect((await rows()).size).toBe(BASE.length);
    expect((await classroomState()).content_assets_synced_commit).toBe(C2);
    warn.mockRestore();
  });

  it('write-through tree rows are guarded by their stamp', async () => {
    repoAt(C1, BASE);
    await syncContentAssets(classroomId);
    // A row someone stamped in the future (a newer writer) is left alone.
    const future = new Date(Date.now() + 60_000);
    await prisma.contentAsset.update({
      where: { classroom_id_path: { classroom_id: classroomId, path: 'slides' } },
      data: { sha: 'slides-newer', synced_at: future },
    });
    getTree.mockImplementation(async (_o: string, _r: string, sha: string) =>
      listing(
        sha === 'root-2'
          ? [{ path: 'slides', sha: 'slides-2', type: 'tree' }]
          : [{ path: 'intro', sha: 'intro-2', type: 'tree' }]
      )
    );

    const found = await recordFolderTreesAfterCommit({
      classroomId,
      commit: C2,
      rootTreeSha: 'root-2',
      folders: ['slides/intro'],
    });

    expect(found.get('slides/intro')).toBe('intro-2');
    const after = await rows();
    expect(after.get('slides/intro')?.sha).toBe('intro-2');
    expect(after.get('slides')?.sha).toBe('slides-newer');
  });
});
