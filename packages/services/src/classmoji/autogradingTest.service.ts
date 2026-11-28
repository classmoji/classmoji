import getPrisma from '@classmoji/database';
import type { AutogradingComparison, AutogradingMethod } from '@classmoji/database/client';
import { NO_SERVICE_AUDIT, recordForActor, type AuditActor } from './audit.service.ts';

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

/** A test as the replace compares it: every column it writes, in order. */
const testKey = (t: Record<string, unknown>) =>
  JSON.stringify([
    t.name,
    t.method,
    t.setup_command,
    t.run_command,
    t.input,
    t.expected_output,
    t.comparison_method,
    t.timeout,
    t.points,
  ]);

/**
 * Replace the full set of tests for a repository (delete + recreate in order).
 * Position is derived from array order — the UI owns the ordering.
 *
 * The tests it replaces are read in the same transaction, under the
 * repository row's lock (`FOR NO KEY UPDATE`), so overlapping saves of one
 * repository run one after the other, and a set that
 * changed is recorded for `actor` after the commit: REPOSITORIES / UPDATE on
 * the repository, `fields: ['autograding_tests']` with the
 * `autograding_tests` and `previous_autograding_tests` counts (tests hold
 * commands and expected output: counts only). The same tests again, or
 * `actor: null`: no row. `classroomId` is the repository's classroom (the
 * caller has checked it), for the row.
 */
export const replaceForRepository = async (
  repositoryId: string,
  tests: AutogradingTestInput[],
  classroomId: string,
  actor: AuditActor | null
) => {
  const prisma = getPrisma();
  const { before, saved } = await prisma.$transaction(async tx => {
    // The repository row's lock: a second save of this repository's tests
    // waits here, so the set it reads as `before` is the one it replaces.
    await tx.$queryRaw`
      SELECT id FROM repositories
      WHERE id = ${repositoryId} AND classroom_id = ${classroomId}
      FOR NO KEY UPDATE`;
    const before = await tx.autogradingTest.findMany({
      where: { repository_id: repositoryId },
      orderBy: { position: 'asc' },
    });
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
    const saved = await tx.autogradingTest.findMany({
      where: { repository_id: repositoryId },
      orderBy: { position: 'asc' },
    });
    return { before, saved };
  });
  const changed =
    before.length !== saved.length || before.some((t, i) => testKey(t) !== testKey(saved[i]));
  const audit = changed
    ? await recordForActor(actor, {
        classroomId,
        resourceType: 'REPOSITORIES',
        resourceId: repositoryId,
        action: 'UPDATE',
        data: {
          fields: ['autograding_tests'],
          autograding_tests: saved.length,
          previous_autograding_tests: before.length,
        },
      })
    : NO_SERVICE_AUDIT;
  return { tests: saved, audit };
};
