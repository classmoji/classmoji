/**
 * The server entry: React Router's default on Node (Fly), web streams on
 * Cloudflare Workers (the `workerd` condition). See
 * packages/workers/src/entry-server.*.tsx.
 */
export { default, streamTimeout } from '@classmoji/workers/entry-server';
