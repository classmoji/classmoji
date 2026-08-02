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

    // Both internal getMeta lookups must have read the BRANCH (ref set), not main
    const afterPut = contentsGetCalls();
    expect(afterPut.withRef).toBe(2);
    expect(afterPut.withoutRef).toBe(1);

    // The PUT itself must carry the branch
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
