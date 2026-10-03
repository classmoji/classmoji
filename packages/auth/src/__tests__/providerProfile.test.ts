/**
 * Sign-in profile recording. Git identity lives on the account row, so these
 * rules are what keep a Github username attached to the right account.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mapGitHubProfile, onAccountCreated } from '../providerProfile.ts';

const prisma = {
  user: { update: vi.fn() },
  account: { findFirst: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
};
const db = prisma as unknown as Parameters<typeof mapGitHubProfile>[0];

const profile = {
  id: 42,
  login: 'jdoe',
  email: 'jdoe@users.github.test',
  avatar_url: 'https://avatars.test/42',
};

beforeEach(() => {
  vi.resetAllMocks();
});

describe('mapGitHubProfile', () => {
  it('leaves a new user unverified so registration still asks for an email', async () => {
    prisma.account.findFirst.mockResolvedValue(null);

    await expect(mapGitHubProfile(db, profile)).resolves.toEqual({ emailVerified: false });
  });

  it('claims a placeholder account held under the same username', async () => {
    prisma.account.findFirst
      .mockResolvedValueOnce(null) // no account for this Github id yet
      .mockResolvedValueOnce({ id: 'placeholder' }) // unresolved:… with username jdoe
      .mockResolvedValueOnce({ id: 'placeholder', user_id: 'u1' }); // profile write

    await mapGitHubProfile(db, profile);

    expect(prisma.account.findFirst).toHaveBeenNthCalledWith(2, {
      where: {
        provider_id: 'github',
        account_id: { startsWith: 'unresolved:' },
        username: { equals: 'jdoe', mode: 'insensitive' },
      },
      select: { id: true },
    });
    expect(prisma.account.update).toHaveBeenCalledWith({
      where: { id: 'placeholder' },
      data: { account_id: '42' },
    });
  });

  it('does not look for a placeholder when the Github id is already linked', async () => {
    prisma.account.findFirst.mockResolvedValue({ id: 'a1', user_id: 'u1' });

    await mapGitHubProfile(db, profile);

    const placeholderLookups = prisma.account.findFirst.mock.calls.filter(
      ([args]) => typeof args.where.account_id === 'object'
    );
    expect(placeholderLookups).toHaveLength(0);
  });

  it('refreshes a returning account and releases the username from any other account', async () => {
    prisma.account.findFirst.mockResolvedValue({ id: 'a1', user_id: 'u1' });

    await mapGitHubProfile(db, profile);

    expect(prisma.account.updateMany).toHaveBeenCalledWith({
      where: {
        provider_id: 'github',
        username: { equals: 'jdoe', mode: 'insensitive' },
        NOT: { id: 'a1' },
      },
      data: { username: null },
    });
    expect(prisma.account.update).toHaveBeenCalledWith({
      where: { id: 'a1' },
      data: { username: 'jdoe', email: 'jdoe@users.github.test', image: 'https://avatars.test/42' },
    });
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'u1' },
      data: { image: 'https://avatars.test/42' },
    });
  });

  it('never blocks sign-in when the database fails', async () => {
    prisma.account.findFirst.mockRejectedValue(new Error('db down'));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(mapGitHubProfile(db, profile)).resolves.toEqual({ emailVerified: false });
  });
});

describe('onAccountCreated', () => {
  it('writes the profile parked at sign-in onto the new account', async () => {
    prisma.account.findFirst.mockResolvedValue(null);
    await mapGitHubProfile(db, { ...profile, id: 7, login: 'newbie' });

    await onAccountCreated(db, { id: 'a7', providerId: 'github', accountId: '7', userId: 'u7' });

    expect(prisma.account.update).toHaveBeenCalledWith({
      where: { id: 'a7' },
      data: { username: 'newbie', email: profile.email, image: profile.avatar_url },
    });
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'u7' },
      data: { image: profile.avatar_url },
    });
  });

  it('ignores password accounts', async () => {
    await onAccountCreated(db, {
      id: 'c1',
      providerId: 'credential',
      accountId: 'u1',
      userId: 'u1',
    });

    expect(prisma.account.update).not.toHaveBeenCalled();
  });

  it('does nothing without a parked profile', async () => {
    await onAccountCreated(db, { id: 'a9', providerId: 'github', accountId: '9', userId: 'u9' });

    expect(prisma.account.update).not.toHaveBeenCalled();
  });
});
