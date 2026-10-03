/**
 * repository.checkTemplate: the publish-time check that a repository's template
 * can actually be cloned. Without it, an empty or deleted template only failed
 * later, once per student, inside create_git_repos / gh-create_git_repo runs the
 * instructor never saw.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const classroomFindUnique = vi.fn();
const repositoryExists = vi.fn();
const getGitProvider = vi.fn((_org: unknown) => ({ repositoryExists }));

vi.mock('@classmoji/database', () => ({
  default: () => ({ classroom: { findUnique: classroomFindUnique } }),
}));

vi.mock('../../git/index.ts', () => ({
  getGitProvider: (org: unknown) => getGitProvider(org),
}));

vi.mock('../notification.service.ts', () => ({}));

const { checkTemplate } = await import('../repository.service.ts');

const GITHUB_ORG = {
  provider: 'GITHUB',
  login: 'uniglos',
  github_installation_id: '123',
  access_token: null,
  base_url: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  classroomFindUnique.mockResolvedValue({ git_organization: GITHUB_ORG });
  repositoryExists.mockResolvedValue(true);
});

describe('checkTemplate', () => {
  it.each([
    ['an empty string', ''],
    ['whitespace', '   '],
    ['null', null],
  ])('refuses %s without asking Github', async (_label, template) => {
    const result = await checkTemplate(template, 'class-1');

    expect(result).toMatchObject({ ok: false, reason: 'TEMPLATE_EMPTY' });
    expect(repositoryExists).not.toHaveBeenCalled();
  });

  it('refuses a template the installation cannot see', async () => {
    repositoryExists.mockResolvedValue(false);

    const result = await checkTemplate('ct5016-LyraTemplate', 'class-1');

    expect(result).toMatchObject({ ok: false, reason: 'TEMPLATE_UNREACHABLE' });
    if (!result.ok) {
      expect(result.error).toContain('uniglos/ct5016-LyraTemplate');
      expect(result.error).toContain('Github');
      expect(result.error).not.toMatch(/GitHub|—/);
    }
  });

  it('accepts a reachable template, resolving a bare name to the classroom org', async () => {
    const result = await checkTemplate('boids-starter', 'class-1');

    expect(result).toEqual({ ok: true });
    expect(getGitProvider).toHaveBeenCalledWith(GITHUB_ORG);
    expect(repositoryExists).toHaveBeenCalledExactlyOnceWith('uniglos', 'boids-starter');
  });

  it('looks up an owner/repo template where it says', async () => {
    await checkTemplate('classmoji/empty-template', 'class-1');

    expect(repositoryExists).toHaveBeenCalledExactlyOnceWith('classmoji', 'empty-template');
  });

  it('lets the publish through when Github cannot be asked (not a template problem)', async () => {
    repositoryExists.mockRejectedValue(Object.assign(new Error('rate limited'), { status: 403 }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(checkTemplate('boids-starter', 'class-1')).resolves.toEqual({ ok: true });
    warn.mockRestore();
  });

  it('only checks emptiness on Gitlab, which has no repository read', async () => {
    classroomFindUnique.mockResolvedValue({
      git_organization: { ...GITHUB_ORG, provider: 'GITLAB', access_token: 'tok' },
    });

    await expect(checkTemplate('starter', 'class-1')).resolves.toEqual({ ok: true });
    await expect(checkTemplate('', 'class-1')).resolves.toMatchObject({
      ok: false,
      reason: 'TEMPLATE_EMPTY',
    });
    expect(getGitProvider).not.toHaveBeenCalled();
  });
});
