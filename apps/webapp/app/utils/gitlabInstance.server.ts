import getPrisma from '@classmoji/database';
import { parseGitlabId } from '@classmoji/utils';

/**
 * The GitLab instance a user signs in with: the instance id of their GitLab
 * account (null: the default instance, gitlab.com), or undefined when they
 * have no GitLab account. A user has at most one GitLab account.
 */
export async function gitlabInstanceForUser(userId: string): Promise<string | null | undefined> {
  const account = await getPrisma().account.findFirst({
    where: { user_id: userId, provider_id: 'gitlab' },
    select: { account_id: true },
  });
  return account ? parseGitlabId(account.account_id).instanceId : undefined;
}
