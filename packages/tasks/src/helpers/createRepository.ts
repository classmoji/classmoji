import { simpleGit, type SimpleGit } from 'simple-git';
import { logger } from '@trigger.dev/sdk';
import path from 'path';
import fs from 'fs';

import { CLASSMOJI_BOT_EMAIL, getGitProvider } from '@classmoji/services';
import {
  LOW_MEMORY_GIT_CONFIG,
  fetchLfsObjects,
  isAncestor,
  parseRemoteHeads,
  pushBranchInChunks,
  pushLfsObjects,
  usesLfs,
} from './templatePush.ts';

// Public fallback template used when an instructor's configured template repo has
// no commits. An empty repo can't seed a student/team repo (the clone lands on an
// unborn branch and every push fails with "src refspec main does not match any"),
// so we seed from this shared repo instead. It must stay PUBLIC — the clone runs
// with the instructor's org installation token, which can't read classmoji-org
// private repos.
const FALLBACK_TEMPLATE_REPO = 'classmoji/empty-template';
const FALLBACK_TEMPLATE_URL = `https://github.com/${FALLBACK_TEMPLATE_REPO}.git`;

type GitOrganizationLike = Parameters<typeof getGitProvider>[0] & { login: string | null };

interface ClassroomForRepositoryCreation {
  git_organization: GitOrganizationLike;
}

export interface CreateRepositoryPayload {
  classroom: ClassroomForRepositoryCreation;
  repoName: string;
  templateOwner: string;
  templateRepo: string;
  organizationGithubPlan: string;
}

/** Whether the repository's .gitignore rules exclude `file`. */
const isIgnored = async (repoGit: SimpleGit, file: string): Promise<boolean> =>
  (await repoGit.checkIgnore([file])).length > 0;

/**
 * A repository a previous run left between pushing `feedback` and pushing
 * `updates`: exactly `main` and `feedback`. It lacks the welcome commit, the
 * Feedback pull request and `updates`, and is finished rather than skipped.
 */
export const isHalfInitialised = (heads: Map<string, string>): boolean =>
  heads.size === 2 && heads.has('main') && heads.has('feedback');

interface SetupTarget {
  gitProvider: ReturnType<typeof getGitProvider>;
  gitOrgLogin: string;
  repoName: string;
  organizationGithubPlan: string;
}

/**
 * The commit that puts `main` one ahead of `feedback`, so the Feedback pull
 * request has something to show. It adds the welcome file, unless the
 * repository's .gitignore excludes it: the instructor's choice stands, and an
 * empty commit opens the pull request instead.
 */
const commitWelcome = async (repoGit: SimpleGit, localPath: string): Promise<void> => {
  if (await isIgnored(repoGit, 'CLASSMOJI.md')) {
    await repoGit.commit('Start your feedback space', undefined, { '--allow-empty': null });
  } else {
    const classmojiPath = path.join(localPath, 'CLASSMOJI.md');
    fs.writeFileSync(classmojiPath, 'Hello! This is your gitRepo for the assignment. 📝\n');
    await repoGit.add('CLASSMOJI.md');
    await repoGit.commit('Add Classmoji welcome message');
  }
};

/**
 * The Feedback pull request is where staff comment on the code. Nothing
 * else depends on it, so a refusal (e.g. Github finding no commits between
 * the branches) is logged and the student still gets their repository,
 * rather than the whole creation failing.
 *
 * `unlessOneExists` first looks for a pull request from `main` into
 * `feedback`, in any state, and leaves the repository alone if there is one.
 */
const openFeedbackPullRequest = async (
  { gitProvider, gitOrgLogin, repoName }: SetupTarget,
  { unlessOneExists = false }: { unlessOneExists?: boolean } = {}
): Promise<void> => {
  try {
    if (unlessOneExists) {
      const octokit = await gitProvider.getOctokit();
      const { data } = await octokit.rest.pulls.list({
        owner: gitOrgLogin,
        repo: repoName,
        head: `${gitOrgLogin}:main`,
        base: 'feedback',
        state: 'all',
        per_page: 1,
      });
      if (data.length > 0) {
        logger.info(`${gitOrgLogin}/${repoName} already has its Feedback pull request`, {
          number: data[0].number,
        });
        return;
      }
    }
    await gitProvider.createPullRequest(
      gitOrgLogin,
      repoName,
      'feedback',
      'main',
      'Feedback',
      FeedbackPRMessage
    );
  } catch (error: unknown) {
    logger.warn(`Could not open the Feedback pull request on ${gitOrgLogin}/${repoName}`, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

/** Branch `updates` off the checked-out `main`, and protect it on paid plans. */
const pushUpdatesBranch = async (
  repoGit: SimpleGit,
  { gitProvider, gitOrgLogin, repoName, organizationGithubPlan }: SetupTarget
): Promise<void> => {
  await repoGit.checkoutLocalBranch('updates');
  await repoGit.push('origin', 'updates', ['--set-upstream']);

  if (organizationGithubPlan !== 'free') {
    await gitProvider.protectBranch(gitOrgLogin, repoName, 'updates');
  }

  await repoGit.checkout('main');
};

/**
 * Finish a half-initialised repository (see `isHalfInitialised`).
 *
 * Its `main` may hold student work by now, so the student repository itself
 * is cloned (not the template), and `main` is only ever added to with a plain
 * push, never rewritten: a student push landing meanwhile makes that push
 * fail, and the retry then finds `main` ahead. The welcome commit goes on only
 * while `main` is still where `feedback` is; once the student has committed,
 * `main` is already ahead and the pull request has something to show.
 *
 * At most one commit goes on top, so the clone is the tip alone, with file
 * contents only for the top-level files the welcome commit reads (.gitignore).
 */
const finishHalfInitialisedRepo = async (
  target: SetupTarget,
  {
    studentRepoUrl,
    localPath,
    heads,
  }: { studentRepoUrl: string; localPath: string; heads: Map<string, string> }
): Promise<void> => {
  const { gitOrgLogin, repoName } = target;
  const needsWelcomeCommit = heads.get('main') === heads.get('feedback');
  logger.info(`${gitOrgLogin}/${repoName} stopped partway through set-up; finishing it`, {
    main: heads.get('main'),
    feedback: heads.get('feedback'),
    needsWelcomeCommit,
  });

  await simpleGit({ config: LOW_MEMORY_GIT_CONFIG }).clone(studentRepoUrl, localPath, [
    '--branch',
    'main',
    '--single-branch',
    '--no-tags',
    '--depth',
    '1',
    '--filter=blob:none',
    '--sparse',
  ]);
  const repoGit = simpleGit({ baseDir: localPath, config: LOW_MEMORY_GIT_CONFIG });
  await repoGit.addConfig('user.name', 'Classmoji Bot');
  await repoGit.addConfig('user.email', CLASSMOJI_BOT_EMAIL);

  if (needsWelcomeCommit) {
    await commitWelcome(repoGit, localPath);
    await repoGit.push('origin', 'main');
  }

  await openFeedbackPullRequest(target, { unlessOneExists: true });
  await pushUpdatesBranch(repoGit, target);

  logger.info(`Finished setting up ${gitOrgLogin}/${repoName}`);
};

const isAlreadyExistsError = (error: unknown): error is { status: number; message?: string } => {
  return typeof error === 'object' && error !== null && 'status' in error;
};

export const createRepository = async (payload: CreateRepositoryPayload): Promise<string> => {
  const { classroom, repoName, templateOwner, templateRepo, organizationGithubPlan } = payload;
  const gitProvider = getGitProvider(classroom.git_organization);
  const gitOrgLogin = classroom.git_organization.login;

  if (!gitOrgLogin) {
    throw new Error('Missing Git organization login');
  }

  let repoId: string;
  try {
    const { id } = await gitProvider.createRepository(gitOrgLogin, repoName);
    repoId = id;
  } catch (error: unknown) {
    if (
      isAlreadyExistsError(error) &&
      error.status === 422 &&
      error.message?.includes('name already exists')
    ) {
      logger.info(`GitRepo ${gitOrgLogin}/${repoName} already exists, fetching existing repo`);
      const existingRepo = await gitProvider.getRepository(gitOrgLogin, repoName);
      repoId = existingRepo.id;
    } else {
      throw error;
    }
  }

  // Minted by this run rather than handed down in the payload: a token lasts
  // an hour from minting, and runs can wait in the queue longer than that.
  const token = await gitProvider.getAccessToken();
  const setupTarget: SetupTarget = { gitProvider, gitOrgLogin, repoName, organizationGithubPlan };

  const localPath = path.join(process.cwd(), 'repos', repoName);
  const studentRepoUrl = `https://x-access-token:${token}@github.com/${gitOrgLogin}/${repoName}.git`;
  const templateRepoUrl = `https://x-access-token:${token}@github.com/${templateOwner}/${templateRepo}.git`;

  const git = simpleGit({ config: LOW_MEMORY_GIT_CONFIG });

  try {
    if (fs.existsSync(localPath)) {
      fs.rmSync(localPath, { recursive: true, force: true });
    }

    // Safety guard: only initialize a repo that is still empty. A repo can
    // exist on GitHub without a DB row (a previous run failed partway), and
    // Sync will route it back through here — but if it already has branches it
    // may contain student work, and the force-push below would destroy it.
    // Skip template initialization and let the rest of the workflow heal the
    // DB row / collaborators instead. Two exceptions. A lone `main` holding
    // part of the template's own history (checked once `main` exists locally,
    // below): a large template is pushed in parts, and a run that stopped
    // between them is resumed rather than left half-copied. And `main` plus
    // `feedback` alone: a run that stopped after pushing both is finished,
    // without rewriting `main`. Read before the template is cloned, which a
    // repository that is skipped or finished does not need.
    const remoteHeads = await git.listRemote(['--heads', studentRepoUrl]);
    const heads = parseRemoteHeads(remoteHeads);
    if (isHalfInitialised(heads)) {
      await finishHalfInitialisedRepo(setupTarget, { studentRepoUrl, localPath, heads });
      return repoId;
    }
    const resumableMain = heads.size === 1 ? (heads.get('main') ?? null) : null;
    if (remoteHeads.trim().length > 0 && !resumableMain) {
      logger.warn(
        `${gitOrgLogin}/${repoName} already has branches — skipping template initialization to avoid overwriting existing work`,
        { remoteHeads }
      );
      return repoId;
    }

    // Only the template's default branch is pushed, so only it is fetched.
    // `--sparse` checks out the top-level files alone: the working tree is
    // needed just for the root .gitignore and CLASSMOJI.md, and a full
    // checkout of a game project doubles the disk it takes. Every commit
    // still carries the whole tree, so what is pushed is unchanged.
    await git.clone(templateRepoUrl, localPath, ['--single-branch', '--no-tags', '--sparse']);
    const repoGit = simpleGit({ baseDir: localPath, config: LOW_MEMORY_GIT_CONFIG });

    await repoGit.addConfig('user.name', 'Classmoji Bot');
    await repoGit.addConfig('user.email', CLASSMOJI_BOT_EMAIL);

    // Templates that keep their files in Git LFS: the clone holds only the
    // pointer files, so the objects are copied across separately.
    const lfsReady = (await usesLfs(repoGit)) && (await fetchLfsObjects(repoGit, 'origin'));

    await repoGit.removeRemote('origin');
    await repoGit.addRemote('origin', studentRepoUrl);

    // Does the cloned template have any commits? An *empty* template (no commits
    // at all — e.g. a freshly created "BlankProject") leaves the clone on an
    // unborn branch, so `git branch -M main` / `git push origin main` below would
    // fail with "src refspec main does not match any" and the student/team repo
    // would be created empty and broken.
    let templateHasCommits = true;
    try {
      await repoGit.raw(['rev-parse', '--verify', 'HEAD']);
    } catch {
      templateHasCommits = false;
    }

    if (templateHasCommits) {
      // Templates may use any default branch (e.g. `master` on older repos). The
      // clone checks out the template's default branch, but every step below — and
      // the feedback PR / branch protection / CLASSMOJI flow — assumes `main`, so
      // force-rename whatever was checked out to `main` before the first push.
      await repoGit.branch(['-M', 'main']);
    } else {
      // Empty template (no commits — e.g. a freshly created "BlankProject"). Seed
      // from Classmoji's shared, public empty-template repo (which ships a README)
      // so the student/team repo gets a real `main` with content instead of an
      // empty-tree commit. The CLASSMOJI.md commit further down still adds the
      // welcome file on top.
      logger.warn(
        `Template ${templateOwner}/${templateRepo} has no commits; seeding from ${FALLBACK_TEMPLATE_REPO}`
      );
      await repoGit.addRemote('seed', FALLBACK_TEMPLATE_URL);
      await repoGit.fetch('seed', 'main');
      await repoGit.checkout(['-B', 'main', 'seed/main']);
      await repoGit.removeRemote('seed');
    }

    if (resumableMain && !(await isAncestor(repoGit, resumableMain, 'main'))) {
      logger.warn(
        `${gitOrgLogin}/${repoName} already has a main branch that is not the template's — skipping template initialization to avoid overwriting existing work`,
        { remoteHeads }
      );
      return repoId;
    }
    if (resumableMain) {
      logger.info(`Resuming the template copy into ${gitOrgLogin}/${repoName}`, {
        alreadyPushed: resumableMain,
      });
    }

    // LFS objects first, so the branch never points at files Github lacks.
    if (lfsReady) {
      await pushLfsObjects(repoGit, 'origin');
    }

    await pushBranchInChunks(repoGit, {
      remote: 'origin',
      branch: 'main',
      alreadyPushed: resumableMain,
    });
    await repoGit.checkoutLocalBranch('feedback');
    await repoGit.push('origin', 'feedback', ['--set-upstream']);
    await repoGit.checkout('main');

    await commitWelcome(repoGit, localPath);
    await repoGit.push('origin', 'main');

    await openFeedbackPullRequest(setupTarget);
    await pushUpdatesBranch(repoGit, setupTarget);

    logger.info(`Successfully initialized ${gitOrgLogin}/${repoName} from template`);

    return repoId;
  } finally {
    if (fs.existsSync(localPath)) {
      fs.rmSync(localPath, { recursive: true, force: true });
    }
  }
};

const FeedbackPRMessage = `
This PR is your feedback 📝 space! Your instructor will leave comments and suggestions on your code here.

### How it works
- **Files changed** tab → See all your changes since the assignment started
- **Commits** tab → Review your commit history
- Your instructor can leave inline comments on specific lines of code

### ⚠️ Important
Don't close or merge this PR unless your instructor tells you to!

---
*This PR updates automatically as you push to main* ✨`;
