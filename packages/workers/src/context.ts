/**
 * The Worker's bindings and execution context, as React Router load context.
 *
 * React Router 8 hands loaders a `RouterContextProvider`, read by key:
 * `context.get(cloudflareContext)`. createWorkerHandler (./runtime.ts) sets it
 * for every request; anywhere else (the Fly/Node server) it is null.
 *
 * Its own module, with no runtime import besides `react-router`, so a route
 * that reads it does not pull the database glue in runtime.ts into a Node build.
 */
import { createContext } from 'react-router';
import type { ClassmojiWorkerEnv, WorkerExecutionContext } from './runtime.ts';

export interface CloudflareContext<Env = ClassmojiWorkerEnv> {
  env: Env;
  ctx: WorkerExecutionContext;
}

export const cloudflareContext = createContext<CloudflareContext | null>(null);
