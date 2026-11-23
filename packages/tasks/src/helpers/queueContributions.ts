/**
 * Queue a contributions calculation for every team repo of one repository:
 * the web's "Calculate contributions" (the Repositories list and the
 * repository page) and the MCP `repo_contributions_calculate` tool.
 *
 * Both ids come from the caller's gate (the classroom it authorized, a
 * repository loaded inside it), and the task re-reads each row by both again,
 * so nothing here trusts a client id.
 */
import { tasks } from '@trigger.dev/sdk';
import getPrisma from '@classmoji/database';
import type {
  calculateContributionsTask,
  ContributionsPayload,
} from '../workflows/contribution.ts';

export class ContributionsNotTeamRepoError extends Error {
  constructor() {
    super('Contributions are calculated for team repositories only.');
  }
}

export interface QueueContributionsResult {
  /** Team repos a run was queued for. */
  numRepos: number;
}

export async function queueContributions(args: {
  classroomId: string;
  repositoryId: string;
  /** Run tags, e.g. the web's progress session. */
  tags?: string[];
}): Promise<QueueContributionsResult> {
  const prisma = getPrisma();
  const repository = await prisma.repository.findFirst({
    where: { id: args.repositoryId, classroom_id: args.classroomId },
    select: { id: true, type: true },
  });
  if (!repository) throw new Error('Repository not found in this classroom');
  if (repository.type !== 'GROUP') throw new ContributionsNotTeamRepoError();

  const repos = await prisma.gitRepo.findMany({
    where: {
      classroom_id: args.classroomId,
      repository_id: repository.id,
      team_id: { not: null },
    },
    select: { id: true },
  });
  if (repos.length === 0) return { numRepos: 0 };

  const items = repos.map(repo => ({
    payload: { classroomId: args.classroomId, gitRepoId: repo.id } satisfies ContributionsPayload,
    options: args.tags?.length ? { tags: args.tags } : undefined,
  }));
  // batchTrigger takes at most 1000 items at a time.
  for (let i = 0; i < items.length; i += 1000) {
    await tasks.batchTrigger<typeof calculateContributionsTask>(
      'calculate_repo_contributions',
      items.slice(i, i + 1000)
    );
  }
  return { numRepos: repos.length };
}
