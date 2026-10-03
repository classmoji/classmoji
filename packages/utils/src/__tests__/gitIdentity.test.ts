import { describe, expect, it } from 'vitest';
import {
  accountProviderId,
  displayUsername,
  gitAccountId,
  gitUsername,
  withLogin,
  withLogins,
} from '../gitIdentity.ts';

const github = { provider_id: 'github', username: 'jdoe', account_id: '42', image: null };
const gitlab = { provider_id: 'gitlab', username: 'jane', account_id: '7', image: null };

describe('gitUsername', () => {
  it('reads the username of the requested provider', () => {
    const user = { accounts: [github, gitlab] };
    expect(gitUsername(user)).toBe('jdoe');
    expect(gitUsername(user, 'GITLAB')).toBe('jane');
  });

  it('is null when that provider is not connected', () => {
    expect(gitUsername({ accounts: [gitlab] }, 'GITHUB')).toBeNull();
    expect(gitUsername({ accounts: [] })).toBeNull();
    expect(gitUsername(null)).toBeNull();
  });

  it('accepts an already-flattened user', () => {
    expect(gitUsername({ login: 'flat' })).toBe('flat');
  });
});

describe('gitAccountId', () => {
  it('never returns a placeholder id', () => {
    expect(gitAccountId({ accounts: [github] })).toBe('42');
    expect(
      gitAccountId({ accounts: [{ ...github, account_id: 'unresolved:u1' }] })
    ).toBeNull();
  });
});

describe('displayUsername', () => {
  it('prefers Github and falls back to another provider', () => {
    expect(displayUsername({ accounts: [gitlab, github] })).toBe('jdoe');
    expect(displayUsername({ accounts: [gitlab] })).toBe('jane');
    expect(displayUsername({ accounts: [] })).toBeNull();
  });
});

describe('accountProviderId', () => {
  it('maps the git provider to the better-auth provider id', () => {
    expect(accountProviderId('GITHUB')).toBe('github');
    expect(accountProviderId(null)).toBe('github');
  });
});

describe('withLogin / withLogins', () => {
  it('replaces the accounts with login', () => {
    expect(withLogin({ id: 'u1', accounts: [github] })).toEqual({ id: 'u1', login: 'jdoe' });
    expect(withLogin({ id: 'u2', accounts: [] })).toEqual({ id: 'u2', login: null });
  });

  it('flattens users nested anywhere in a result', () => {
    const created = new Date('2026-01-01');
    const result = withLogins({
      classroom: 'c1',
      created,
      members: [
        { role: 'STUDENT', user: { id: 'u1', accounts: [github] } },
        { role: 'OWNER', user: { id: 'u2', accounts: [gitlab] } },
      ],
    });

    expect(result).toEqual({
      classroom: 'c1',
      created,
      members: [
        { role: 'STUDENT', user: { id: 'u1', login: 'jdoe' } },
        { role: 'OWNER', user: { id: 'u2', login: 'jane' } },
      ],
    });
    expect(result.created).toBeInstanceOf(Date);
  });

  it('leaves account rows that carry tokens alone', () => {
    const row = { accounts: [{ provider_id: 'github', username: 'x', access_token: 't' }] };
    expect(withLogins(row)).toEqual(row);
  });
});
