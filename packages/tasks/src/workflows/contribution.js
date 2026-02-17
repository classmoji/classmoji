import { task } from '@trigger.dev/sdk';
import { simpleGit } from 'simple-git';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { ClassmojiService } from '@classmoji/services';

dotenv.config();

async function cloneRepo(org, repoName, accessToken) {
  const git = simpleGit();
  const remote = `https://x-access-token:${accessToken}@github.com/${org}/${repoName}.git`;
  await git.clone(remote);
}

async function calculateContributions(org, repoName) {
  // Set the directory where your Git repo is located
  const git = simpleGit();
  await git.cwd(repoName);

  // Get the list of files (recursively) from the Git repository
  const files = await git.raw(['ls-tree', '--name-only', '-r', 'HEAD']);
  const fileList = files
    .split('\n')
    .filter(file => /\.(swift|js|css|jsx|py|cs|scss|ts)$/.test(file));

  const authorCounts = {};

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

// Function to remove the Git repository directory
function removeRepo(repoName) {
  const repoDir = path.join(process.cwd(), repoName); // Path to your Git repository
  fs.rm(repoDir, { recursive: true, force: true }, err => {
    if (err) {
      console.error(`Error removing repository: ${err.message}`);
    }
  });
}

export const calculateContributionsTask = task({
  id: 'calculate_repo_contributions',
  queue: {
    concurrencyLimit: 6,
  },
  run: async arg => {
    const { orgLogin, repoName, accessToken } = arg;
    await cloneRepo(orgLogin, repoName, accessToken);
    const result = await calculateContributions(orgLogin, repoName);

    const repository = await ClassmojiService.repository.findByName(orgLogin, repoName);

    await ClassmojiService.repository.update(repository.id, {
      contributions: result,
    });

    removeRepo(repoName);
    return result;
  },
});
