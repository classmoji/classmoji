import { describe, it, expect, vi } from 'vitest';
import { GitHubProvider } from '../GitHubProvider.ts';

/** An Octokit rejection: a plain Error carrying GitHub's HTTP status. */
function httpError(status: number): Error {
  return Object.assign(new Error(`HTTP ${status}`), { status });
}

function providerWith(request: ReturnType<typeof vi.fn>): GitHubProvider {
  const provider = new GitHubProvider('1');
  (provider as unknown as { _octokit: unknown })._octokit = { request };
  return provider;
}

describe('GitHubProvider.disableRepoPages', () => {
  it('deletes the Pages site and reports that it had to', async () => {
    const request = vi.fn(async () => ({ status: 204 }));

    const result = await providerWith(request).disableRepoPages('org', 'content-org-cs101');

    expect(result).toEqual({ alreadyDisabled: false });
    expect(request).toHaveBeenCalledWith('DELETE /repos/{owner}/{repo}/pages', {
      owner: 'org',
      repo: 'content-org-cs101',
    });
  });

  // The re-run case, and the reason this is safe to point at a whole
  // allowlist: a repo that never had Pages must not look like a failure.
  it('treats a 404 as already off rather than an error', async () => {
    const request = vi.fn(async () => {
      throw httpError(404);
    });

    await expect(providerWith(request).disableRepoPages('org', 'repo')).resolves.toEqual({
      alreadyDisabled: true,
    });
  });

  // A 403 is the Pages permission the App may not hold. Swallowing it would
  // report "Pages is off" over a repo still serving the whole tree.
  it('rethrows anything that is not a 404', async () => {
    const request = vi.fn(async () => {
      throw httpError(403);
    });

    await expect(providerWith(request).disableRepoPages('org', 'repo')).rejects.toMatchObject({
      status: 403,
    });
  });
});

describe('GitHubProvider.getRepoPages', () => {
  it('maps the Pages payload onto the reported shape', async () => {
    const request = vi.fn(async () => ({
      data: {
        html_url: 'https://org.github.io/content-org-cs101/',
        status: 'built',
        build_type: 'legacy',
        source: { branch: 'main', path: '/' },
      },
    }));

    const result = await providerWith(request).getRepoPages('org', 'content-org-cs101');

    expect(result).toEqual({
      htmlUrl: 'https://org.github.io/content-org-cs101/',
      status: 'built',
      buildType: 'legacy',
      sourceBranch: 'main',
      sourcePath: '/',
    });
    expect(request).toHaveBeenCalledWith('GET /repos/{owner}/{repo}/pages', {
      owner: 'org',
      repo: 'content-org-cs101',
    });
  });

  // A workflow-built site has no meaningful `source`, and `html_url`/`status`
  // can be absent while one is still building. Every field is optional in
  // practice, so the fallbacks have to hold rather than throw.
  it('fills in nulls for a sparse workflow-built payload', async () => {
    const request = vi.fn(async () => ({
      data: { build_type: 'workflow', status: null },
    }));

    await expect(providerWith(request).getRepoPages('org', 'repo')).resolves.toEqual({
      htmlUrl: null,
      status: null,
      buildType: 'workflow',
      sourceBranch: null,
      sourcePath: null,
    });
  });

  it('returns null when the repo has no Pages site', async () => {
    const request = vi.fn(async () => {
      throw httpError(404);
    });

    await expect(providerWith(request).getRepoPages('org', 'repo')).resolves.toBeNull();
  });

  it('rethrows anything that is not a 404', async () => {
    const request = vi.fn(async () => {
      throw httpError(500);
    });

    await expect(providerWith(request).getRepoPages('org', 'repo')).rejects.toMatchObject({
      status: 500,
    });
  });
});
