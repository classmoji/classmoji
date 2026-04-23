import { simpleGit } from 'simple-git';
import { logger } from '@trigger.dev/sdk';
import path from 'path';
import fs from 'fs';

import { getGitProvider } from '@classmoji/services';

type GitOrganizationLike = Parameters<typeof getGitProvider>[0] & { login: string | null };

interface ClassroomForRepositoryCreation {
  git_organization: GitOrganizationLike;
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
      logger.info(`Repository ${gitOrgLogin}/${repoName} already exists, fetching existing repo`);
      const existingRepo = await gitProvider.getRepository(gitOrgLogin, repoName);
      repoId = existingRepo.id;
    } else {
      throw error;
    }
  }

  const localPath = path.join(process.cwd(), 'repos', repoName);
  const studentRepoUrl = `https://x-access-token:${token}@github.com/${gitOrgLogin}/${repoName}.git`;
  const templateRepoUrl = `https://x-access-token:${token}@github.com/${templateOwner}/${templateRepo}.git`;

  const git = simpleGit();

  try {
    if (fs.existsSync(localPath)) {
      fs.rmSync(localPath, { recursive: true, force: true });
    }

    await git.clone(templateRepoUrl, localPath);
    const repoGit = simpleGit(localPath);

    await repoGit.addConfig('user.name', 'Classmoji Bot');
    await repoGit.addConfig('user.email', 'hello@classmoji.com');

    await repoGit.removeRemote('origin');
    await repoGit.addRemote('origin', studentRepoUrl);

    await repoGit.push('origin', 'main', ['--force']);
    await repoGit.checkoutLocalBranch('feedback');
    await repoGit.push('origin', 'feedback', ['--set-upstream']);
    await repoGit.checkout('main');

    const classmojiPath = path.join(localPath, 'CLASSMOJI.md');
    fs.writeFileSync(classmojiPath, 'Hello! This is your repository for the assignment. 📝\n');

    await repoGit.add('CLASSMOJI.md');
    await repoGit.commit('Add Classmoji welcome message');
    await repoGit.push('origin', 'main');

    await gitProvider.createPullRequest(
      gitOrgLogin,
      repoName,
      'feedback',
      'main',
      'Feedback',
      FeedbackPRMessage
    );

    await repoGit.checkoutLocalBranch('updates');
    await repoGit.push('origin', 'updates', ['--set-upstream']);

    if (organizationGithubPlan !== 'free') {
      await gitProvider.protectBranch(gitOrgLogin, repoName, 'updates');
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
