import { task, logger } from '@trigger.dev/sdk';
import { retryOnGitBlip } from '../helpers/gitRetry.ts';
import { simpleGit } from 'simple-git';
import fs from 'fs';
import path from 'path';
import os from 'os';
import getPrisma from '@classmoji/database';
import { ClassmojiService, getGitProvider } from '@classmoji/services';
import { CLASSMOJI_BOT_EMAIL, isStudentCommit, repoNamespace } from '@classmoji/utils';
import type { RepoContributions } from '@classmoji/utils/repo-contributions';
import {
  aggregateContributions,
  isCountedPath,
  LOG_FORMAT,
  parseBlamePorcelain,
  parseLog,
  type BlameLine,
} from '../helpers/contributionStats.ts';

/** Past these a repo is someone's dependencies or data, not their work: read no further. */
const MAX_FILES = 3000;
const MAX_FILE_BYTES = 512 * 1024;
/** Github commits looked up for their author's login; older ones match by email only. */
const MAX_API_COMMITS = 2000;

type Classroom = NonNullable<Awaited<ReturnType<typeof ClassmojiService.classroom.findById>>>;

/**
 * Clone a team repo into `dir` with a token the task mints itself (never one
 * in the payload, which the Trigger.dev dashboard shows): the Github app
 * installation's, or the org's Gitlab connection.
 */
async function cloneRepo(classroom: Classroom, repoName: string, dir: string) {
  const org = classroom.git_organization;
  if (!org?.login) throw new Error(`No git organization for classroom ${classroom.id}`);
  const token = await getGitProvider(org).getAccessToken();
  let remote: string;
  if (org.provider === 'GITLAB') {
    const host = new URL(org.base_url || ClassmojiService.gitlabInstance.defaultHost());
    await ClassmojiService.gitlabInstance.assertPublicGitlabHost(host.origin);
    remote = `${host.protocol}//oauth2:${token}@${host.host}/${repoNamespace(classroom)}/${repoName}.git`;
  } else {
    remote = `https://x-access-token:${token}@github.com/${org.login}/${repoName}.git`;
  }
  await simpleGit().clone(remote, dir);
}

/** Github's login for each commit it knows the author of, by sha. Gitlab has none to give. */
async function githubLogins(classroom: Classroom, repoName: string): Promise<Map<string, string>> {
  const org = classroom.git_organization;
  const logins = new Map<string, string>();
  if (!org?.login || org.provider === 'GITLAB') return logins;
  try {
    const commits = await getGitProvider(org).listCommits(org.login, repoName, {
      maxCommits: MAX_API_COMMITS,
      skipStats: true,
    });
    for (const c of commits) if (c.author_login) logins.set(c.sha, c.author_login);
  } catch (error) {
    // Emails still match most authors; a failed lookup is not a failed calculation.
    logger.warn('Github commit authors unavailable, matching by email only', {
      repoName,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return logins;
}

/** Read the clone: blame every counted text file, then the default branch's history. */
export async function readClone(dir: string) {
  const git = simpleGit({ baseDir: dir });
  const headSha = (await git.raw(['rev-parse', 'HEAD']).catch(() => '')).trim() || null;
  if (!headSha) {
    return { headSha, blame: [], commits: [], filesCounted: 0, filesSkipped: 0 };
  }

  // Text files only: `git grep -I` drops binaries. `-z`: names as they are.
  const listed = await git
    .raw(['grep', '-I', '-z', '--name-only', '-e', '', 'HEAD', '--'])
    .catch(() => '');
  const files = listed
    .split('\0')
    .filter(Boolean)
    .map(f => f.replace(/^HEAD:/, ''))
    .filter(isCountedPath);

  const blame: BlameLine[] = [];
  let filesCounted = 0;
  let filesSkipped = 0;
  for (const file of files) {
    if (filesCounted >= MAX_FILES) {
      filesSkipped += 1;
      continue;
    }
    const size = fs.statSync(path.join(dir, file), { throwIfNoEntry: false })?.size ?? 0;
    if (size > MAX_FILE_BYTES) {
      filesSkipped += 1;
      continue;
    }
    // `-w`: re-indenting a line does not take it from whoever wrote it. `--`: a
    // file name is always a path.
    const out = await git.raw(['blame', '-w', '--line-porcelain', 'HEAD', '--', file]);
    blame.push(...parseBlamePorcelain(out));
    filesCounted += 1;
  }

  const log = await git.raw(['log', `--format=${LOG_FORMAT}`, '--numstat', 'HEAD']);
  return { headSha, blame, commits: parseLog(log), filesCounted, filesSkipped };
}

export interface ContributionsPayload {
  classroomId: string;
  gitRepoId: string;
}

/**
 * Record a failure on the row so the page says so instead of showing old
 * numbers as current. Scoped by both ids, like the read in `run`.
 */
async function recordFailure({ classroomId, gitRepoId }: ContributionsPayload, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  await getPrisma()
    .gitRepo.updateMany({
      where: { id: gitRepoId, classroom_id: classroomId },
      data: {
        // A clone URL carries its token: never store one.
        contributions_error: message.replace(/https?:\/\/[^@\s/]+@/g, 'https://').slice(0, 500),
        contributions_calculated_at: new Date(),
      },
    })
    .catch(() => undefined);
}

export const calculateContributionsTask = task({
  id: 'calculate_repo_contributions',
  queue: {
    concurrencyLimit: 6,
  },
  machine: 'small-2x',
  // A clone is what Github blips break. Safe to repeat: a fresh checkout per
  // run, and the result overwrites the stored one.
  ...retryOnGitBlip,
  // Fires once, after the retries are spent: a blip that a retry then gets
  // past leaves no failure on the page.
  onFailure: async ({ payload, error }: { payload: ContributionsPayload; error: unknown }) => {
    await recordFailure(payload, error);
  },
  run: async ({ classroomId, gitRepoId }: ContributionsPayload) => {
    // The row is found by both ids, so a payload can never name another
    // classroom's repo.
    const gitRepo = await getPrisma().gitRepo.findFirst({
      where: { id: gitRepoId, classroom_id: classroomId, team_id: { not: null } },
      select: { id: true, name: true, created_at: true },
    });
    if (!gitRepo) throw new Error(`No team repo ${gitRepoId} in classroom ${classroomId}`);
    const classroom = await ClassmojiService.classroom.findById(classroomId);
    if (!classroom) throw new Error(`No classroom ${classroomId}`);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'contrib-'));
    try {
      await cloneRepo(classroom, gitRepo.name, dir);
      const [clone, logins, identities] = await Promise.all([
        readClone(dir),
        githubLogins(classroom, gitRepo.name),
        ClassmojiService.repoAnalytics.buildLoginToUserIdMap(classroomId, gitRepo.id),
      ]);

      // When the repo started: Classmoji's first commit in it (provisioning
      // pushes the template's history, then commits as the bot), or the row's
      // creation if earlier. A row made after the repo (an import, a re-sync)
      // must not turn students' earlier work into template history.
      const botDates = clone.commits
        .filter(c => c.email?.toLowerCase() === CLASSMOJI_BOT_EMAIL)
        .map(c => new Date(c.date).getTime())
        .filter(t => !Number.isNaN(t));
      const repoStartedAt = new Date(
        Math.min(gitRepo.created_at.getTime(), ...(botDates.length ? [Math.min(...botDates)] : []))
      );

      const stats: RepoContributions = aggregateContributions({
        ...clone,
        loginFor: sha => logins.get(sha) ?? null,
        resolveUser: c =>
          ClassmojiService.repoAnalytics.lookupUser(identities, logins.get(c.sha), c.email),
        // The template's history (dated before the repo existed) and Classmoji's
        // or an app's commits: the same rule lateness reads.
        isStarterCommit: c =>
          !isStudentCommit(
            { author_login: logins.get(c.sha) ?? null, author_email: c.email, ts: c.date },
            // isStudentCommit counts only commits strictly after this moment.
            new Date(repoStartedAt.getTime() - 1)
          ),
      });

      await getPrisma().gitRepo.update({
        where: { id: gitRepo.id },
        data: {
          contribution_stats: stats as unknown as object,
          contributions_calculated_at: new Date(),
          contributions_error: null,
        },
      });
      return {
        authors: stats.authors.length,
        total_lines: stats.total_lines,
        total_commits: stats.total_commits,
      };
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
});
