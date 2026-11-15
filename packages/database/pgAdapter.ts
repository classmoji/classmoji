/**
 * The Postgres driver adapter Workers builds give Prisma per request
 * (`createWorkerHandler` in @classmoji/workers/runtime, over Hyperdrive).
 * Re-exported here so the database package owns its driver versions. Node
 * code does not use this: its clients are built by pgClient.ts
 * (`@classmoji/database/pg-client`), which reads the pool settings from the
 * database URL. Hyperdrive URLs carry none of them.
 */
export { PrismaPg } from '@prisma/adapter-pg';
