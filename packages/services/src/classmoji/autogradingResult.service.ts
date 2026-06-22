import getPrisma from '@classmoji/database';
import type { AutogradingResult, Prisma } from '@prisma/client';

export interface RecordResultInput {
  gitRepoId: string;
  commitSha: string;
  runId?: string | null;
  conclusion: string;
  totalTests?: number | null;
  passedTests?: number | null;
  details?: Prisma.InputJsonValue;
}

/**
 * Record one autograding run for a student repo (one row per push/run).
 * Advisory CI feedback — never written to the grade tables.
 */
export const recordResult = async (data: RecordResultInput) => {
  return getPrisma().autogradingResult.create({
    data: {
      git_repo_id: data.gitRepoId,
      commit_sha: data.commitSha,
      run_id: data.runId ?? null,
      conclusion: data.conclusion,
      total_tests: data.totalTests ?? null,
      passed_tests: data.passedTests ?? null,
      details: data.details,
    },
  });
};

/**
 * Latest result for a single repo (student-facing view).
 */
export const findLatestByGitRepoId = async (gitRepoId: string) => {
  return getPrisma().autogradingResult.findFirst({
    where: { git_repo_id: gitRepoId },
    orderBy: { reported_at: 'desc' },
  });
};

/**
 * Latest result per repo for a set of repos (instructor roster view),
 * keyed by git_repo_id.
 */
export const findLatestByGitRepoIds = async (
  gitRepoIds: string[]
): Promise<Map<string, AutogradingResult>> => {
  const latest = new Map<string, AutogradingResult>();
  if (!gitRepoIds.length) return latest;
  const rows = await getPrisma().autogradingResult.findMany({
    where: { git_repo_id: { in: gitRepoIds } },
    orderBy: { reported_at: 'desc' },
  });
  for (const row of rows) {
    if (!latest.has(row.git_repo_id)) latest.set(row.git_repo_id, row);
  }
  return latest;
};
