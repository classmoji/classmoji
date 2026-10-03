import { createDecipheriv, createHash } from 'node:crypto';
import { PrismaClient, Prisma } from '@prisma/client';
import dayjs, { type Dayjs } from 'dayjs';
import { createOneShotShutdown } from '@classmoji/utils';

interface TokenTransaction {
  hours_purchased?: number | null;
}

const calculateExtensionHours = (tokenTransactions: TokenTransaction[]): number => {
  return (tokenTransactions || []).reduce(
    (acc, transaction) => acc + (transaction.hours_purchased || 0),
    0
  );
};

const calculateLateHours = (
  closedAt: Date | Dayjs | null,
  studentDeadline: Date | Dayjs | string,
  tokenTransactions: TokenTransaction[]
): number => {
  let totalHoursLate = dayjs(closedAt || dayjs()).diff(studentDeadline, 'hours');
  totalHoursLate = Math.max(totalHoursLate, 0);
  // Never negative: hours bought beyond the lateness (ahead of the deadline,
  // say) are spare, not a credit.
  return Math.max(totalHoursLate - calculateExtensionHours(tokenTransactions), 0);
};

/** The deadline pushed out by the extension hours bought with tokens. */
const extendedDeadline = (
  studentDeadline: Date | Dayjs | string | undefined,
  tokenTransactions: TokenTransaction[] | undefined
): Dayjs =>
  dayjs(studentDeadline).add(Math.max(calculateExtensionHours(tokenTransactions ?? []), 0), 'hour');

const DEFAULT_AVATAR_URL = 'https://cdn-icons-png.flaticon.com/512/25/25231.png';

export {
  GIT_IDENTITY,
  gitScopeProvider,
  whereGitUsername,
  whereGitUsernameIn,
  type GitUsernameScope,
} from './gitIdentity.ts';

// ─── OAuth tokens at rest ────────────────────────────────────────────────────
//
// OAuth tokens (sign-in accounts, Gitlab connections) are stored as plain
// text. Encryption at rest was switched off: other readers (the ai-agent
// service) read the columns directly, and a lost BETTER_AUTH_SECRET would have
// made every stored token unreadable. Values written while it was on carry the
// `enc1:` prefix and are still decrypted on read (keyed off BETTER_AUTH_SECRET);
// the decryptOAuthTokens script turns them back into plain text.

const TOKEN_PREFIX = 'enc1:';
const TOKEN_FIELDS = {
  account: ['access_token', 'refresh_token', 'id_token'],
  gitLabConnection: ['access_token', 'refresh_token'],
} as const;

function tokenKey(): Buffer {
  const secret = process.env.BETTER_AUTH_SECRET;
  // Never the public development key in production: tokens written with it are
  // as good as plain text, and ones written with the real key would read back
  // as null. Every process that touches tokens (webapp, workers, hook-station,
  // ai-agent) needs BETTER_AUTH_SECRET.
  if (!secret && process.env.NODE_ENV === 'production') {
    throw new Error('BETTER_AUTH_SECRET is not set: encrypted OAuth tokens cannot be read');
  }
  return createHash('sha256')
    .update(`classmoji:oauth-token:${secret || 'dev-secret-change-in-production-32chars!'}`)
    .digest();
}

export function decryptToken(value: string | null): string | null {
  if (value == null || !value.startsWith(TOKEN_PREFIX)) return value;
  try {
    const [iv, tag, data] = value.slice(TOKEN_PREFIX.length).split('.');
    const decipher = createDecipheriv('aes-256-gcm', tokenKey(), Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(data, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  } catch (error: unknown) {
    // A missing secret is a misconfiguration, not a bad token: say so loudly.
    if (!process.env.BETTER_AUTH_SECRET && process.env.NODE_ENV === 'production') throw error;
    // Wrong key (BETTER_AUTH_SECRET rotated) or damaged: no token, so callers
    // refresh or ask the person to reconnect instead of sending garbage.
    console.error('[database] could not decrypt a stored OAuth token');
    return null;
  }
}

/**
 * Refuse a query that filters on a token column: the stored value is
 * encrypted with a random IV, so such a filter can never match and would fail
 * silently (a compare-and-swap that never writes, a clear that clears
 * nothing). Compare decrypted values in code instead.
 */
function assertNoTokenFilter(fields: readonly string[], where: unknown) {
  if (!where || typeof where !== 'object') return;
  for (const [key, value] of Object.entries(where as Record<string, unknown>)) {
    // Presence checks (`null`, `{ not: null }`) are fine; comparing to a value is not.
    const comparesValue =
      typeof value === 'string' ||
      (value !== null &&
        typeof value === 'object' &&
        Object.values(value as Record<string, unknown>).some(
          v => typeof v === 'string' || Array.isArray(v)
        ));
    if (fields.includes(key) && comparesValue) {
      throw new Error(`Cannot filter on the encrypted column ${key}; compare it in code`);
    }
    if ((key === 'AND' || key === 'OR' || key === 'NOT') && value) {
      for (const inner of Array.isArray(value) ? value : [value])
        assertNoTokenFilter(fields, inner);
    }
  }
}

/** Writes are stored as given; only filters on token columns are refused. */
function guardTokenArgs(fields: readonly string[], args: Record<string, unknown>) {
  assertNoTokenFilter(fields, args.where);
  return args;
}

const tokenQueries = Object.fromEntries(
  Object.entries(TOKEN_FIELDS).map(([model, fields]) => [
    model,
    {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async $allOperations({ args, query }: { args: any; query: (args: any) => Promise<unknown> }) {
        return query(args && typeof args === 'object' ? guardTokenArgs(fields, args) : args);
      },
    },
  ])
);

const tokenResults = Object.fromEntries(
  Object.entries(TOKEN_FIELDS).map(([model, fields]) => [
    model,
    Object.fromEntries(
      fields.map(field => [
        field,
        {
          needs: { [field]: true },
          compute: (row: Record<string, string | null>) => decryptToken(row[field]),
        },
      ])
    ),
  ])
);

function createPrismaClient() {
  const basePrisma = new PrismaClient();

  // Prisma's $extends type system doesn't fully support relation fields in `needs`
  // under strict mode. These computed fields work correctly at runtime.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (basePrisma.$extends as any)({
    // Token filters refused (see above); `enc1:` values decrypted on read below.
    query: tokenQueries,
    result: {
      ...tokenResults,
      user: {
        avatar_url: {
          needs: { image: true },
          compute(user: { image: string | null }) {
            return user.image || DEFAULT_AVATAR_URL;
          },
        },
      },
      team: {
        avatar_url: {
          needs: { provider_id: true, provider: true },
          compute(team: { provider_id: string | null; provider: string | null }) {
            // Only Github team avatars can be built from an id; a Gitlab
            // team (subgroup) gets none, and the UI shows its initial.
            if (team.provider === 'GITLAB') return null;
            if (!team.provider_id) {
              return 'https://cdn-icons-png.flaticon.com/512/25/25231.png';
            }
            return `https://avatars.githubusercontent.com/t/${team.provider_id}?s=116&v=4`;
          },
        },
      },
      gitOrganization: {
        avatar_url: {
          needs: { provider_id: true, provider: true },
          compute(gitOrg: { provider_id: string; provider: string }) {
            // Only Github org avatars can be built from an id.
            if (gitOrg.provider !== 'GITHUB') return null;
            return `https://avatars.githubusercontent.com/u/${gitOrg.provider_id}?v=4`;
          },
        },
      },
      classroom: {
        num_students: {
          needs: { memberships: true },
          compute(classroom: { memberships: { role: string }[] }) {
            return classroom.memberships.filter(membership => membership.role === 'STUDENT').length;
          },
        },
        num_staff: {
          needs: { memberships: true },
          compute(classroom: { memberships: { role: string }[] }) {
            return classroom.memberships.filter(membership => membership.role !== 'STUDENT').length;
          },
        },
      },
      gitRepoAssignment: {
        extension_hours: {
          needs: { token_transactions: true },
          compute(repoAssignment: { token_transactions: TokenTransaction[] }) {
            return calculateExtensionHours(repoAssignment.token_transactions);
          },
        },
        num_late_hours: {
          needs: { assignment: true, token_transactions: true, closed_at: true },
          compute(repoAssignment: {
            assignment: { student_deadline: Date };
            token_transactions: TokenTransaction[];
            closed_at: Date | null;
          }) {
            return calculateLateHours(
              repoAssignment.closed_at,
              repoAssignment.assignment.student_deadline,
              repoAssignment.token_transactions
            );
          },
        },
        is_late: {
          needs: {
            assignment: true,
            closed_at: true,
            is_late_override: true,
            token_transactions: true,
          },
          compute(repoAssignment: {
            assignment: { student_deadline?: Date };
            closed_at: Date | null;
            is_late_override: boolean;
            token_transactions: TokenTransaction[];
          }) {
            if (repoAssignment.is_late_override) return false;

            const studentDeadline = dayjs(repoAssignment.assignment?.student_deadline);

            if (!studentDeadline.isValid()) return false;
            // Not submitted yet: late once the deadline, plus any hours bought
            // (they can be bought ahead of it), has passed.
            if (!repoAssignment.closed_at) {
              return dayjs().isAfter(
                extendedDeadline(studentDeadline, repoAssignment.token_transactions)
              );
            }

            return (
              calculateLateHours(
                repoAssignment.closed_at,
                studentDeadline,
                repoAssignment.token_transactions
              ) > 0
            );
          },
        },
        should_be_zero: {
          needs: {
            assignment: true,
            closed_at: true,
            grades: true,
            status: true,
            is_late_override: true,
          },
          compute(repoAssignment: {
            assignment: { student_deadline?: Date };
            closed_at: Date | null;
            grades: unknown[];
            status: string;
            is_late_override: boolean;
            token_transactions?: TokenTransaction[];
          }) {
            // Hours bought with tokens push the deadline out, so missing work
            // is not a zero inside that window. `token_transactions` is read
            // when the query loaded it and is deliberately not in `needs`: a
            // query without it still gets this field, on the plain deadline.
            const hasDeadlinePassed = extendedDeadline(
              repoAssignment.assignment?.student_deadline,
              repoAssignment.token_transactions
            ).isBefore(dayjs());
            const isOpen = repoAssignment.status === 'OPEN';
            return (
              hasDeadlinePassed &&
              isOpen &&
              !repoAssignment.is_late_override &&
              repoAssignment.grades.length === 0
            );
          },
        },
      },
    },
  }) as PrismaClient;
}

let _prisma: PrismaClient | null = null;

const disconnectPrisma = async () => {
  if (_prisma) {
    await _prisma.$disconnect();
  }
};

if (typeof window === 'undefined') {
  _prisma = createPrismaClient();

  const gracefulShutdown = async (signal: string) => {
    console.log(`Received ${signal}. Closing Prisma connection...`);
    await disconnectPrisma();
    // eslint-disable-next-line no-process-exit
    process.exit(0);
  };

  process.on('SIGINT', gracefulShutdown);
  process.on('SIGTERM', gracefulShutdown);
  process.on('beforeExit', async () => {
    await disconnectPrisma();
  });

  // Crash handlers must (a) never re-enter if cleanup itself rejects and
  // (b) always exit even if the Prisma disconnect hangs. A bare
  // `async () => { await disconnectPrisma(); process.exit(1); }` violated both:
  // a rejected disconnect spawned a fresh unhandledRejection that re-entered
  // this handler, and a hung disconnect blocked the exit entirely.
  const shutdownWithFailure = createOneShotShutdown(
    disconnectPrisma,
    // eslint-disable-next-line no-process-exit
    code => process.exit(code),
    { timeoutMs: 5000 }
  );

  process.on('uncaughtException', (error: Error) => {
    console.error('Uncaught Exception:', error);
    shutdownWithFailure(1);
  });

  process.on('unhandledRejection', (reason: unknown, promise: Promise<unknown>) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
    shutdownWithFailure(1);
  });
}

export function getPrisma(): PrismaClient {
  if (!_prisma)
    throw new Error(
      '[database] Prisma client accessed before initialization. Ensure the server has initialized before calling getPrisma().'
    );
  return _prisma;
}

export default getPrisma;
