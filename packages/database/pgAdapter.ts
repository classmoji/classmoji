/**
 * The Postgres driver adapter Workers builds give Prisma per request
 * (`createWorkerHandler` in @classmoji/workers/runtime, over Hyperdrive).
 * Re-exported here so the database package owns its driver versions. Node
 * services never import this: their client uses Prisma's own engine.
 */
export { PrismaPg } from '@prisma/adapter-pg';
