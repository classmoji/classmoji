/**
 * Server-side Sentry, started before anything else is loaded: src/index.ts
 * imports this module first, so the SDK is set up before Fastify is created.
 * The env is already in place (Fly sets it; `npm run mcp:dev` loads `.env`
 * through dotenv before Node starts). Off, with no output and nothing
 * registered, when `SENTRY_DSN` is unset.
 */
import { initServerSentry } from '@classmoji/utils/sentry-node';

initServerSentry('mcp');
