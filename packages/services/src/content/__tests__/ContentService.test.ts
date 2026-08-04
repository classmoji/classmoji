import { describe, it, expect, vi, beforeEach } from 'vitest';

// Phase-0 plumbing tests for ContentService (moved here from @classmoji/content):
// - uploadBatch's extended return shape (per-file blob shas)
// - ref-bearing reads bypass the org:repo:path cache entirely (no serve, no store)
// - branch-writing put targets the branch and leaves main's cache untouched
// - createBranch / deleteBranch / mergeBranch thin wrappers over the Git
//   refs + merge APIs, with mergeBranch surfacing 409 conflicts distinctly.
// The git provider and Prisma are mocked; every test uses its own repo name so
// the module-level 60s response cache can't leak state between tests.

const requestMock = vi.fn();

vi.mock('../../git/index.ts', () => ({
  getGitProvider: () => ({
    getOctokit: async () => ({ request: (...args: unknown[]) => requestMock(...args) }),
  }),
}));

vi.mock('@classmoji/database', () => ({
  default: () => ({
    gitOrganization: {
      findFirst: vi.fn(),
    },
  }),
}));

const { ContentService } = await import('../ContentService.ts');

const gitOrganization = { provider: 'GITHUB', login: 'test-org' };

type RequestParams = Record<string, unknown> & { ref?: string; content?: string; path?: string };

/** Count calls to the Contents GET endpoint, split by ref-bearing vs main */
function contentsGetCalls() {
  const calls = requestMock.mock.calls.filter(
    ([route]) => route === 'GET /repos/{owner}/{repo}/contents/{path}'
  );
  return {
    total: calls.length,
    withRef: calls.filter(([, params]) => (params as RequestParams).ref !== undefined).length,
    withoutRef: calls.filter(([, params]) => (params as RequestParams).ref === undefined).length,
  };
}

beforeEach(() => {
  requestMock.mockReset();
});

describe('uploadBatch', () => {
  it('returns commit, filesUploaded, and per-file blob shas', async () => {
    requestMock.mockImplementation(async (route: string, params: RequestParams) => {
      switch (route) {
        case 'POST /repos/{owner}/{repo}/git/blobs': {
          // Derive a deterministic blob sha from the (base64) content
          const decoded = Buffer.from(String(params.content), 'base64').toString('utf-8');
          return { data: { sha: `blob-${decoded}` } };
        }
        case 'GET /repos/{owner}/{repo}/git/ref/{ref}':
          return { data: { object: { sha: 'head-commit' } } };
        case 'GET /repos/{owner}/{repo}/git/commits/{commit_sha}':
          return { data: { tree: { sha: 'base-tree' } } };
        case 'POST /repos/{owner}/{repo}/git/trees':
          return { data: { sha: 'new-tree' } };
        case 'POST /repos/{owner}/{repo}/git/commits':
          return { data: { sha: 'new-commit' } };
        case 'PATCH /repos/{owner}/{repo}/git/refs/{ref}':
          return { data: {} };
        default:
          throw new Error(`Unexpected route: ${route}`);
      }
    });

    const result = await ContentService.uploadBatch({
      gitOrganization,
      repo: 'repo-uploadbatch',
      files: [
        { path: 'pages/a/content.json', content: 'aaa' },
        { path: 'pages/a/index.html', content: 'bbb' },
      ],
      message: 'test batch',
    });

    expect(result).toEqual({
      commit: 'new-commit',
      filesUploaded: 2,
      files: [
        { path: 'pages/a/content.json', sha: 'blob-aaa' },
        { path: 'pages/a/index.html', sha: 'blob-bbb' },
      ],
    });
  });
});

describe('ref-bearing reads and the response cache', () => {
  it('getContent with ref bypasses the cache and does not poison main entries', async () => {
    const repo = 'repo-refcache-content';
    const path = 'pages/x/content.json';

    requestMock.mockImplementation(async (route: string, params: RequestParams) => {
      if (route !== 'GET /repos/{owner}/{repo}/contents/{path}') {
        throw new Error(`Unexpected route: ${route}`);
      }
      const body = params.ref ? 'branch-v1' : 'main-v1';
      const sha = params.ref ? 'sha-branch' : 'sha-main';
      return { data: { content: Buffer.from(body).toString('base64'), sha } };
    });

    // 1. Main read — hits the API and caches
    const main1 = await ContentService.getContent({ gitOrganization, repo, path });
    expect(main1).toEqual({ content: 'main-v1', sha: 'sha-main' });
    expect(contentsGetCalls().total).toBe(1);

    // 2. Ref read — must NOT be served from the main cache
    const branch = await ContentService.getContent({
      gitOrganization,
      repo,
      path,
      ref: 'preview/pages/x',
    });
    expect(branch).toEqual({ content: 'branch-v1', sha: 'sha-branch' });
    expect(contentsGetCalls().total).toBe(2);

    // 3. Main read again — served from cache (no new API call), and the ref
    //    read must not have replaced the cached main entry
    const main2 = await ContentService.getContent({ gitOrganization, repo, path });
    expect(main2).toEqual({ content: 'main-v1', sha: 'sha-main' });
    expect(contentsGetCalls().total).toBe(2);
  });

  it('getMeta with ref does not seed the main cache', async () => {
    const repo = 'repo-refcache-meta';
    const path = 'slides/y/deck.json';

    requestMock.mockImplementation(async (route: string, params: RequestParams) => {
      if (route !== 'GET /repos/{owner}/{repo}/contents/{path}') {
        throw new Error(`Unexpected route: ${route}`);
      }
      return params.ref
        ? { data: { sha: 'sha-branch', size: 20 } }
        : { data: { sha: 'sha-main', size: 10 } };
    });

    // Ref read first — must not populate the (main-keyed) cache
    const branchMeta = await ContentService.getMeta({
      gitOrganization,
      repo,
      path,
      ref: 'preview/slides/y',
    });
    expect(branchMeta).toEqual({ sha: 'sha-branch', size: 20 });

    // Main read — must hit the API (a cached branch result here would be poison)
    const mainMeta = await ContentService.getMeta({ gitOrganization, repo, path });
    expect(mainMeta).toEqual({ sha: 'sha-main', size: 10 });
    expect(contentsGetCalls()).toEqual({ total: 2, withRef: 1, withoutRef: 1 });
  });

  it('listFolder with ref bypasses the cache in both directions', async () => {
    const repo = 'repo-refcache-list';
    const path = 'pages';

    requestMock.mockImplementation(async (route: string, params: RequestParams) => {
      if (route !== 'GET /repos/{owner}/{repo}/contents/{path}') {
        throw new Error(`Unexpected route: ${route}`);
      }
      const name = params.ref ? 'branch-only.json' : 'main.json';
      return { data: [{ name, path: `${path}/${name}`, type: 'file', sha: `sha-${name}` }] };
    });

    const main1 = await ContentService.listFolder({ gitOrganization, repo, path });
    expect(main1[0]?.name).toBe('main.json');

    const branchList = await ContentService.listFolder({
      gitOrganization,
      repo,
      path,
      ref: 'preview/pages/z',
    });
    expect(branchList[0]?.name).toBe('branch-only.json');
    expect(contentsGetCalls().total).toBe(2);

    // Main again: cache hit (ref read neither served nor overwrote it)
    const main2 = await ContentService.listFolder({ gitOrganization, repo, path });
    expect(main2[0]?.name).toBe('main.json');
    expect(contentsGetCalls().total).toBe(2);
  });
});

describe('put with branch', () => {
  it('commits to the branch, checks shas on the branch, and leaves main cache entries alone', async () => {
    const repo = 'repo-branch-put';
    const path = 'pages/p/content.json';

    requestMock.mockImplementation(async (route: string, params: RequestParams) => {
      if (route === 'GET /repos/{owner}/{repo}/contents/{path}') {
        const body = params.ref ? 'branch-v1' : 'main-v1';
        const sha = params.ref ? 'sha-branch' : 'sha-main';
        return { data: { content: Buffer.from(body).toString('base64'), sha, size: body.length } };
      }
      if (route === 'PUT /repos/{owner}/{repo}/contents/{path}') {
        return { data: { content: { sha: 'sha-new' }, commit: { sha: 'commit-new' } } };
      }
      throw new Error(`Unexpected route: ${route}`);
    });

    // Seed main's cache
    await ContentService.getContent({ gitOrganization, repo, path });
    expect(contentsGetCalls().withoutRef).toBe(1);

    // Branch write with optimistic locking against the branch sha
    const result = await ContentService.put({
      gitOrganization,
      repo,
      path,
      content: 'updated',
      expectedSha: 'sha-branch',
      branch: 'preview/pages/p',
      message: 'branch write',
    });
    expect(result).toEqual({ sha: 'sha-new', commit: 'commit-new' });

    // ONE internal getMeta pre-check, reading the BRANCH (ref set), not main.
    // No second read: the expectedSha write sends the caller's sha directly
    // (true CAS — a second read would adopt a concurrent writer's sha).
    const afterPut = contentsGetCalls();
    expect(afterPut.withRef).toBe(1);
    expect(afterPut.withoutRef).toBe(1);

    // The PUT itself must carry the branch and the CALLER'S expected sha
    const putCall = requestMock.mock.calls.find(
      ([route]) => route === 'PUT /repos/{owner}/{repo}/contents/{path}'
    );
    expect((putCall?.[1] as RequestParams).branch).toBe('preview/pages/p');
    expect((putCall?.[1] as RequestParams).sha).toBe('sha-branch');

    // Main's cache entry survives a branch write: this read is a cache hit
    const main = await ContentService.getContent({ gitOrganization, repo, path });
    expect(main).toEqual({ content: 'main-v1', sha: 'sha-main' });
    expect(contentsGetCalls().withoutRef).toBe(1);
  });

  it('put without branch still invalidates the main cache (existing behavior)', async () => {
    const repo = 'repo-main-put';
    const path = 'pages/q/content.json';
    let mainVersion = 1;

    requestMock.mockImplementation(async (route: string) => {
      if (route === 'GET /repos/{owner}/{repo}/contents/{path}') {
        const body = `main-v${mainVersion}`;
        return {
          data: { content: Buffer.from(body).toString('base64'), sha: `sha-${body}`, size: 1 },
        };
      }
      if (route === 'PUT /repos/{owner}/{repo}/contents/{path}') {
        mainVersion += 1;
        return { data: { content: { sha: 'sha-new' }, commit: { sha: 'commit-new' } } };
      }
      throw new Error(`Unexpected route: ${route}`);
    });

    await ContentService.getContent({ gitOrganization, repo, path });
    await ContentService.put({ gitOrganization, repo, path, content: 'updated' });

    // Cache was invalidated by the default-branch write, so this refetches
    const after = await ContentService.getContent({ gitOrganization, repo, path });
    expect(after?.content).toBe('main-v2');
  });

  it('expectedSha put is a true CAS: uncached pre-check, PUT carries the CALLER sha, no second read', async () => {
    const repo = 'repo-put-cas';
    const path = 'pages/cas/content.json';

    requestMock.mockImplementation(async (route: string) => {
      if (route === 'GET /repos/{owner}/{repo}/contents/{path}') {
        const body = 'main-v1';
        return {
          data: { content: Buffer.from(body).toString('base64'), sha: 'sha-live', size: 1 },
        };
      }
      if (route === 'PUT /repos/{owner}/{repo}/contents/{path}') {
        return { data: { content: { sha: 'sha-new' }, commit: { sha: 'commit-new' } } };
      }
      throw new Error(`Unexpected route: ${route}`);
    });

    // Seed the 60s cache — the pre-check must NOT be satisfied by it.
    await ContentService.getContent({ gitOrganization, repo, path });
    expect(contentsGetCalls().total).toBe(1);

    await ContentService.put({
      gitOrganization,
      repo,
      path,
      content: 'updated',
      expectedSha: 'sha-live',
    });

    // Exactly ONE more Contents GET: the uncached pre-check. No second
    // "current sha" read — that read is what made the old flow check-then-act
    // (it would adopt a concurrent writer's sha).
    expect(contentsGetCalls().total).toBe(2);

    // The PUT sends the CALLER'S expectedSha so GitHub enforces it atomically.
    const putCall = requestMock.mock.calls.find(
      ([route]) => route === 'PUT /repos/{owner}/{repo}/contents/{path}'
    );
    expect((putCall?.[1] as RequestParams).sha).toBe('sha-live');
  });

  it("a 409 from GitHub's sha precondition (lost race after the pre-check) maps to the same conflict", async () => {
    const repo = 'repo-put-cas-race';
    const path = 'pages/race/content.json';

    requestMock.mockImplementation(async (route: string) => {
      if (route === 'GET /repos/{owner}/{repo}/contents/{path}') {
        // Pre-check still sees the expected sha…
        return { data: { content: Buffer.from('x').toString('base64'), sha: 'sha-live', size: 1 } };
      }
      if (route === 'PUT /repos/{owner}/{repo}/contents/{path}') {
        // …but a concurrent writer landed between the check and the PUT.
        throw Object.assign(new Error('is at abc but expected sha-live'), { status: 409 });
      }
      throw new Error(`Unexpected route: ${route}`);
    });

    await expect(
      ContentService.put({
        gitOrganization,
        repo,
        path,
        content: 'updated',
        expectedSha: 'sha-live',
      })
    ).rejects.toMatchObject({ status: 409, message: 'File was modified by someone else' });
  });

  it('a put WITHOUT expectedSha keeps the auto-sha update path (fresh read, its sha on the PUT)', async () => {
    const repo = 'repo-put-nosha';
    const path = 'pages/nosha/content.json';

    requestMock.mockImplementation(async (route: string) => {
      if (route === 'GET /repos/{owner}/{repo}/contents/{path}') {
        return { data: { content: Buffer.from('x').toString('base64'), sha: 'sha-auto', size: 1 } };
      }
      if (route === 'PUT /repos/{owner}/{repo}/contents/{path}') {
        return { data: { content: { sha: 'sha-new' }, commit: { sha: 'commit-new' } } };
      }
      throw new Error(`Unexpected route: ${route}`);
    });

    await ContentService.put({ gitOrganization, repo, path, content: 'updated' });

    const putCall = requestMock.mock.calls.find(
      ([route]) => route === 'PUT /repos/{owner}/{repo}/contents/{path}'
    );
    expect((putCall?.[1] as RequestParams).sha).toBe('sha-auto');
  });

  it('expectedSha + missing file → 409 (deleted since read), never a silent create', async () => {
    const repo = 'repo-put-deleted';
    const path = 'pages/gone/content.json';

    requestMock.mockImplementation(async (route: string) => {
      if (route === 'GET /repos/{owner}/{repo}/contents/{path}') {
        const error = Object.assign(new Error('Not Found'), { status: 404 });
        throw error;
      }
      throw new Error(`Unexpected route: ${route}`);
    });

    await expect(
      ContentService.put({
        gitOrganization,
        repo,
        path,
        content: 'resurrected?',
        expectedSha: 'sha-old',
      })
    ).rejects.toMatchObject({ status: 409, message: expect.stringContaining('deleted') });

    // Nothing was written
    expect(requestMock.mock.calls.some(([route]) => String(route).startsWith('PUT '))).toBe(false);
  });
});

describe('put expectedSha: concurrent-delete race + 422 mismatch (plan §P6)', () => {
  it('a sha-bearing PUT GitHub answers as a CREATE (201) → 409 deleted-since-read, not a silent resurrection', async () => {
    const repo = 'repo-put-201';
    const path = 'pages/racedelete/content.json';

    requestMock.mockImplementation(async (route: string) => {
      if (route === 'GET /repos/{owner}/{repo}/contents/{path}') {
        // Pre-check still sees the file present with the expected sha…
        return { data: { content: Buffer.from('x').toString('base64'), sha: 'sha-live', size: 1 } };
      }
      if (route === 'PUT /repos/{owner}/{repo}/contents/{path}') {
        // …but it was DELETED before the PUT landed, so GitHub CREATED it (201).
        return {
          status: 201,
          data: { content: { sha: 'sha-new' }, commit: { sha: 'commit-new' } },
        };
      }
      throw new Error(`Unexpected route: ${route}`);
    });

    await expect(
      ContentService.put({
        gitOrganization,
        repo,
        path,
        content: 'resurrected?',
        expectedSha: 'sha-live',
      })
    ).rejects.toMatchObject({ status: 409, message: expect.stringContaining('deleted') });
  });

  it('a 200 update under expectedSha is NOT mistaken for a create', async () => {
    const repo = 'repo-put-200';
    const path = 'pages/ok/content.json';

    requestMock.mockImplementation(async (route: string) => {
      if (route === 'GET /repos/{owner}/{repo}/contents/{path}') {
        return { data: { content: Buffer.from('x').toString('base64'), sha: 'sha-live', size: 1 } };
      }
      if (route === 'PUT /repos/{owner}/{repo}/contents/{path}') {
        return {
          status: 200,
          data: { content: { sha: 'sha-new' }, commit: { sha: 'commit-new' } },
        };
      }
      throw new Error(`Unexpected route: ${route}`);
    });

    const result = await ContentService.put({
      gitOrganization,
      repo,
      path,
      content: 'updated',
      expectedSha: 'sha-live',
    });
    expect(result).toMatchObject({ sha: 'sha-new', commit: 'commit-new' });
  });

  it("GitHub's 422 sha-mismatch variant under expectedSha maps to the same 409 conflict", async () => {
    const repo = 'repo-put-422';
    const path = 'pages/mismatch/content.json';

    requestMock.mockImplementation(async (route: string) => {
      if (route === 'GET /repos/{owner}/{repo}/contents/{path}') {
        return { data: { content: Buffer.from('x').toString('base64'), sha: 'sha-live', size: 1 } };
      }
      if (route === 'PUT /repos/{owner}/{repo}/contents/{path}') {
        throw Object.assign(new Error('"sha" 111 does not match abc'), { status: 422 });
      }
      throw new Error(`Unexpected route: ${route}`);
    });

    await expect(
      ContentService.put({
        gitOrganization,
        repo,
        path,
        content: 'updated',
        expectedSha: 'sha-live',
      })
    ).rejects.toMatchObject({ status: 409, message: 'File was modified by someone else' });
  });

  it('an unrelated 422 (not a sha mismatch) under expectedSha still propagates raw', async () => {
    const repo = 'repo-put-422-other';
    const path = 'pages/other/content.json';

    requestMock.mockImplementation(async (route: string) => {
      if (route === 'GET /repos/{owner}/{repo}/contents/{path}') {
        return { data: { content: Buffer.from('x').toString('base64'), sha: 'sha-live', size: 1 } };
      }
      if (route === 'PUT /repos/{owner}/{repo}/contents/{path}') {
        throw Object.assign(new Error('content is too large'), { status: 422 });
      }
      throw new Error(`Unexpected route: ${route}`);
    });

    await expect(
      ContentService.put({
        gitOrganization,
        repo,
        path,
        content: 'updated',
        expectedSha: 'sha-live',
      })
    ).rejects.toMatchObject({ status: 422, message: expect.stringContaining('too large') });
  });
});

describe('put createOnly', () => {
  it('sends NO sha (no prior meta read) and creates the file', async () => {
    const repo = 'repo-createonly-ok';
    const path = 'slides/x/deck.json';

    requestMock.mockImplementation(async (route: string) => {
      if (route === 'PUT /repos/{owner}/{repo}/contents/{path}') {
        return { data: { content: { sha: 'sha-created' }, commit: { sha: 'commit-created' } } };
      }
      throw new Error(`Unexpected route: ${route}`);
    });

    const result = await ContentService.put({
      gitOrganization,
      repo,
      path,
      content: '{}',
      createOnly: true,
    });
    expect(result).toEqual({ sha: 'sha-created', commit: 'commit-created' });

    // No getMeta probe ran, and the PUT carried no sha
    expect(contentsGetCalls().total).toBe(0);
    const putCall = requestMock.mock.calls.find(([route]) => String(route).startsWith('PUT '));
    expect((putCall?.[1] as RequestParams).sha).toBeUndefined();
  });

  it("maps GitHub's 422 (file exists) to a 409 existence conflict", async () => {
    const repo = 'repo-createonly-race';
    const path = 'slides/x/deck.json';

    requestMock.mockImplementation(async (route: string) => {
      if (route === 'PUT /repos/{owner}/{repo}/contents/{path}') {
        throw Object.assign(new Error('Invalid request. "sha" wasn\'t supplied.'), {
          status: 422,
        });
      }
      throw new Error(`Unexpected route: ${route}`);
    });

    await expect(
      ContentService.put({ gitOrganization, repo, path, content: '{}', createOnly: true })
    ).rejects.toMatchObject({ status: 409, message: expect.stringContaining('already exists') });
  });

  it('refuses createOnly combined with expectedSha', async () => {
    await expect(
      ContentService.put({
        gitOrganization,
        repo: 'repo-createonly-bad',
        path: 'x.json',
        content: '{}',
        createOnly: true,
        expectedSha: 'sha-1',
      })
    ).rejects.toThrow('mutually exclusive');
  });
});

describe('uploadBatch primeCache', () => {
  function mockBatchRoutes() {
    requestMock.mockImplementation(async (route: string, params: RequestParams) => {
      switch (route) {
        case 'POST /repos/{owner}/{repo}/git/blobs': {
          const decoded = Buffer.from(String(params.content), 'base64').toString('utf-8');
          return { data: { sha: `blob-${decoded}` } };
        }
        case 'GET /repos/{owner}/{repo}/git/ref/{ref}':
          return { data: { object: { sha: 'head-commit' } } };
        case 'GET /repos/{owner}/{repo}/git/commits/{commit_sha}':
          return { data: { tree: { sha: 'base-tree' } } };
        case 'POST /repos/{owner}/{repo}/git/trees':
          return { data: { sha: 'new-tree' } };
        case 'POST /repos/{owner}/{repo}/git/commits':
          return { data: { sha: 'new-commit' } };
        case 'PATCH /repos/{owner}/{repo}/git/refs/{ref}':
          return { data: {} };
        case 'GET /repos/{owner}/{repo}/contents/{path}':
          // A post-write API read would serve STALE content (Contents-API lag)
          return {
            data: { content: Buffer.from('stale-from-api').toString('base64'), sha: 'sha-stale' },
          };
        default:
          throw new Error(`Unexpected route: ${route}`);
      }
    });
  }

  it('primeCache:true makes a same-process read-after-write coherent (no API read)', async () => {
    const repo = 'repo-primecache-on';
    const path = 'slides/p/deck.json';
    mockBatchRoutes();

    await ContentService.uploadBatch({
      gitOrganization,
      repo,
      files: [{ path, content: '{"fresh":true}' }],
      message: 'save',
      primeCache: true,
    });

    const read = await ContentService.getContent({ gitOrganization, repo, path });
    expect(read).toEqual({ content: '{"fresh":true}', sha: 'blob-{"fresh":true}' });
    expect(contentsGetCalls().total).toBe(0); // cache hit — API never touched
  });

  it('without primeCache the post-write read still goes to the API (unchanged)', async () => {
    const repo = 'repo-primecache-off';
    const path = 'slides/p/deck.json';
    mockBatchRoutes();

    await ContentService.uploadBatch({
      gitOrganization,
      repo,
      files: [{ path, content: '{"fresh":true}' }],
      message: 'save',
    });

    const read = await ContentService.getContent({ gitOrganization, repo, path });
    expect(read?.content).toBe('stale-from-api');
    expect(contentsGetCalls().total).toBe(1);
  });

  it('primeCache is scoped to main — branch batches prime nothing', async () => {
    const repo = 'repo-primecache-branch';
    const path = 'slides/p/deck.json';
    mockBatchRoutes();

    await ContentService.uploadBatch({
      gitOrganization,
      repo,
      files: [{ path, content: '{"fresh":true}' }],
      branch: 'preview/slides/p',
      message: 'save',
      primeCache: true,
    });

    const read = await ContentService.getContent({ gitOrganization, repo, path });
    expect(read?.content).toBe('stale-from-api');
    expect(contentsGetCalls().total).toBe(1);
  });
});

describe('branch lifecycle wrappers', () => {
  it('createBranch creates refs/heads/<branch> at fromSha', async () => {
    requestMock.mockResolvedValue({
      data: { ref: 'refs/heads/preview/slides/intro', object: { sha: 'from-sha' } },
    });

    const result = await ContentService.createBranch({
      gitOrganization,
      repo: 'repo-branches',
      branch: 'preview/slides/intro',
      fromSha: 'from-sha',
    });

    expect(requestMock).toHaveBeenCalledWith('POST /repos/{owner}/{repo}/git/refs', {
      owner: 'test-org',
      repo: 'repo-branches',
      ref: 'refs/heads/preview/slides/intro',
      sha: 'from-sha',
    });
    expect(result).toEqual({ ref: 'refs/heads/preview/slides/intro', sha: 'from-sha' });
  });

  it('deleteBranch deletes heads/<branch>', async () => {
    requestMock.mockResolvedValue({ status: 204 });

    const result = await ContentService.deleteBranch({
      gitOrganization,
      repo: 'repo-branches',
      branch: 'preview/slides/intro',
    });

    expect(requestMock).toHaveBeenCalledWith('DELETE /repos/{owner}/{repo}/git/refs/{ref}', {
      owner: 'test-org',
      repo: 'repo-branches',
      ref: 'heads/preview/slides/intro',
    });
    expect(result).toEqual({ deleted: true });
  });

  it('mergeBranch returns merged sha on a 201 merge commit', async () => {
    requestMock.mockResolvedValue({ status: 201, data: { sha: 'merge-commit-sha' } });

    const result = await ContentService.mergeBranch({
      gitOrganization,
      repo: 'repo-branches',
      base: 'main',
      head: 'preview/slides/intro',
      message: 'Accept preview',
    });

    expect(requestMock).toHaveBeenCalledWith('POST /repos/{owner}/{repo}/merges', {
      owner: 'test-org',
      repo: 'repo-branches',
      base: 'main',
      head: 'preview/slides/intro',
      commit_message: 'Accept preview',
    });
    expect(result).toEqual({ merged: true, sha: 'merge-commit-sha' });
  });

  it('mergeBranch treats 204 (already merged) as merged with no sha', async () => {
    requestMock.mockResolvedValue({ status: 204, data: undefined });

    const result = await ContentService.mergeBranch({
      gitOrganization,
      repo: 'repo-branches',
      base: 'main',
      head: 'preview/slides/intro',
    });

    expect(result).toEqual({ merged: true });
  });

  it('mergeBranch surfaces a 409 merge conflict distinctly instead of throwing', async () => {
    const conflict = Object.assign(new Error('Merge conflict'), { status: 409 });
    requestMock.mockRejectedValue(conflict);

    const result = await ContentService.mergeBranch({
      gitOrganization,
      repo: 'repo-branches',
      base: 'main',
      head: 'preview/slides/intro',
    });

    expect(result).toEqual({ merged: false, conflict: true });
  });

  it('mergeBranch rethrows non-conflict errors', async () => {
    const missing = Object.assign(new Error('Base does not exist'), { status: 404 });
    requestMock.mockRejectedValue(missing);

    await expect(
      ContentService.mergeBranch({
        gitOrganization,
        repo: 'repo-branches',
        base: 'main',
        head: 'preview/slides/intro',
      })
    ).rejects.toThrow('Base does not exist');
  });
});

describe('compareBranches', () => {
  it('maps the compare payload to ahead/behind counts, shas, and dated commits', async () => {
    requestMock.mockResolvedValue({
      data: {
        ahead_by: 2,
        behind_by: 1,
        base_commit: { sha: 'main-head' },
        merge_base_commit: { sha: 'fork-point' },
        commits: [
          { sha: 'c1', commit: { committer: { date: '2026-08-01T10:00:00Z' } } },
          { sha: 'c2', commit: { author: { date: '2026-08-01T11:00:00Z' } } }, // no committer → author
        ],
      },
    });

    const result = await ContentService.compareBranches({
      gitOrganization,
      repo: 'repo-compare',
      base: 'main',
      head: 'preview/pages/syllabus',
    });

    expect(requestMock).toHaveBeenCalledWith('GET /repos/{owner}/{repo}/compare/{basehead}', {
      owner: 'test-org',
      repo: 'repo-compare',
      basehead: 'main...preview/pages/syllabus',
    });
    expect(result).toEqual({
      ahead_by: 2,
      behind_by: 1,
      base_sha: 'main-head',
      head_sha: 'c2', // head's HEAD = last listed commit when ahead
      merge_base_sha: 'fork-point',
      commits: [
        { sha: 'c1', date: '2026-08-01T10:00:00Z' },
        { sha: 'c2', date: '2026-08-01T11:00:00Z' },
      ],
    });
  });

  it('falls back to the merge base for head_sha when no commits are listed', async () => {
    requestMock.mockResolvedValue({
      data: {
        ahead_by: 0,
        behind_by: 3,
        base_commit: { sha: 'main-head' },
        merge_base_commit: { sha: 'stale-head' },
        commits: [],
      },
    });

    const result = await ContentService.compareBranches({
      gitOrganization,
      repo: 'repo-compare',
      base: 'main',
      head: 'stale-branch',
    });

    // A strictly-behind head's HEAD IS the merge base, not main's HEAD.
    expect(result?.head_sha).toBe('stale-head');
  });

  it('resolves main HEAD via a self-compare (base_sha with zero commits)', async () => {
    requestMock.mockResolvedValue({
      data: {
        ahead_by: 0,
        behind_by: 0,
        base_commit: { sha: 'main-head' },
        merge_base_commit: { sha: 'main-head' },
        commits: [],
      },
    });

    const result = await ContentService.compareBranches({
      gitOrganization,
      repo: 'repo-compare',
      base: 'main',
      head: 'main',
    });

    expect(result?.base_sha).toBe('main-head');
    expect(result?.head_sha).toBe('main-head');
    expect(result?.ahead_by).toBe(0);
  });

  it('returns null on 404 (head branch does not exist)', async () => {
    const missing = Object.assign(new Error('Not Found'), { status: 404 });
    requestMock.mockRejectedValue(missing);

    const result = await ContentService.compareBranches({
      gitOrganization,
      repo: 'repo-compare',
      base: 'main',
      head: 'preview/pages/ghost',
    });

    expect(result).toBeNull();
  });

  it('rethrows non-404 errors', async () => {
    const boom = Object.assign(new Error('Server error'), { status: 500 });
    requestMock.mockRejectedValue(boom);

    await expect(
      ContentService.compareBranches({
        gitOrganization,
        repo: 'repo-compare',
        base: 'main',
        head: 'preview/pages/syllabus',
      })
    ).rejects.toThrow('Server error');
  });
});

describe('getBlobContent', () => {
  it('fetches a blob by sha via the Git Blobs API and decodes utf-8', async () => {
    requestMock.mockImplementation(async (route: string, params: RequestParams) => {
      expect(route).toBe('GET /repos/{owner}/{repo}/git/blobs/{file_sha}');
      expect(params).toMatchObject({
        owner: 'test-org',
        repo: 'repo-blob',
        file_sha: 'abc123',
      });
      // GitHub returns base64 with embedded newlines
      const base64 = Buffer.from('{"version":1,"slides":[]}', 'utf-8').toString('base64');
      return { data: { content: `${base64.slice(0, 10)}\n${base64.slice(10)}`, sha: 'abc123' } };
    });

    const result = await ContentService.getBlobContent({
      gitOrganization,
      repo: 'repo-blob',
      sha: 'abc123',
    });

    expect(result).toEqual({ content: '{"version":1,"slides":[]}', sha: 'abc123' });
    expect(requestMock).toHaveBeenCalledTimes(1);
  });

  it('never serves from or stores into the response cache (content-addressed, uncached)', async () => {
    const base64 = Buffer.from('hello', 'utf-8').toString('base64');
    requestMock.mockResolvedValue({ data: { content: base64, sha: 'blob-sha' } });

    await ContentService.getBlobContent({ gitOrganization, repo: 'repo-blob-2', sha: 'blob-sha' });
    await ContentService.getBlobContent({ gitOrganization, repo: 'repo-blob-2', sha: 'blob-sha' });

    // Two reads → two API calls (no cache layer involved).
    expect(requestMock).toHaveBeenCalledTimes(2);
  });

  it('returns null on 404 (blob not in the repo)', async () => {
    requestMock.mockRejectedValue(Object.assign(new Error('Not Found'), { status: 404 }));

    const result = await ContentService.getBlobContent({
      gitOrganization,
      repo: 'repo-blob',
      sha: 'ffffffffffffffffffffffffffffffffffffffff',
    });

    expect(result).toBeNull();
  });

  it("returns null on 422 (GitHub's malformed-sha answer)", async () => {
    requestMock.mockRejectedValue(
      Object.assign(new Error('The sha parameter must be exactly 40 characters'), { status: 422 })
    );

    const result = await ContentService.getBlobContent({
      gitOrganization,
      repo: 'repo-blob',
      sha: 'not-a-sha',
    });

    expect(result).toBeNull();
  });

  it('rethrows non-404/422 errors', async () => {
    requestMock.mockRejectedValue(Object.assign(new Error('Server error'), { status: 500 }));

    await expect(
      ContentService.getBlobContent({ gitOrganization, repo: 'repo-blob', sha: 'abc123' })
    ).rejects.toThrow('Server error');
  });
});
