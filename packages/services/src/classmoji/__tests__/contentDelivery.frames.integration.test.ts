/**
 * Frame grants (`createFrameSigner` / `signFrameGrant`) against a REAL
 * Postgres: which folders a frame's signed URL opens, which it never opens,
 * and that every folder comes out of the signing classroom's own map.
 *
 * Two classrooms, X and Y, each with a deck. The git provider is mocked (it
 * is only reached for a folder the map lacks); nothing reaches GitHub.
 *
 * SAFETY: fixtures are namespaced with a fresh uuid and torn down in
 * `afterAll` (deleting the git organizations cascades classroom → slides,
 * pages, content_assets). Skipped unless DATABASE_URL names a LOCAL database
 * other than the shared dev one; `CONTENT_ASSETS_INTEGRATION=1` opts in there.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';

const DATABASE_URL = process.env.DATABASE_URL ?? '';
const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(DATABASE_URL);
const isSharedDevDb = /\/classmoji(\?|$)/.test(DATABASE_URL);
const optedIn = process.env.CONTENT_ASSETS_INTEGRATION === '1';
const RUN = Boolean(DATABASE_URL) && isLocal && (!isSharedDevDb || optedIn);

const getTree = vi.fn();
vi.mock('../../git/index.ts', () => ({
  getGitProvider: () => ({
    getTree,
    getLatestCommitSHA: vi.fn(),
    getDefaultBranch: vi.fn(async () => 'main'),
  }),
}));

const getPrisma = (await import('@classmoji/database')).default;
const { createFrameSigner, signFrameGrant } = await import('../contentDelivery.service.ts');
const { parseFilesUrl, verifyFilesUrl } = await import('@classmoji/content-signing');

const ORIGIN = 'https://content.classmoji.test';
const MASTER = 'frames-integration-secret';
const COMMIT = 'c'.repeat(40);
const sha = (n: number) => n.toString(16).padStart(40, '0');

describe.skipIf(!RUN)('frame grants (integration)', () => {
  const suite = randomUUID().slice(0, 8);
  const prisma = getPrisma();
  const orgIds: string[] = [];
  let userId: string;
  const X = { id: '', deck: `slides/deck-x-${suite}` };
  const Y = { id: '', deck: `slides/deck-y-${suite}` };

  const classroomCtx = (id: string, login: string, repo: string) => ({
    id,
    content_key_version: 2,
    content_repo: repo,
    content_delivery_enabled: true,
    git_organization: { login },
  });
  let ctxX: ReturnType<typeof classroomCtx>;
  let ctxY: ReturnType<typeof classroomCtx>;

  const folders = async (url: string | null) => {
    expect(url).not.toBeNull();
    const verified = await verifyFilesUrl(MASTER, url as string);
    if (!verified.ok) throw new Error(`did not verify: ${verified.reason}`);
    return verified;
  };

  async function makeClassroom(tag: string, deck: string) {
    const org = await prisma.gitOrganization.create({
      data: {
        provider: 'GITHUB',
        provider_id: `frames-${tag}-${suite}`,
        login: `frames-${tag}-${suite}`,
        github_installation_id: `inst-${tag}-${suite}`,
      },
    });
    orgIds.push(org.id);
    const classroom = await prisma.classroom.create({
      data: {
        slug: `frames-${tag}-${suite}`,
        git_org_id: org.id,
        name: `Frames ${tag} ${suite}`,
        content_namespace: `frames-${tag}-${suite}`,
        content_repo: `content-frames-${tag}-${suite}`,
        content_assets_synced_at: new Date(),
        content_assets_synced_commit: COMMIT,
      },
    });
    await prisma.slide.create({
      data: {
        classroom_id: classroom.id,
        title: 'Deck',
        slug: `deck-${tag}`,
        content_path: deck,
        created_by: userId,
      },
    });
    return { classroom, org };
  }

  beforeAll(async () => {
    process.env.CONTENT_DELIVERY_ORIGIN = ORIGIN;
    process.env.CONTENT_SIGNING_SECRET = MASTER;
    userId = (await prisma.user.create({ data: { name: `frames-${suite}` } })).id;

    const x = await makeClassroom('x', X.deck);
    const y = await makeClassroom('y', Y.deck);
    X.id = x.classroom.id;
    Y.id = y.classroom.id;
    ctxX = classroomCtx(X.id, x.org.login, x.classroom.content_repo!);
    ctxY = classroomCtx(Y.id, y.org.login, y.classroom.content_repo!);

    // X's other content: another deck, a FILE slide, a page.
    await prisma.slide.create({
      data: {
        classroom_id: X.id,
        title: 'Other',
        slug: 'other',
        content_path: `slides/other-${suite}`,
        created_by: userId,
      },
    });
    await prisma.slide.create({
      data: {
        classroom_id: X.id,
        title: 'Handout',
        slug: 'handout',
        kind: 'FILE',
        content_path: `slides/handout-${suite}`,
        source_path: `docs/handout/notes.pdf`,
        created_by: userId,
      },
    });
    await prisma.page.create({
      data: {
        classroom_id: X.id,
        title: 'Lab',
        content_path: `pages/lab-${suite}`,
        created_by: userId,
      },
    });

    const tree = (classroomId: string, path: string, n: number) => ({
      classroom_id: classroomId,
      path,
      sha: sha(n),
      type: 'tree',
      synced_at: new Date(),
    });
    await prisma.contentAsset.createMany({
      data: [
        tree(X.id, X.deck, 1),
        tree(X.id, `${X.deck}/blocks`, 2),
        tree(X.id, `${X.deck}/games`, 3),
        tree(X.id, `${X.deck}/games/snake`, 4),
        tree(X.id, 'games', 5),
        tree(X.id, 'games/sketchkit', 6),
        tree(X.id, '.github', 7),
        tree(X.id, '.github/workflows', 8),
        tree(X.id, `slides/other-${suite}`, 9),
        tree(X.id, `slides/other-${suite}/games`, 10),
        tree(X.id, 'docs', 11),
        tree(X.id, 'docs/handout', 12),
        tree(X.id, `pages/lab-${suite}`, 13),
        // Y holds the same folder names under its own deck, and one X lacks.
        tree(Y.id, Y.deck, 21),
        tree(Y.id, `${Y.deck}/blocks`, 22),
        tree(Y.id, 'games/sketchkit', 26),
        tree(Y.id, 'only-in-y', 27),
      ],
    });
  });

  afterAll(async () => {
    for (const id of orgIds) {
      await prisma.gitOrganization.delete({ where: { id } }).catch(() => {});
    }
    if (userId) await prisma.user.delete({ where: { id: userId } }).catch(() => {});
  });

  beforeEach(() => {
    getTree.mockReset();
  });

  it("opens the deck's subfolders, never the deck folder, for a frame inside one", async () => {
    const url = await signFrameGrant({
      classroom: ctxX,
      deckFolder: X.deck,
      repoPath: `${X.deck}/games/snake/index.html`,
      query: '?level=2',
      isPublic: false,
    });
    const verified = await folders(url);
    expect(verified.classroomId).toBe(X.id);
    expect(verified.tier).toBe('week');
    expect(verified.folders).toEqual([
      { path: `${X.deck}/blocks`, treeSha: sha(2) },
      { path: `${X.deck}/games`, treeSha: sha(3) },
    ]);
    const parts = parseFilesUrl(url as string);
    expect(parts?.repoPath).toBe(`${X.deck}/games/snake/index.html`);
    expect(parts?.query).toBe('?level=2');
  });

  it('adds the folder of a target outside the deck; month for a public deck', async () => {
    const url = await signFrameGrant({
      classroom: ctxX,
      deckFolder: X.deck,
      repoPath: 'games/sketchkit/draw.html',
      query: '?deck=x',
      isPublic: true,
    });
    const verified = await folders(url);
    expect(verified.tier).toBe('month');
    // Sorted by path, as every grant is.
    expect(verified.folders).toEqual([
      { path: 'games/sketchkit', treeSha: sha(6) },
      { path: `${X.deck}/blocks`, treeSha: sha(2) },
      { path: `${X.deck}/games`, treeSha: sha(3) },
    ]);
  });

  it('opens the deck folder alone only for a frame directly in it', async () => {
    const verified = await folders(
      await signFrameGrant({
        classroom: ctxX,
        deckFolder: X.deck,
        repoPath: `${X.deck}/demo.html`,
        isPublic: false,
      })
    );
    expect(verified.folders).toEqual([{ path: X.deck, treeSha: sha(1) }]);
  });

  it('refuses documents, the root, reserved folders and other items', async () => {
    const signer = createFrameSigner({ classroom: ctxX, deckFolder: X.deck, isPublic: false });
    for (const repoPath of [
      `${X.deck}/index.html`,
      `${X.deck}/deck.json`,
      `pages/lab-${suite}/content.json`,
      'index.html',
      '.github/workflows/x.html',
      `slides/other-${suite}/index.html`,
      `slides/other-${suite}/demo.html`,
      `pages/lab-${suite}/demo.html`,
      'docs/x.html',
      'slides/x.html',
    ]) {
      expect(await signer.sign(repoPath), repoPath).toBeNull();
    }
    // Another deck's subfolder is allowed: the author chose to embed it.
    expect(await signer.sign(`slides/other-${suite}/games/a.html`)).not.toBeNull();
  });

  it('classroom X vs Y: a folder only Y has is never signed for X', async () => {
    getTree.mockResolvedValue({ sha: 'root', truncated: false, entries: [] });
    expect(
      await signFrameGrant({
        classroom: ctxX,
        deckFolder: X.deck,
        repoPath: 'only-in-y/game.html',
        isPublic: false,
      })
    ).toBeNull();
    // Y's own deck signs with Y's rows, under Y's id.
    const verified = await folders(
      await signFrameGrant({
        classroom: ctxY,
        deckFolder: Y.deck,
        repoPath: 'games/sketchkit/draw.html',
        isPublic: false,
      })
    );
    expect(verified.classroomId).toBe(Y.id);
    expect(verified.folders).toEqual([
      { path: 'games/sketchkit', treeSha: sha(26) },
      { path: `${Y.deck}/blocks`, treeSha: sha(22) },
    ]);
  });

  it("X's deck folder signed under Y's classroom finds nothing of X's", async () => {
    expect(
      await signFrameGrant({
        classroom: ctxY,
        deckFolder: X.deck,
        repoPath: `${X.deck}/games/snake/index.html`,
        isPublic: false,
      })
    ).toBeNull();
  });

  it('reads a folder the map lacks once at the synced commit, and writes it through', async () => {
    const folder = `${X.deck}/fresh`;
    getTree.mockImplementation(async (_owner: string, _repo: string, ref: string) => {
      const listings: Record<string, { path: string; sha: string; type: string }[]> = {
        [COMMIT]: [{ path: 'slides', sha: sha(30), type: 'tree' }],
        [sha(30)]: [{ path: `deck-x-${suite}`, sha: sha(31), type: 'tree' }],
        [sha(31)]: [{ path: 'fresh', sha: sha(32), type: 'tree' }],
      };
      return { sha: ref, truncated: false, entries: listings[ref] ?? [] };
    });

    const verified = await folders(
      await signFrameGrant({
        classroom: ctxX,
        deckFolder: X.deck,
        repoPath: `${folder}/game.html`,
        isPublic: false,
      })
    );
    expect(verified.folders.map(f => f.path)).toContain(folder);
    const row = await prisma.contentAsset.findFirst({
      where: { classroom_id: X.id, path: folder, type: 'tree' },
    });
    expect(row?.sha).toBe(sha(32));
  });

  it('a missing folder is read at most once per synced commit', async () => {
    getTree.mockResolvedValue({ sha: 'root', truncated: false, entries: [] });
    const request = {
      classroom: ctxX,
      deckFolder: X.deck,
      repoPath: 'nowhere/game.html',
      isPublic: false,
    };
    expect(await signFrameGrant(request)).toBeNull();
    const calls = getTree.mock.calls.length;
    expect(calls).toBeGreaterThan(0);
    expect(await signFrameGrant(request)).toBeNull();
    expect(getTree.mock.calls.length).toBe(calls);
  });

  it('nothing is signed with the layer switched off for the classroom', async () => {
    expect(
      await signFrameGrant({
        classroom: { ...ctxX, content_delivery_enabled: false },
        deckFolder: X.deck,
        repoPath: `${X.deck}/games/snake/index.html`,
        isPublic: false,
      })
    ).toBeNull();
  });
});
