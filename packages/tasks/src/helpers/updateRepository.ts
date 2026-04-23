import { simpleGit } from 'simple-git';
import fs from 'fs';
import { logger } from '@trigger.dev/sdk';
import path from 'path';
import { getGitProvider } from '@classmoji/services';

type GitOrganizationLike = Parameters<typeof getGitProvider>[0] & { login: string | null };

export interface UpdateRepositoryPayload {
  gitOrganization: GitOrganizationLike;
  repoName: string;
  prTitle: string;
  prDescription: string;
  token: string;
  templateOwner: string;
  templateRepo: string;
}

interface UpdateRepositoryResult {
  message: string;
  prUrl: string;
  hasChanges: boolean;
}

export const updateRepository = async (
  payload: UpdateRepositoryPayload
): Promise<UpdateRepositoryResult> => {
  const { gitOrganization, repoName, prTitle, prDescription, token, templateOwner, templateRepo } =
    payload;

  if (!gitOrganization.login) {
    throw new Error('Missing Git organization login');
  }

  const gitProvider = getGitProvider(gitOrganization);
  const octokit = await gitProvider.getOctokit();
  const orgLogin = gitOrganization.login;

  const localPath = path.join(process.cwd(), 'repos', repoName);
  const studentRepoUrl = `https://x-access-token:${token}@github.com/${orgLogin}/${repoName}.git`;
  const templateRepoUrl = `https://x-access-token:${token}@github.com/${templateOwner}/${templateRepo}.git`;

  const git = simpleGit();

  try {
    if (fs.existsSync(localPath)) {
      fs.rmSync(localPath, { recursive: true, force: true });
    }

    await git.clone(studentRepoUrl, localPath);
    const studentGit = simpleGit(localPath);

    await studentGit.addConfig('user.name', 'Classmoji Bot');
    await studentGit.addConfig('user.email', 'hello@classmoji.com');
    await studentGit.addConfig('pull.rebase', 'false');

    const branches = await studentGit.branch();
    const updatesBranchExists =
      branches.all.includes('updates') || branches.all.includes('remotes/origin/updates');

    if (!updatesBranchExists) {
      logger.info('Updates branch does not exist, creating it from template');
      await studentGit.checkoutLocalBranch('updates');
    } else {
      await studentGit.checkout('updates');
    }

    try {
      await studentGit.addRemote('template', templateRepoUrl);
    } catch {
      await studentGit.remote(['set-url', 'template', templateRepoUrl]);
    }

    await studentGit.pull('template', 'main', ['-X', 'theirs', '--no-edit']);
    await studentGit.push('origin', 'updates', ['--force']);

    const { data: repoMeta } = await octokit.rest.repos.get({
      owner: orgLogin,
      repo: repoName,
    });

    const { data: existingPRs } = await octokit.rest.pulls.list({
      owner: orgLogin,
      repo: repoName,
      head: `${orgLogin}:updates`,
      base: repoMeta.default_branch,
      state: 'open',
    });

    const description = `${prDescription}\n\n---\n\n## Template Update\n\nThis PR brings the latest changes from the template repository.\n\n### ✅ To Merge\n\n1. Review the changes in the "Files changed" tab\n2. Click "Merge pull request" below\n3. If conflicts occur, resolve them in your editor`;

    let prUrl: string;
    if (existingPRs.length > 0) {
      await octokit.rest.pulls.update({
        owner: orgLogin,
        repo: repoName,
        pull_number: existingPRs[0].number,
        title: prTitle,
        body: description,
      });
      prUrl = existingPRs[0].html_url;
    } else {
      const pr = await octokit.rest.pulls.create({
        owner: orgLogin,
        repo: repoName,
        title: prTitle,
        head: 'updates',
        base: repoMeta.default_branch,
        body: description,
      });
      prUrl = pr.data.html_url;
    }

    logger.info(`Template update PR: ${prUrl}`);

    return {
      message: existingPRs.length > 0 ? 'PR updated' : 'PR created',
      prUrl,
      hasChanges: true,
    };
  } catch (error: unknown) {
    logger.error('Update repository error:', {
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    if (fs.existsSync(localPath)) {
      fs.rmSync(localPath, { recursive: true, force: true });
    }
  }
};
