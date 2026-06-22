import getPrisma from '@classmoji/database';
import type { AutogradingComparison, AutogradingMethod } from '@prisma/client';

export interface AutogradingTestInput {
  name: string;
  method?: AutogradingMethod;
  setup_command?: string | null;
  run_command?: string | null;
  input?: string | null;
  expected_output?: string | null;
  comparison_method?: AutogradingComparison;
  timeout?: number | null;
  points?: number | null;
}

/**
 * List a repository's autograding tests in display/run order.
 */
export const findByRepositoryId = async (repositoryId: string) => {
  return getPrisma().autogradingTest.findMany({
    where: { repository_id: repositoryId },
    orderBy: { position: 'asc' },
  });
};

/**
 * Replace the full set of tests for a repository (delete + recreate in order).
 * Position is derived from array order — the UI owns the ordering.
 */
export const replaceForRepository = async (repositoryId: string, tests: AutogradingTestInput[]) => {
  const prisma = getPrisma();
  return prisma.$transaction(async tx => {
    await tx.autogradingTest.deleteMany({ where: { repository_id: repositoryId } });
    if (tests.length) {
      await tx.autogradingTest.createMany({
        data: tests.map((t, i) => ({
          repository_id: repositoryId,
          name: t.name,
          method: t.method ?? 'COMMAND',
          setup_command: t.setup_command ?? null,
          run_command: t.run_command ?? null,
          input: t.input ?? null,
          expected_output: t.expected_output ?? null,
          comparison_method: t.comparison_method ?? 'INCLUDED',
          timeout: t.timeout ?? 10,
          points: t.points ?? null,
          position: i,
        })),
      });
    }
    return tx.autogradingTest.findMany({
      where: { repository_id: repositoryId },
      orderBy: { position: 'asc' },
    });
  });
};
