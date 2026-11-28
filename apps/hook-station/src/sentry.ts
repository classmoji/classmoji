/**
 * Server-side error tracking, started before anything else is imported (the
 * entry imports this file first). Off without `SENTRY_DSN`. The env is in
 * `process.env` already: the root scripts load `.env` before node starts, and
 * Fly sets it in production.
 */
import { initServerSentry } from '@classmoji/utils/sentry-node';

initServerSentry('hook-station');
