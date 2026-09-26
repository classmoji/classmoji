import { simpleGit } from 'simple-git';
import { logger } from '@trigger.dev/sdk';
import path from 'path';
import fs from 'fs';

import { CLASSMOJI_BOT_EMAIL, getGitProvider, type GitLabProvider } from '@classmoji/services';
import { gitTerms, repoNamespace, type GitTerms } from '@classmoji/utils';

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
  /** GitLab: the class subgroup student repos live in. Null/absent on Github. */
  git_namespace?: string | null;
  git_organization: GitOrganizationLike;
}

/**
 * Authenticated HTTPS remote for `owner/repo` on the classroom's provider.
 * Github installation tokens use `x-access-token`; GitLab OAuth tokens use
 * `oauth2`, on the configured instance.
 */
function authedRemote(provider: string, token: string, fullPath: string): string {
  if (provider === 'GITLAB') {
    const host = (process.env.GITLAB_URL || process.env.GITLAB_ISSUER || 'https://gitlab.com')
      .replace(/\/+$/, '')
      .replace(/^https?:\/\//, '');
    return `https://oauth2:${token}@${host}/${fullPath}.git`;
  }
  return `https://x-access-token:${token}@github.com/${fullPath}.git`;
}

export interface CreateRepositoryPayload {
  classroom: ClassroomForRepositoryCreation;
  repoName: string;
  templateOwner: string;
  templateRepo: string;
  token: string;
  organizationGithubPlan: string;
}

const isAlreadyExistsError = (error: unknown): error is { status: number; message?: string } => {
  return typeof error === 'object' && error !== null && 'status' in error;
};

export const createRepository = async (payload: CreateRepositoryPayload): Promise<string> => {
  const { classroom, repoName, templateOwner, templateRepo, token, organizationGithubPlan } =
    payload;
  const gitProvider = getGitProvider(classroom.git_organization);
  // The org on Github; the class subgroup on GitLab. Named for the Github case
  // it started as, since every call below takes it as the repo owner.
  const gitOrgLogin = repoNamespace(classroom);

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
      // Github says "name already exists"; GitLab "has already been taken".
      (error.message?.includes('name already exists') ||
        error.message?.includes('has already been taken'))
    ) {
      logger.info(`GitRepo ${gitOrgLogin}/${repoName} already exists, fetching existing repo`);
      const existingRepo = await gitProvider.getRepository(gitOrgLogin, repoName);
      repoId = existingRepo.id;
    } else {
      throw error;
    }
  }

  const localPath = path.join(process.cwd(), 'repos', repoName);
  const provider = classroom.git_organization.provider;
  // GitLab runs CI on every push to a project with a .gitlab-ci.yml, and these
  // setup pushes run as the instructor's connection: without this, each new
  // student project fires several pipelines (and failure emails) at them.
  // Students' own pushes are untouched.
  const setupPush = provider === 'GITLAB' ? ['-o', 'ci.skip'] : [];
  const terms = gitTerms(provider === 'GITLAB');
  const studentRepoUrl = authedRemote(provider, token, `${gitOrgLogin}/${repoName}`);
  const templateRepoUrl = authedRemote(provider, token, `${templateOwner}/${templateRepo}`);

  const git = simpleGit();

  try {
    if (fs.existsSync(localPath)) {
      fs.rmSync(localPath, { recursive: true, force: true });
    }

    await git.clone(templateRepoUrl, localPath);
    const repoGit = simpleGit(localPath);

    await repoGit.addConfig('user.name', 'Classmoji Bot');
    await repoGit.addConfig('user.email', CLASSMOJI_BOT_EMAIL);

    await repoGit.removeRemote('origin');
    await repoGit.addRemote('origin', studentRepoUrl);

    // Safety guard: only initialize a repo that is still empty. A repo can
    // exist on GitHub without a DB row (a previous run failed partway), and
    // Sync will route it back through here — but if it already has branches it
    // may contain student work, and the force-push below would destroy it.
    // Skip template initialization and let the rest of the workflow heal the
    // DB row / collaborators instead.
    const remoteHeads = await repoGit.listRemote(['--heads', 'origin']);
    if (remoteHeads.trim().length > 0) {
      logger.warn(
        `${gitOrgLogin}/${repoName} already has branches — skipping template initialization to avoid overwriting existing work`,
        { remoteHeads }
      );
      return repoId;
    }

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

    await repoGit.push('origin', 'main', ['--force', ...setupPush]);
    await repoGit.checkoutLocalBranch('feedback');
    await repoGit.push('origin', 'feedback', ['--set-upstream', ...setupPush]);
    await repoGit.checkout('main');

    const classmojiPath = path.join(localPath, 'CLASSMOJI.md');
    fs.writeFileSync(classmojiPath, `Hello! This is your ${terms.repo} for the assignment. 📝\n`);

    await repoGit.add('CLASSMOJI.md');
    await repoGit.commit('Add Classmoji welcome message');
    await repoGit.push('origin', 'main', setupPush);

    await gitProvider.createPullRequest(
      gitOrgLogin,
      repoName,
      'feedback',
      'main',
      'Feedback',
      feedbackMessage(terms)
    );

    await repoGit.checkoutLocalBranch('updates');
    await repoGit.push('origin', 'updates', ['--set-upstream', ...setupPush]);

    if (organizationGithubPlan !== 'free') {
      await gitProvider.protectBranch(gitOrgLogin, repoName, 'updates');
    }

    // GitLab protects `main` for Maintainers only; students are Developers.
    if (provider === 'GITLAB') {
      await (gitProvider as GitLabProvider).allowDeveloperPushes(gitOrgLogin, repoName, 'main');
    }

    await repoGit.checkout('main');

    logger.info(`Successfully initialized ${gitOrgLogin}/${repoName} from template`);

    return repoId;
  } finally {
    if (fs.existsSync(localPath)) {
      fs.rmSync(localPath, { recursive: true, force: true });
    }
  }
};

/** The Feedback PR/MR body, in the provider's own words. */
const feedbackMessage = (terms: GitTerms) => `
This ${terms.pr} is your feedback 📝 space! Your instructor will leave comments and suggestions on your code here.

### How it works
- **${terms.changesTab}** tab → See all your changes since the assignment started
- **Commits** tab → Review your commit history
- Your instructor can leave inline comments on specific lines of code

### ⚠️ Important
Don't close or merge this ${terms.pr} unless your instructor tells you to!

---
*This ${terms.pr} updates automatically as you push to main* ✨`;
