import { describe, expect, it } from 'vitest';
import {
  GITLAB_COM,
  gitWeb,
  isGitlabCom,
  normalizeGitlabHost,
  parseGitlabId,
  scopeGitlabId,
} from '../index.ts';

const INSTANCE = '3f1c2b9e-8a7d-4c1e-9b2a-5d6e7f8a9b0c';

describe('scopeGitlabId / parseGitlabId', () => {
  it('leaves default-instance ids bare', () => {
    expect(scopeGitlabId(null, 42)).toBe('42');
    expect(parseGitlabId('42')).toEqual({ instanceId: null, rawId: '42' });
  });

  it('prefixes and splits self-managed ids', () => {
    const stored = scopeGitlabId(INSTANCE, 42);
    expect(stored).toBe(`${INSTANCE}:42`);
    expect(parseGitlabId(stored)).toEqual({ instanceId: INSTANCE, rawId: '42' });
  });

  it('keeps the same id on two instances distinct', () => {
    expect(scopeGitlabId(INSTANCE, 1)).not.toBe(scopeGitlabId(null, 1));
  });
});

describe('normalizeGitlabHost', () => {
  it('reduces what people type to an https origin', () => {
    expect(normalizeGitlabHost('gitlab.school.edu')).toBe('https://gitlab.school.edu');
    expect(normalizeGitlabHost(' https://GitLab.School.edu/users/sign_in ')).toBe(
      'https://gitlab.school.edu'
    );
    expect(normalizeGitlabHost('https://gitlab.school.edu:8443/')).toBe(
      'https://gitlab.school.edu:8443'
    );
  });

  it('refuses unusable input', () => {
    expect(normalizeGitlabHost('')).toBeNull();
    expect(normalizeGitlabHost('not a host')).toBeNull();
    expect(normalizeGitlabHost('http://gitlab.school.edu')).toBeNull();
    expect(normalizeGitlabHost('https://user:pw@gitlab.school.edu')).toBeNull();
    expect(normalizeGitlabHost('localhost')).toBeNull();
  });

  it('allows http and localhost only when asked (local development)', () => {
    expect(normalizeGitlabHost('http://localhost:8929', { allowHttp: true })).toBe(
      'http://localhost:8929'
    );
    expect(normalizeGitlabHost('localhost:8929', { allowHttp: true })).toBe(
      'http://localhost:8929'
    );
  });

  it('recognizes gitlab.com', () => {
    expect(isGitlabCom('gitlab.com')).toBe(true);
    expect(isGitlabCom(GITLAB_COM)).toBe(true);
    expect(isGitlabCom('gitlab.school.edu')).toBe(false);
  });
});

describe('gitWeb on a self-managed instance', () => {
  it('links to the org base_url, not gitlab.com', () => {
    const web = gitWeb({
      provider: 'GITLAB',
      login: 'cs',
      git_namespace: 'cs/cs101',
      base_url: 'https://gitlab.school.edu',
    });
    expect(web.repo('hw1-alice')).toBe('https://gitlab.school.edu/cs/cs101/hw1-alice');
    expect(web.issue('hw1-alice', 3)).toBe(
      'https://gitlab.school.edu/cs/cs101/hw1-alice/-/issues/3'
    );
  });

  it('falls back to gitlab.com without a base_url', () => {
    const web = gitWeb({ provider: 'GITLAB', login: 'cs', git_namespace: 'cs/cs101' });
    expect(web.repo('x')).toBe('https://gitlab.com/cs/cs101/x');
  });
});

describe('pickAvailableLogin', () => {
  const takenSet = (taken: string[]) => async (l: string) => taken.includes(l);

  it('uses the base when free, else the first free suffix', async () => {
    const { pickAvailableLogin } = await import('../index.ts');
    await expect(pickAvailableLogin('alice', takenSet([]))).resolves.toBe('alice');
    await expect(pickAvailableLogin('alice', takenSet(['alice', 'alice-2']))).resolves.toBe(
      'alice-3'
    );
  });

  it('gives up with null when nothing is free', async () => {
    const { pickAvailableLogin } = await import('../index.ts');
    await expect(pickAvailableLogin('a', async () => true, 3)).resolves.toBeNull();
    await expect(pickAvailableLogin('  ', takenSet([]))).resolves.toBeNull();
  });
});
