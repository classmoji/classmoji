import { simpleGit } from 'simple-git';
import { logger } from '@trigger.dev/sdk';
import path from 'path';
import fs from 'fs';

import { getGitProvider } from '@classmoji/services';

export const createRepository = async payload => {
  const { classroom, repoName, templateOwner, templateRepo, token, organizationGithubPlan } =
    payload;
  const gitProvider = getGitProvider(classroom.git_organization);
  const gitOrgLogin = classroom.git_organization.login;

  // Create empty student repository (or get existing one if already created)
  let repoId;
  try {
    const { id } = await gitProvider.createRepository(gitOrgLogin, repoName);
    repoId = id;
  } catch (error) {
    // Handle "already exists" error - fetch the existing repo's ID
    if (error.status === 422 && error.message?.includes('name already exists')) {
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

  // Clean up any existing local directory before cloning
  if (fs.existsSync(localPath)) {
    fs.rmSync(localPath, { recursive: true, force: true });
  }

  // Clone TEMPLATE repo (not student repo)
  await git.clone(templateRepoUrl, localPath);
  const repoGit = simpleGit(localPath);

  // Configure git user
  await repoGit.addConfig('user.name', 'Classmoji Bot');
  await repoGit.addConfig('user.email', 'hello@classmoji.com');

  // Change origin remote to point to student repo
  await repoGit.removeRemote('origin');
  await repoGit.addRemote('origin', studentRepoUrl);

  // Push template content to student repo
  await repoGit.push('origin', 'main', ['--force']);

  // Create feedback branch from main (this stays frozen as the base)
  await repoGit.checkoutLocalBranch('feedback');
  await repoGit.push('origin', 'feedback', ['--set-upstream']);

  // Switch back to main and add CLASSMOJI.md
  await repoGit.checkout('main');

  // Add CLASSMOJI.md to main to create initial diff for PR
  const classmojiPath = path.join(localPath, 'CLASSMOJI.md');
  fs.writeFileSync(classmojiPath, "Hello! This is your repository for the assignment. 📝\n");

  await repoGit.add('CLASSMOJI.md');
  await repoGit.commit('Add Classmoji welcome message');
  await repoGit.push('origin', 'main');

  // Create feedback PR (main → feedback)
  await gitProvider.createPullRequest(
    gitOrgLogin,
    repoName,
    'feedback', // base - frozen starter code
    'main', // head - student's work (starts with CLASSMOJI.md)
    'Feedback',
    FeedbackPRMessage
    );

  // Create updates branch from main
  await repoGit.checkoutLocalBranch('updates');

  // Push updates branch to origin
  await repoGit.push('origin', 'updates', ['--set-upstream']);

  // Protect updates branch from student modifications
  if (organizationGithubPlan !== 'free') {
    await gitProvider.protectBranch(gitOrgLogin, repoName, 'updates');
  }

  // Switch back to main
  await repoGit.checkout('main');

  logger.info(`Successfully initialized ${gitOrgLogin}/${repoName} from template`);

  // Clean up local directory after all operations
  if (fs.existsSync(localPath)) {
    fs.rmSync(localPath, { recursive: true, force: true });
  }

  return repoId;
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