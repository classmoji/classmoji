import { simpleGit } from 'simple-git';
import fs from 'fs';
import { logger } from '@trigger.dev/sdk';
import path from 'path';
import { ClassmojiService, getGitProvider, type GitLabProvider } from '@classmoji/services';

type GitOrganizationLike = Parameters<typeof getGitProvider>[0] & { login: string | null };

export interface UpdateRepositoryPayload {
  gitOrganization: GitOrganizationLike;
  repoName: string;
  prTitle: string;
  prDescription: string;
  /**
   * Ignored. Runs queued before the token was minted here still carry one; it
   * may have expired while they waited, so a fresh one is minted instead.
   */
  token?: string;
  templateOwner: string;
  templateRepo: string;
  /** GitLab: the class subgroup the student project lives in. */
  repoOwner?: string | null;
}

interface UpdateRepositoryResult {
  message: string;
  prUrl: string;
  hasChanges: boolean;
}

export const updateRepository = async (
  payload: UpdateRepositoryPayload
): Promise<UpdateRepositoryResult> => {
  const { gitOrganization, repoName, prTitle, prDescription, templateOwner, templateRepo } =
    payload;

  if (!gitOrganization.login) {
    throw new Error('Missing Git organization login');
  }
  if (gitOrganization.provider === 'GITLAB') return updateGitLabRepository(payload);

  const gitProvider = getGitProvider(gitOrganization);
  const octokit = await gitProvider.getOctokit();
  const orgLogin = gitOrganization.login;
  // Minted per run: an installation token lasts an hour from minting, however
  // long the run sat in the queue.
  const token = await gitProvider.getAccessToken();

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

    // Templates may use any default branch (e.g. `master` on older repos) and we
    // can't rename the instructor's repo, so resolve which branch the template's
    // HEAD points at instead of assuming `main`. Student repos are normalized to
    // `main` at creation; pulling template/<master> into the student's `updates`
    // branch is a normal cross-name merge.
    const templateSymref = await studentGit.listRemote(['--symref', 'template', 'HEAD']);
    const templateDefaultBranch = templateSymref.match(/^ref:\s+refs\/heads\/(\S+)\s+HEAD/m)?.[1];

    // An *empty* template (no commits at all — e.g. a freshly created
    // "BlankProject") has no HEAD ref, so there is nothing to pull. Attempting
    // `git pull template main` here would throw "couldn't find remote ref main".
    // Treat it as a clean no-op so a sync against an empty template doesn't error.
    if (!templateDefaultBranch) {
      logger.warn(
        `Template ${templateOwner}/${templateRepo} has no commits; skipping update for ${orgLogin}/${repoName}`
      );
      return {
        message: 'Template is empty — nothing to sync',
        prUrl: '',
        hasChanges: false,
      };
    }

    await studentGit.pull('template', templateDefaultBranch, ['-X', 'theirs', '--no-edit']);
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

    const description = `${prDescription}\n\n---\n\n## Template Update\n\nThis PR brings the latest changes from the template gitRepo.\n\n### ✅ To Merge\n\n1. Review the changes in the "Files changed" tab\n2. Click "Merge pull request" below\n3. If conflicts occur, resolve them in your editor`;

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
    logger.error('Update gitRepo error:', {
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    if (fs.existsSync(localPath)) {
      fs.rmSync(localPath, { recursive: true, force: true });
    }
  }
};

/**
 * GitLab: pull the template's latest into the project's `updates` branch and
 * open (or refresh) a merge request into its default branch. Same flow as
 * GitHub's, over the org's GitLab host with the connection's current token
 * (committed as the Classmoji bot; a push to `updates` is never a submission).
 */
async function updateGitLabRepository(
  payload: UpdateRepositoryPayload
): Promise<UpdateRepositoryResult> {
  const { gitOrganization, repoName, prTitle, prDescription, templateOwner, templateRepo } =
    payload;
  const owner = payload.repoOwner || gitOrganization.login;
  if (!owner) throw new Error('Missing Gitlab class subgroup');

  const provider = getGitProvider(gitOrganization) as GitLabProvider;
  const token = await provider.getAccessToken();
  const host = new URL(gitOrganization.base_url || ClassmojiService.gitlabInstance.defaultHost());
  await ClassmojiService.gitlabInstance.assertPublicGitlabHost(host.origin);
  const remote = (fullPath: string) =>
    `${host.protocol}//oauth2:${token}@${host.host}/${fullPath}.git`;

  const localPath = path.join(process.cwd(), 'repos', `update-${repoName}`);
  const git = simpleGit();
  try {
    if (fs.existsSync(localPath)) fs.rmSync(localPath, { recursive: true, force: true });
    await git.clone(remote(`${owner}/${repoName}`), localPath);
    const studentGit = simpleGit(localPath);
    await studentGit.addConfig('user.name', 'Classmoji Bot');
    await studentGit.addConfig('user.email', 'hello@classmoji.com');
    await studentGit.addConfig('pull.rebase', 'false');

    const branches = await studentGit.branch();
    if (branches.all.includes('remotes/origin/updates')) await studentGit.checkout('updates');
    else await studentGit.checkoutLocalBranch('updates');

    await studentGit.addRemote('template', remote(`${templateOwner}/${templateRepo}`));
    const templateSymref = await studentGit.listRemote(['--symref', 'template', 'HEAD']);
    const templateDefaultBranch = templateSymref.match(/^ref:\s+refs\/heads\/(\S+)\s+HEAD/m)?.[1];
    if (!templateDefaultBranch) {
      return { message: 'Template is empty — nothing to sync', prUrl: '', hasChanges: false };
    }
    await studentGit.pull('template', templateDefaultBranch, [
      '-X',
      'theirs',
      '--no-edit',
      '--allow-unrelated-histories',
    ]);
    // ci.skip: the update branch is not a student's push to test.
    await studentGit.push('origin', 'updates', ['--force', '-o', 'ci.skip']);

    const defaultBranch = await provider.getDefaultBranch(owner, repoName);
    const description = `${prDescription}\n\n---\n\n## Template Update\n\nThis brings the latest changes from the template repository.\n\n### To merge\n\n1. Review the changes in the "Changes" tab\n2. Click "Merge"\n3. If conflicts occur, resolve them in your editor`;
    const existing = await provider.findOpenMergeRequest(owner, repoName, 'updates', defaultBranch);
    const url = existing
      ? (await provider.updateMergeRequest(owner, repoName, existing.iid, prTitle, description)).url
      : (
          await provider.createPullRequest(
            owner,
            repoName,
            defaultBranch,
            'updates',
            prTitle,
            description
          )
        ).url;
    logger.info(`Template update merge request: ${url}`);
    return {
      message: existing ? 'Pull request updated' : 'Pull request created',
      prUrl: url,
      hasChanges: true,
    };
  } finally {
    if (fs.existsSync(localPath)) fs.rmSync(localPath, { recursive: true, force: true });
  }
}
