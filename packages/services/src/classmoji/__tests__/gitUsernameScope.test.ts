/**
 * GitLab usernames are unique per server: a lookup that belongs to a classroom
 * passes its organization, so `jdoe` resolves on that GitLab only.
 */

import { describe, expect, it } from 'vitest';
import { gitScopeProvider, whereGitUsername } from '@classmoji/database';

const account = (where: ReturnType<typeof whereGitUsername>) =>
  (where.accounts as { some: Record<string, unknown> }).some;

describe('whereGitUsername', () => {
  it('matches Github by provider alone', () => {
    expect(account(whereGitUsername('jdoe'))).toEqual({
      provider_id: 'github',
      username: { equals: 'jdoe', mode: 'insensitive' },
    });
  });

  it("scopes a GitLab lookup to the organization's server", () => {
    const where = whereGitUsername('jdoe', { provider: 'GITLAB', gitlab_instance_id: 'inst1' });
    expect(account(where)).toMatchObject({ provider_id: 'gitlab', gitlab_instance_id: 'inst1' });
  });

  it('reads an organization without an instance as gitlab.com', () => {
    const where = whereGitUsername('jdoe', { provider: 'GITLAB', gitlab_instance_id: null });
    expect(account(where)).toMatchObject({ gitlab_instance_id: '' });
  });

  it('leaves a bare provider unscoped (any server)', () => {
    expect(account(whereGitUsername('jdoe', 'GITLAB'))).not.toHaveProperty('gitlab_instance_id');
  });

  it('never scopes a Github organization by server', () => {
    const where = whereGitUsername('jdoe', { provider: 'GITHUB', gitlab_instance_id: null });
    expect(account(where)).not.toHaveProperty('gitlab_instance_id');
    expect(gitScopeProvider({ provider: 'GITHUB' })).toBe('GITHUB');
  });
});
