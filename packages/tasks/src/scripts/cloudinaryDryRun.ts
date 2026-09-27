/**
 * Cloudinary → media migration: DRY RUN, as a local read-only script.
 *
 * Runs `planMigration` with live READ deps and prints the plan as JSON on
 * stdout (progress goes to stderr). It cannot migrate anything: it does not
 * import the execute module, and a test fails the build if it ever does.
 *
 * Safety, in order:
 *   - refuses to start without `CLASSMOJI_DRY_RUN_ACK=read-only`;
 *   - opens its OWN Prisma client on `DATABASE_URL_UNPOOLED` (the direct
 *     endpoint) with `connection_limit=1`, then sets the session read-only and
 *     checks `SHOW transaction_read_only` = on before any other query, and
 *     again before printing the plan;
 *   - imports neither `@classmoji/database` nor `@classmoji/services` (their
 *     import creates a client from `DATABASE_URL`), and points `DATABASE_URL`
 *     at an unresolvable host so anything that tried would fail rather than
 *     reach a database;
 *   - GitHub: installation tokens minted with `contents: read` only; every
 *     repo call is a GET. Cloudinary: Admin API list (GET) only.
 *   - prints the database HOST it connected to, never the URL.
 *
 * Usage (from the repo root; `npx tsx …` works the same):
 *   CLASSMOJI_DRY_RUN_ACK=read-only infisical run --env=prod -- \
 *     node --experimental-strip-types --no-warnings \
 *     packages/tasks/src/scripts/cloudinaryDryRun.ts [--limit N] > plan.json
 *
 * Env: DATABASE_URL_UNPOOLED, CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY,
 * CLOUDINARY_API_SECRET, GITHUB_APP_ID, GITHUB_PRIVATE_KEY_BASE64,
 * CLASSMOJI_DRY_RUN_ACK=read-only.
 */

import { PrismaClient } from '@prisma/client';

import { planMigration } from '../helpers/cloudinaryPlan.ts';
import {
  cloudinaryCredentialsFromEnv,
  createLiveReadDeps,
  gitHubAppCredentialsFromEnv,
  type ReadPrisma,
} from '../helpers/cloudinaryReads.ts';
import {
  assertReadOnly,
  enforceReadOnlySession,
  requireReadOnlyAck,
  singleConnectionUrl,
} from '../helpers/readOnlyPrisma.ts';

/** Where `DATABASE_URL` points during the run: nowhere. */
const NO_GLOBAL_CLIENT = 'postgresql://no-global-client.invalid:5432/none';

function parseLimit(argv: string[]): number | undefined {
  const at = argv.indexOf('--limit');
  const raw = at !== -1 ? argv[at + 1] : argv.find(arg => arg.startsWith('--limit='))?.slice(8);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) throw new Error('--limit must be a positive integer');
  return value;
}

async function main(): Promise<void> {
  requireReadOnlyAck(process.env);
  const limit = parseLimit(process.argv.slice(2));
  const cloudinary = cloudinaryCredentialsFromEnv(process.env);
  const github = gitHubAppCredentialsFromEnv(process.env);
  const { url, host } = singleConnectionUrl(process.env.DATABASE_URL_UNPOOLED);
  process.env.DATABASE_URL = NO_GLOBAL_CLIENT;

  const prisma = new PrismaClient({ datasourceUrl: url });
  await enforceReadOnlySession(prisma);
  console.error(`[cloudinary-dry-run] connected read-only to ${host}`);

  const deps = createLiveReadDeps({
    prisma: prisma as unknown as ReadPrisma,
    cloudinary,
    github,
    log: (message, detail) =>
      console.error(`[cloudinary-dry-run] ${message}`, detail ? JSON.stringify(detail) : ''),
  });
  const plan = await planMigration(deps, limit === undefined ? {} : { limit });

  await assertReadOnly(prisma);
  process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
  console.error(`[cloudinary-dry-run] totals ${JSON.stringify(plan.totals)}`);
  await prisma.$disconnect();
}

main().catch(error => {
  console.error(`[cloudinary-dry-run] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
