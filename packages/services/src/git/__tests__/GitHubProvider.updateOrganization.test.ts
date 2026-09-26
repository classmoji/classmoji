import { describe, it, expect, vi } from 'vitest';
import { GitHubProvider } from '../GitHubProvider.ts';

function providerWith(request: ReturnType<typeof vi.fn>): GitHubProvider {
  const provider = new GitHubProvider('1');
  (provider as unknown as { _octokit: unknown })._octokit = { request };
  return provider;
}

describe('GitHubProvider.updateOrganization', () => {
  it('sends only the repository settings, to the organization in the path', async () => {
    const request = vi.fn(async () => ({ data: { login: 'myorg' } }));

    await providerWith(request).updateOrganization('myorg', {
      default_repository_permission: 'read',
      // Extra keys a loosely typed caller might pass are not sent on.
      ...({ org: 'other-org', billing_email: 'x@y.z' } as object),
    });

    expect(request).toHaveBeenCalledWith('PATCH /orgs/{org}', {
      default_repository_permission: 'read',
      org: 'myorg',
    });
  });
});
