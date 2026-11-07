import { simpleGit, type SimpleGit } from 'simple-git';
import fs from 'fs';
import { AbortTaskRunError, logger } from '@trigger.dev/sdk';
import path from 'path';
import { isRepoNotFound, templateNotFoundMessage } from './gitErrors.ts';
import { reportFailureReason } from './progress.ts';
import { ClassmojiService, getGitProvider, type GitLabProvider } from '@classmoji/services';

type GitOrganizationLike = Parameters<typeof getGitProvider>[0] & { login: string | null };

/**
 * The template's default branch as a fully-qualified ref, so `git pull` always
 * reads it as a refspec. (`git pull` hands its refspecs on to `git fetch`
 * without a `--`, so a separator on the pull itself would not carry over.)
 * The merge it makes is the same as with the short name.
 */
export const branchRef = (branch: string): string => `refs/heads/${branch}`;

/**
 * The `updates` branch, by full ref names only, so a tag or a top-level file
 * also named `updates` can never stand in for it:
 * - checkout: `git checkout -B updates refs/remotes/origin/updates --` puts
 *   the local branch at the remote's copy (`git checkout updates` would land
 *   on a tag of that name, detached, and `git switch` refuses one);
 * - push: `refs/heads/updates:refs/heads/updates` (a bare `updates` would
 *   push the tag, or match both and fail).
 */
const CHECKOUT_UPDATES_FROM_ORIGIN = ['-B', 'updates', 'refs/remotes/origin/updates', '--'];
const PUSH_UPDATES = 'refs/heads/updates:refs/heads/updates';

/**
 * The student repository is cloned without its tags: an update needs only
 * the branches, and a tag can't then share a name with
 * `refs/remotes/origin/updates` (git would call the checkout's start point
 * ambiguous and stop).
 */
const CLONE_OPTIONS = ['--no-tags'];

/**
 * The template's HEAD, read through the `template` remote. A template that is
 * gone or unreadable is the instructor's to fix (it was renamed, deleted or made
 * private), so the run stops with that, not git's "repository not found".
 */
const readTemplateHead = async (studentGit: SimpleGit, template: string): Promise<string> => {
  try {
    return await studentGit.listRemote(['--symref', 'template', 'HEAD']);
  } catch (error: unknown) {
    if (isRepoNotFound(error)) {
      await reportFailureReason('template_not_found');
      throw new AbortTaskRunError(templateNotFoundMessage(template));
    }
    throw error;
  }
};

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

    await git.clone(studentRepoUrl, localPath, CLONE_OPTIONS);
    const studentGit = simpleGit(localPath);

    await studentGit.addConfig('user.name', 'Classmoji Bot');
    await studentGit.addConfig('user.email', 'hello@classmoji.com');
    await studentGit.addConfig('pull.rebase', 'false');

    // A fresh clone has no local `updates`; the remote's copy is the one an
    // earlier update left.
    const branches = await studentGit.branch();
    if (!branches.all.includes('remotes/origin/updates')) {
      logger.info('Updates branch does not exist, creating it from template');
      await studentGit.checkoutLocalBranch('updates');
    } else {
      await studentGit.checkout(CHECKOUT_UPDATES_FROM_ORIGIN);
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
    const templateSymref = await readTemplateHead(studentGit, `${templateOwner}/${templateRepo}`);
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

    await studentGit.pull('template', branchRef(templateDefaultBranch), [
      '-X',
      'theirs',
      '--no-edit',
    ]);
    await studentGit.push('origin', PUSH_UPDATES, ['--force']);

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
    await git.clone(remote(`${owner}/${repoName}`), localPath, CLONE_OPTIONS);
    const studentGit = simpleGit(localPath);
    await studentGit.addConfig('user.name', 'Classmoji Bot');
    await studentGit.addConfig('user.email', 'hello@classmoji.com');
    await studentGit.addConfig('pull.rebase', 'false');

    const branches = await studentGit.branch();
    if (branches.all.includes('remotes/origin/updates')) {
      await studentGit.checkout(CHECKOUT_UPDATES_FROM_ORIGIN);
    } else {
      await studentGit.checkoutLocalBranch('updates');
    }

    await studentGit.addRemote('template', remote(`${templateOwner}/${templateRepo}`));
    const templateSymref = await readTemplateHead(studentGit, `${templateOwner}/${templateRepo}`);
    const templateDefaultBranch = templateSymref.match(/^ref:\s+refs\/heads\/(\S+)\s+HEAD/m)?.[1];
    if (!templateDefaultBranch) {
      return { message: 'Template is empty — nothing to sync', prUrl: '', hasChanges: false };
    }
    await studentGit.pull('template', branchRef(templateDefaultBranch), [
      '-X',
      'theirs',
      '--no-edit',
      '--allow-unrelated-histories',
    ]);
    // ci.skip: the update branch is not a student's push to test.
    await studentGit.push('origin', PUSH_UPDATES, ['--force', '-o', 'ci.skip']);

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
