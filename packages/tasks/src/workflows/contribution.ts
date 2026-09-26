import { task } from '@trigger.dev/sdk';
import { simpleGit } from 'simple-git';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { ClassmojiService, getGitProvider } from '@classmoji/services';
import { repoNamespace } from '@classmoji/utils';

dotenv.config();

/**
 * Clone a student/team repo into `dir`: from GitHub with the installation token
 * the caller minted, or from the org's GitLab over its connection (GitLab
 * tokens rotate, so the task gets its own).
 */
async function cloneRepo(
  classroomSlug: string,
  repoName: string,
  accessToken: string,
  dir: string
) {
  const classroom = await ClassmojiService.classroom.findBySlug(classroomSlug);
  const org = classroom?.git_organization;
  if (!classroom || !org?.login) throw new Error(`No git organization for ${classroomSlug}`);
  let remote: string;
  if (org.provider === 'GITLAB') {
    const token = await getGitProvider(org).getAccessToken();
    const host = new URL(org.base_url || ClassmojiService.gitlabInstance.defaultHost());
    remote = `${host.protocol}//oauth2:${token}@${host.host}/${repoNamespace(classroom)}/${repoName}.git`;
  } else {
    remote = `https://x-access-token:${accessToken}@github.com/${org.login}/${repoName}.git`;
  }
  await simpleGit().clone(remote, dir);
}

async function calculateContributions(dir: string): Promise<string> {
  const git = simpleGit();
  await git.cwd(dir);

  // Get the list of files (recursively) from the Git gitRepo
  const files = await git.raw(['ls-tree', '--name-only', '-r', 'HEAD']);
  const fileList = files
    .split('\n')
    .filter(file => /\.(swift|js|css|jsx|py|cs|scss|ts)$/.test(file));

  const authorCounts: Record<string, number> = {};

  // Get blame information for each file
  for (const file of fileList) {
    const blame = await git.raw(['blame', '--line-porcelain', file]);
    const authors = blame.match(/^author (.*)$/gm); // Extract authors from the blame output

    if (authors) {
      authors.forEach(author => {
        const authorName = author.replace(/^author /, '');
        authorCounts[authorName] = (authorCounts[authorName] || 0) + 1;
      });
    }
  }

  // Sort authors by contribution count
  const sortedAuthors = Object.entries(authorCounts)
    .sort(([, a], [, b]) => b - a)
    .map(([author, count]) => `${count} ${author}`);

  // Print or save the result
  const result = sortedAuthors.join('\n');
  return result;
}

export const calculateContributionsTask = task({
  id: 'calculate_repo_contributions',
  queue: {
    concurrencyLimit: 6,
  },
  run: async (arg: { classroomSlug: string; repoName: string; accessToken?: string }) => {
    const { classroomSlug, repoName, accessToken = '' } = arg;
    // A fresh directory per run: concurrent runs never share a checkout.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'contrib-'));
    try {
      await cloneRepo(classroomSlug, repoName, accessToken, dir);
      const result = await calculateContributions(dir);
      const gitRepo = await ClassmojiService.gitRepo.findByName(classroomSlug, repoName);
      if (!gitRepo) throw new Error(`No repo ${repoName} in ${classroomSlug}`);
      await ClassmojiService.gitRepo.update(gitRepo.id, { contributions: result });
      return result;
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
});
