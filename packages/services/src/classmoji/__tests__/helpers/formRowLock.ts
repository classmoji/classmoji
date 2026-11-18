/**
 * A deterministic interleaving around a form's row lock, for the integration
 * suites.
 *
 * One transaction takes `SELECT … FOR UPDATE` on the form row (what a switch
 * of the form's mode holds), the call under test starts, and the helper waits
 * until Postgres reports that call BLOCKED on the holder (`pg_blocking_pids`).
 * Only then does the holder run `whileHeld` (the competing write) and commit,
 * so the call under test is guaranteed to make its decision after that write,
 * from what it reads under the lock. No sleeps decide the order.
 *
 * A call that never blocks fails the helper outright: a test that passes
 * without the interleaving it describes proves nothing.
 */
import getPrisma from '@classmoji/database';
import type { Prisma } from '@classmoji/database/client';

export type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown };

export async function raceAgainstFormLock<T>({
  formId,
  contender,
  whileHeld,
  waitMs = 10_000,
}: {
  formId: string;
  /** The call under test. Started once the holder has the lock. */
  contender: () => Promise<T>;
  /** Run inside the holder's transaction, after the contender is seen waiting. */
  whileHeld: (tx: Prisma.TransactionClient) => Promise<unknown>;
  waitMs?: number;
}): Promise<Settled<T>> {
  const prisma = getPrisma();

  let markLocked!: (pid: number) => void;
  const locked = new Promise<number>(resolve => (markLocked = resolve));
  let release!: (proceed: boolean) => void;
  const released = new Promise<boolean>(resolve => (release = resolve));

  const holder = prisma.$transaction(
    async tx => {
      const [{ pid }] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      await tx.$queryRaw`SELECT id FROM forms WHERE id = ${formId} FOR UPDATE`;
      markLocked(pid);
      // On a failed wait the holder writes nothing and rolls back.
      if (!(await released)) throw new Error('released without proceeding');
      await whileHeld(tx);
    },
    { timeout: waitMs + 20_000, maxWait: 10_000 }
  );
  // Surfaced by the `await holder` below; this only keeps an early rejection
  // from being reported as unhandled while the contender is being set up.
  holder.catch(() => {});

  let settled: Settled<T> | null = null;
  let outcome: Promise<Settled<T>> | null = null;
  let proceed = false;
  try {
    const holderPid = await Promise.race([
      locked,
      holder.then(() => {
        throw new Error('the lock holder finished before taking the lock');
      }),
    ]);

    outcome = contender().then(
      value => (settled = { ok: true, value }),
      error => (settled = { ok: false, error })
    );

    const deadline = Date.now() + waitMs;
    for (;;) {
      if (settled) {
        throw new Error(
          `the call under test finished without waiting for the form lock: ${JSON.stringify(settled)}`
        );
      }
      const [{ waiting }] = await prisma.$queryRaw<{ waiting: number }[]>`
        SELECT count(*)::int AS waiting
        FROM pg_stat_activity
        WHERE ${holderPid}::int = ANY(pg_blocking_pids(pid))
      `;
      if (waiting > 0) {
        proceed = true;
        break;
      }
      if (Date.now() > deadline)
        throw new Error('the call under test never waited for the form lock');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  } finally {
    // Always let the holder end, so a failed test leaves no lock behind on a
    // shared database; it commits only when the interleaving happened.
    release(proceed);
    if (!proceed) {
      await holder.catch(() => {});
      await outcome;
    }
  }
  await holder;
  if (!outcome) throw new Error('the call under test never started');
  return outcome;
}
