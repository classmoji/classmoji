/**
 * Real Prisma error objects, for tests of code that classifies them.
 *
 * Captured against a throwaway Postgres (pgvector/pg16) by triggering each
 * failure through the client of that version, then serialized: every own
 * property plus `name` and `message`, with host, port, user and database
 * names redacted.
 * - 6.19.3: `prisma-client-js` on the Rust query engine (today's client).
 * - 7.10.1: `prisma-client-js` on `@prisma/adapter-pg` (node-postgres), the
 *   client after the Prisma 7 upgrade.
 *
 * Keys: `p2002_<constraint>` (one per unique index a call site checks for),
 * `p2003_fk`, `unreachable`, `wrong_password`, `missing_database`,
 * `pool_timeout` (every pooled connection busy past the wait), and the
 * server ending a session (`killed_*`). A case that raised nothing on that
 * version is `{ noError: true }` (7.10.1's pool replaces a connection that
 * died while idle; only a query racing the death fails,
 * `killed_idle_model_query_no_wait`).
 *
 * Classifiers read them as plain objects, as they read real errors (by
 * `name`, `code`, `meta` and `message`, never `instanceof`).
 */
import { readFile } from 'node:fs/promises';

export type CapturedPrismaError = {
  name?: string;
  message?: string;
  code?: string;
  meta?: Record<string, unknown> | null;
  clientVersion?: string;
  noError?: true;
  [key: string]: unknown;
};

export type CapturedErrors = { prisma: string } & Record<string, CapturedPrismaError>;

const load = async (version: string): Promise<CapturedErrors> =>
  JSON.parse(await readFile(new URL(`./prisma-errors-${version}.json`, import.meta.url), 'utf8'));

export const PRISMA_6_ERRORS = await load('6.19.3');
export const PRISMA_7_ERRORS = await load('7.10.1');
