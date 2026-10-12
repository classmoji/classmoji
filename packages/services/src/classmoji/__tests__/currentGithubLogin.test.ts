import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findFirst: vi.fn(),
  update: vi.fn(),
  getLoginById: vi.fn(),
}));

vi.mock('@classmoji/database', async () => ({
  ...(await vi.importActual<typeof import('@classmoji/database/gitIdentity')>(
    '@classmoji/database/gitIdentity'
  )),
  default: () => ({
    account: {
      findFirst: (...a: unknown[]) => mocks.findFirst(...a),
      update: (...a: unknown[]) => mocks.update(...a),
    },
  }),
}));

const { currentGithubLogin } = await import('../user.service.ts');

const provider = { getLoginById: (id: string) => mocks.getLoginById(id) };

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.findFirst.mockResolvedValue({ id: 'acct-1', account_id: '42', username: 'old' });
  mocks.update.mockResolvedValue({});
});

describe('currentGithubLogin', () => {
  it('returns the stored login when Github still has it', async () => {
    mocks.getLoginById.mockResolvedValue('old');

    expect(await currentGithubLogin(provider, 'user-1', 'old')).toBe('old');
    expect(mocks.getLoginById).toHaveBeenCalledWith('42');
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('returns and stores the new login after a rename', async () => {
    mocks.getLoginById.mockResolvedValue('new');

    expect(await currentGithubLogin(provider, 'user-1', 'old')).toBe('new');
    expect(mocks.update).toHaveBeenCalledWith({
      where: { id: 'acct-1' },
      data: { username: 'new' },
    });
  });

  it('still returns the new login when storing it fails', async () => {
    mocks.getLoginById.mockResolvedValue('new');
    mocks.update.mockRejectedValue(Object.assign(new Error('Unique'), { code: 'P2002' }));

    expect(await currentGithubLogin(provider, 'user-1', 'old')).toBe('new');
  });

  it('returns null when Github no longer has the account', async () => {
    mocks.getLoginById.mockResolvedValue(null);

    expect(await currentGithubLogin(provider, 'user-1', 'old')).toBeNull();
  });

  it('falls back to the given login without a stored Github account', async () => {
    mocks.findFirst.mockResolvedValue(null);

    expect(await currentGithubLogin(provider, 'user-1', 'ada')).toBe('ada');
    expect(mocks.getLoginById).not.toHaveBeenCalled();
  });
});
