import { describe, it, expect, vi, afterEach } from 'vitest';

const findFirst = vi.fn();
vi.mock('@classmoji/database', () => ({ default: () => ({ classroom: { findFirst } }) }));
vi.mock('../../classmoji/gitlabConnection.service.ts', () => ({
  getConnectionToken: async () => 'tok',
}));

const { owned } = await import('../gitlabContent.ts');

afterEach(() => vi.clearAllMocks());

const org = { id: 'org-1', provider: 'GITLAB', login: 'cs', gitlab_connection_id: 'c1' };

describe('gitlabContent owner', () => {
  it("uses the classroom's subgroup as the content project's namespace", async () => {
    findFirst.mockResolvedValueOnce({ git_namespace: 'cs/cs50' });
    await expect(owned(org, 'content-cs50')).resolves.toMatchObject({
      login: 'cs/cs50',
      id: 'org-1',
    });
    expect(findFirst.mock.calls[0][0].where).toMatchObject({ content_repo: 'content-cs50' });
  });

  it('falls back to the org login when no classroom matches', async () => {
    findFirst.mockResolvedValueOnce(null);
    await expect(owned(org, 'content-other')).resolves.toMatchObject({ login: 'cs' });
  });
});
