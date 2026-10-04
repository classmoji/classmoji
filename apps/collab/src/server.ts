import { Server } from '@hocuspocus/server';

import { handleRequest } from './http.ts';

export const DEFAULT_COLLAB_PORT = 7700;

export interface CollabServerOptions {
  port?: number;
  /** Register SIGINT/SIGTERM handlers that flush pending stores and exit. */
  stopOnSignals?: boolean;
  quiet?: boolean;
}

/** The port from COLLAB_PORT, else the default. */
export function collabPort(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.COLLAB_PORT;
  const port = raw ? Number(raw) : DEFAULT_COLLAB_PORT;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`COLLAB_PORT must be a TCP port, got ${JSON.stringify(raw)}`);
  }
  return port;
}

/**
 * The Hocuspocus server, not yet listening. No authentication and no
 * persistence yet: slice A adds onAuthenticate, the Database extension and
 * the internal API.
 *
 * `stopOnSignals` (default on) makes Hocuspocus destroy the server on
 * SIGINT/SIGTERM, which flushes pending debounced stores before exiting.
 */
export function createCollabServer(options: CollabServerOptions = {}): Server {
  return new Server({
    name: 'classmoji-collab',
    port: options.port ?? collabPort(),
    stopOnSignals: options.stopOnSignals ?? true,
    quiet: options.quiet ?? false,
    onRequest: handleRequest,
  });
}
